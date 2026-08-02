import { describe, expect, it } from "vitest";
import { applyExclusions } from "./exclusions.js";
import type { AssignmentRecord } from "./state.js";

function rec(
  i: number,
  srcHash: string | null,
  overrides: Partial<AssignmentRecord> = {}
): AssignmentRecord {
  return {
    armIndex: i % 2,
    ctxKey: null,
    featIdx: [0],
    rewardTotal: 0,
    firstSeen: 1_700_000_000_000 + i,
    alg: "ts",
    armCount: 2,
    dim: 16,
    srcHash,
    ...overrides
  };
}

describe("applyExclusions", () => {
  it("keeps everything when the creator has excluded nothing", () => {
    // Nothing is ever dropped automatically. Source buckets are address
    // prefixes and mail providers fetch email images through their own
    // infrastructure, so a real campaign's opens legitimately share a few
    // prefixes: any automatic rule would discard most of a genuine send.
    const events = Array.from({ length: 500 }, (_, i) => rec(i, "one-proxy"));
    const result = applyExclusions(events);
    expect(result.applied).toHaveLength(500);
    expect(result.excluded.total).toBe(0);
  });

  it("removes a quarantined source", () => {
    const events = [rec(0, "good"), rec(1, "bad"), rec(2, "good")];
    const result = applyExclusions(events, { excludedSources: ["bad"] });
    expect(result.applied).toHaveLength(2);
    expect(result.excluded).toEqual({ total: 1, bySource: 1, byWindow: 0 });
  });

  it("removes a quarantined time window, inclusive of its bounds", () => {
    const events = [
      rec(0, "a", { firstSeen: 4_000 }),
      rec(1, "a", { firstSeen: 4_500 }),
      rec(2, "a", { firstSeen: 5_500 }),
      rec(3, "a", { firstSeen: 6_000 })
    ];
    const result = applyExclusions(events, {
      excludedWindows: [{ since: 4_500, until: 5_500 }]
    });
    expect(result.applied.map(r => r.firstSeen)).toEqual([4_000, 6_000]);
    expect(result.excluded.byWindow).toBe(2);
  });

  it("reports the per-source breakdown the creator quarantines from", () => {
    const result = applyExclusions([rec(0, "a"), rec(1, "a"), rec(2, "b")]);
    expect(result.perSource).toEqual({ a: 2, b: 1 });
  });

  it("groups records with no source under one label without dropping them", () => {
    const result = applyExclusions([rec(0, null), rec(1, null)]);
    expect(result.perSource).toEqual({ unknown: 2 });
    expect(result.applied).toHaveLength(2);
  });

  it("is deterministic regardless of input order", () => {
    // Recompute must be reproducible: derived state is a function of the
    // log, so the same log has to yield the same state every time.
    const events = Array.from({ length: 20 }, (_, i) => rec(i, "one"));
    const a = applyExclusions(events, { excludedSources: [] });
    const b = applyExclusions([...events].reverse(), { excludedSources: [] });
    expect(a.applied.map(r => r.firstSeen)).toEqual(
      b.applied.map(r => r.firstSeen)
    );
  });
});
