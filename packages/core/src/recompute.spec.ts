import { describe, expect, it } from "vitest";
import {
  applyAssignment,
  applyFirstReward,
  newDerivedState,
  recomputeState,
  type AssignmentRecord,
  type StateInit
} from "./state.js";
import { featureIndices } from "./context.js";
import { mulberry32 } from "./rng.js";

/**
 * The event log is the source of truth; the incrementally-maintained
 * derived state must always equal a from-scratch recompute. This is what
 * makes mid-test algorithm changes safe.
 */

function randomEvents(count: number, seed: number): AssignmentRecord[] {
  const rng = mulberry32(seed);
  const contexts = [null, { device: "mobile" }, { device: "desktop" }];
  const events: AssignmentRecord[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = contexts[Math.floor(rng() * contexts.length)];
    events.push({
      armIndex: Math.floor(rng() * 3),
      ctxKey: ctx ? JSON.stringify(ctx) : null,
      featIdx: featureIndices(ctx),
      rewardTotal: rng() < 0.3 ? 1 + Math.floor(rng() * 3) : 0,
      firstSeen: 1_700_000_000_000 + i
    });
  }
  return events;
}

/**
 * Replays events the way production does: assignment applied at pull time,
 * reward applied later (interleaved), vs recompute's ordered replay.
 */
function incremental(events: AssignmentRecord[], init: StateInit) {
  const state = newDerivedState(init);
  for (const rec of events) {
    applyAssignment(state, rec);
  }
  // Rewards arrive delayed and in a different order than assignments.
  for (const rec of [...events].reverse()) {
    if (rec.rewardTotal > 0) {
      applyFirstReward(state, rec);
    }
  }
  return state;
}

function expectClose(a: unknown, b: unknown): void {
  // Counter states compare exactly; linear states within float tolerance.
  expect(JSON.parse(JSON.stringify(a))).toEqual(
    roundDeep(JSON.parse(JSON.stringify(b)))
  );

  function roundDeep(value: unknown): unknown {
    if (typeof value === "number") {
      return expect.closeTo(value, 9) as unknown;
    }
    if (Array.isArray(value)) {
      return value.map(roundDeep);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, roundDeep(v)])
      );
    }
    return value;
  }
}

describe("recompute equivalence", () => {
  const events = randomEvents(500, 5);

  it.each(["ts", "bucketed", "linear"] as const)(
    "incremental %s state equals recomputed state",
    alg => {
      const init: StateInit = { alg, armCount: 3 };
      expectClose(incremental(events, init), recomputeState(events, init));
    }
  );

  it("switching algorithm mid-test equals having run it all along", () => {
    // Start on ts, record events, switch to linear: the recomputed linear
    // state must match a linear test that saw the same events from day one.
    const init: StateInit = { alg: "linear", armCount: 3 };
    const switched = recomputeState(events, init);
    const allAlong = incremental(events, init);
    expectClose(switched, allAlong);
  });

  it("is insensitive to event iteration order", () => {
    const shuffled = [...events].sort(() => 0.5 - Math.random());
    const init: StateInit = { alg: "ts", armCount: 3 };
    expectClose(recomputeState(events, init), recomputeState(shuffled, init));
  });
});
