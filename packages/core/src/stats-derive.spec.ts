import { describe, expect, it } from "vitest";

import { analyzeOutcomes } from "./decide.js";
import { decisionLine, summarizeBuckets } from "./stats-derive.js";
import type { TestStats } from "./stats.js";

/**
 * The two reporting rules the statistical audit asked for. Both are about what
 * the dashboard SAYS, not about what the bandit serves, and both were written
 * against measured failure rates rather than intuition: a tie is announced as a
 * leader in roughly half of null runs, and a thin segment claims a winner in
 * more than half of 8x2 null runs.
 */
function statsFor(
  combinations: Array<{ choice: string[]; pulls: number; conversions: number }>,
  buckets: TestStats["buckets"] = {}
): TestStats {
  return {
    testId: "t",
    totalAssignments: combinations.reduce((sum, c) => sum + c.pulls, 0),
    combinations: combinations.map((c, cell) => ({
      cell,
      choice: c.choice,
      pulls: c.pulls,
      conversions: c.conversions,
      rewardTotal: c.conversions,
      conversionRate: c.pulls > 0 ? c.conversions / c.pulls : null
    })),
    slots: {},
    buckets,
    excluded: { total: 0, bySource: 0, byWindow: 0 },
    perSource: {},
    signals: {}
  } as unknown as TestStats;
}

describe("decisionLine", () => {
  it("reports a tie instead of naming one of two equal arms", () => {
    // Identical outcomes: there is no leader to find, and the old wording
    // named one anyway because expected loss is legitimately tiny.
    const stats = statsFor([
      { choice: ["a"], pulls: 4000, conversions: 200 },
      { choice: ["b"], pulls: 4000, conversions: 200 }
    ]);
    const line = decisionLine(stats, analyzeOutcomes(toArms(stats)));
    expect(line).toContain("No difference detected");
    expect(line).toContain("a");
    expect(line).toContain("b");
    expect(line).not.toContain("leads");
  });

  it("says too early before it says tie, on a test nobody has seen yet", () => {
    // Three pulls each: the posteriors overlap because there is no evidence,
    // not because the arms were measured and found equal. Reporting a tie here
    // would tell someone either option is safe to ship on three visitors.
    const stats = statsFor([
      { choice: ["a"], pulls: 3, conversions: 1 },
      { choice: ["b"], pulls: 3, conversions: 1 }
    ]);
    const line = decisionLine(stats, analyzeOutcomes(toArms(stats)));
    expect(line).toContain("too early");
    expect(line).not.toContain("safe to ship");
  });

  it("still names a leader when one arm is genuinely ahead", () => {
    const stats = statsFor([
      { choice: ["a"], pulls: 4000, conversions: 200 },
      { choice: ["b"], pulls: 4000, conversions: 400 }
    ]);
    const line = decisionLine(stats, analyzeOutcomes(toArms(stats)));
    expect(line).toContain("b leads");
  });

  it("no longer promises a bound that continuous monitoring breaks", () => {
    const stats = statsFor([
      { choice: ["a"], pulls: 4000, conversions: 200 },
      { choice: ["b"], pulls: 4000, conversions: 400 }
    ]);
    const line = decisionLine(stats, analyzeOutcomes(toArms(stats)));
    // The measured realized regret in the small-lift case was 2.59%, so the
    // old "under 1% of its rate" was a promise the product could not keep.
    expect(line).not.toContain("1%");
  });
});

describe("summarizeBuckets", () => {
  const combos = [
    { choice: ["a"], pulls: 0, conversions: 0 },
    { choice: ["b"], pulls: 0, conversions: 0 }
  ];

  it("withholds a leader from a bucket nobody has seen enough of", () => {
    const { top } = summarizeBuckets(
      statsFor(combos, {
        thin: { pulls: [40, 40], conversions: [1, 8], label: "segment=thin" }
      })
    );
    expect(top).toHaveLength(1);
    // The counts still show: a thin segment is worth seeing.
    expect(top[0].pulls).toBe(80);
    expect(top[0].conversions).toBe(9);
    // The claim does not.
    expect(top[0].leader).toBeNull();
    expect(top[0].probabilityBest).toBeNull();
    expect(top[0].leaderRate).toBeNull();
  });

  it("names a leader once the bucket has the exposure for it", () => {
    const { top } = summarizeBuckets(
      statsFor(combos, {
        fat: { pulls: [500, 500], conversions: [25, 100], label: "segment=fat" }
      })
    );
    expect(top[0].leader).toBe("b");
    expect(top[0].probabilityBest).toBeGreaterThan(0.9);
  });
});

function toArms(stats: TestStats) {
  return stats.combinations.map(c => ({
    pulls: c.pulls,
    conversions: c.conversions
  }));
}
