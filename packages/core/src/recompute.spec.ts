import { describe, expect, it } from "vitest";
import { mulberry32 } from "./rng.js";
import {
  applyAssignment,
  applyFirstReward,
  choose,
  newDerivedState,
  recomputeState,
  type AssignmentRecord
} from "./state.js";
import { dimForShape } from "./model.js";

/**
 * The event-sourcing guarantee: incrementally maintained derived state
 * equals a full replay of the records, and a replay survives anything a
 * hostile or stale writer could have put in the log.
 */
function record(partial: Partial<AssignmentRecord>): AssignmentRecord {
  return {
    cell: 0,
    slotSizes: [2, 2],
    dim: 32,
    featIdx: [0],
    ctxKey: null,
    rewardTotal: 0,
    firstSeen: 0,
    ...partial
  };
}

describe("recompute equivalence", () => {
  it("replay equals the incrementally maintained state", () => {
    const init = { slotSizes: [2, 2], dim: dimForShape([2, 2]) };
    const incremental = newDerivedState(init);
    const rng = mulberry32(5);
    const events: AssignmentRecord[] = [];
    for (let t = 0; t < 200; t++) {
      const { cell, featIdx } = choose(incremental, [], rng);
      const rewarded = rng() < 0.1;
      const rec = record({
        cell,
        featIdx,
        dim: init.dim,
        rewardTotal: rewarded ? 1 : 0,
        firstSeen: t
      });
      events.push(rec);
      applyAssignment(incremental, rec);
      if (rewarded) {
        applyFirstReward(incremental, rec);
      }
    }
    // Shuffled input replays identically: order comes from firstSeen.
    const shuffled = [...events].reverse();
    expect(recomputeState(shuffled, init)).toEqual(incremental);
  });

  it("skips records that do not fit the current shape", () => {
    // Records are written against a public testId; replay is the repair
    // path and has to survive anything already in the log.
    const init = { slotSizes: [2, 2], dim: 32 };
    const state = recomputeState(
      [
        record({ cell: 1, firstSeen: 1 }),
        record({ cell: 99, firstSeen: 2 }), // out of range
        record({ cell: 1.5, firstSeen: 3 }), // not an index
        record({ cell: 1, slotSizes: [3, 3], firstSeen: 4 }), // wrong shape
        record({ cell: 2, featIdx: [9999, -1], firstSeen: 5 }) // wild features
      ],
      init
    );
    expect(state.cells[1].pulls).toBe(1);
    // The wild-feature record still counts, with its features clamped.
    expect(state.cells[2].pulls).toBe(1);
    expect(state.cells.reduce((sum, c) => sum + c.pulls, 0)).toBe(2);
    // And nothing poisoned the model.
    expect(state.model.b.every(Number.isFinite)).toBe(true);
    expect(state.model.aInv.flat().every(Number.isFinite)).toBe(true);
  });
});
