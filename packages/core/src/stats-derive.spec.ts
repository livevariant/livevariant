import { describe, expect, it } from "vitest";

import { analyzeOutcomes } from "./decide.js";
import { mulberry32 } from "./rng.js";
import {
  analyzeSlots,
  decisionLine,
  summarizeBuckets
} from "./stats-derive.js";
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

describe("thin exposure", () => {
  it("marks a starved variant, because its reported rate reads low", () => {
    // Measured at 5% vs 10%: the losing arm's rate came out 10.8% below its
    // own true value while the winner's was unbiased. The bandit is right to
    // starve it; the dashboard is wrong to present the result as a
    // measurement.
    const [slot] = analyzeSlots(
      statsWithSlot([
        { name: "a", pulls: 1400, conversions: 140 },
        { name: "b", pulls: 60, conversions: 2 }
      ])
    );
    expect(slot.variants[0].thinExposure).toBe(false);
    expect(slot.variants[1].thinExposure).toBe(true);
  });

  it("does not mark a variant that is merely behind", () => {
    const [slot] = analyzeSlots(
      statsWithSlot([
        { name: "a", pulls: 800, conversions: 80 },
        { name: "b", pulls: 700, conversions: 40 }
      ])
    );
    expect(slot.variants.every(v => !v.thinExposure)).toBe(true);
  });

  it("calls an empty slot empty rather than thin", () => {
    const [slot] = analyzeSlots(
      statsWithSlot([
        { name: "a", pulls: 0, conversions: 0 },
        { name: "b", pulls: 0, conversions: 0 }
      ])
    );
    expect(slot.variants.every(v => !v.thinExposure)).toBe(true);
  });
});

function statsWithSlot(
  variants: Array<{ name: string; pulls: number; conversions: number }>
): TestStats {
  return {
    ...statsFor(variants.map(v => ({ choice: [v.name], ...v }))),
    slots: {
      hero: variants.map(v => ({
        ...v,
        rewardTotal: v.conversions,
        conversionRate: v.pulls > 0 ? v.conversions / v.pulls : null
      }))
    }
  } as unknown as TestStats;
}

describe("partial pooling earns its constant", () => {
  /**
   * The measurement that justifies BUCKET_POOLING_STRENGTH, run as a test so
   * the constant cannot silently stop earning it. Everything is seeded, so
   * these are exact replays, not flaky statistics.
   */
  const ARMS = 2;
  const BUCKETS = 8;
  const PER_ARM = 150; // 300 per bucket: past the exposure gate on purpose.
  const RATE = 0.05;

  function binomial(n: number, p: number, rng: () => number): number {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      if (rng() < p) hits++;
    }
    return hits;
  }

  function nullStats(seed: number): TestStats {
    const rng = mulberry32(seed);
    const buckets: TestStats["buckets"] = {};
    const global = Array.from({ length: ARMS }, () => ({
      pulls: 0,
      conversions: 0
    }));
    for (let b = 0; b < BUCKETS; b++) {
      const pulls: number[] = [];
      const conversions: number[] = [];
      for (let arm = 0; arm < ARMS; arm++) {
        const conv = binomial(PER_ARM, RATE, rng);
        pulls.push(PER_ARM);
        conversions.push(conv);
        global[arm].pulls += PER_ARM;
        global[arm].conversions += conv;
      }
      buckets[`seg${b}`] = { pulls, conversions, label: `segment=${b}` };
    }
    return statsFor(
      global.map((g, i) => ({ choice: [i === 0 ? "a" : "b"], ...g })),
      buckets
    );
  }

  it("stops buckets from inventing a different winner than the test's", () => {
    // The metric matters here, and getting it wrong the first time taught us
    // the mechanism. Pooling cannot stop a bucket AGREEING with the global
    // result when the global result itself is a null-run wobble: at high
    // strength every bucket converges to the global posterior, so those
    // echoes converge to the global error rate, which the tie wording owns.
    // What pooling kills is the segmentation illusion: a confident bucket
    // leader that CONTRADICTS the global one, which is "a different winner
    // per audience" claimed out of noise.
    const REPS = 40;
    let pooledDisagree = 0;
    let unpooledDisagree = 0;
    for (let rep = 0; rep < REPS; rep++) {
      const stats = nullStats(1000 + rep);
      const globalLeader =
        (stats.combinations[1]?.conversions ?? 0) >
        (stats.combinations[0]?.conversions ?? 0)
          ? "b"
          : "a";
      const { top } = summarizeBuckets(stats, BUCKETS);
      if (
        top.some(
          bucket =>
            (bucket.probabilityBest ?? 0) >= 0.95 &&
            bucket.leader !== null &&
            bucket.leader !== globalLeader
        )
      ) {
        pooledDisagree++;
      }
      // The old code's behaviour on the same data: a fresh flat-prior
      // analysis per bucket. The baseline the constant is measured against.
      const anyUnpooled = Object.values(stats.buckets).some(bucket => {
        const arms = bucket.pulls.map((pulls, i) => ({
          pulls,
          conversions: bucket.conversions[i] ?? 0
        }));
        const analysis = analyzeOutcomes(arms, { draws: 4000 });
        const leader = analysis.leader === 0 ? "a" : "b";
        return (
          (analysis.probabilities[analysis.leader] ?? 0) >= 0.95 &&
          leader !== globalLeader
        );
      });
      if (anyUnpooled) unpooledDisagree++;
    }
    // Measured on exactly these seeds: 0.175 unpooled, 0 pooled. Margins so
    // a sampler tweak does not flap the suite.
    expect(unpooledDisagree / REPS).toBeGreaterThan(0.1);
    expect(pooledDisagree / REPS).toBeLessThanOrEqual(0.05);
  });

  it("still surfaces a winner that genuinely REVERSES against the global lean", () => {
    // The hardest real case: variant a wins this segment 12% to 5% while the
    // global is dead even (so the prior offers a no help either way, and at
    // strength 200 it drags both arms toward 6.7%). 300 pulls a side must
    // overpower that, or pooling would be suppressing exactly the
    // interactions the product exists to find.
    const buckets: TestStats["buckets"] = {
      real: { pulls: [300, 300], conversions: [36, 15], label: "segment=real" },
      null0: {
        pulls: [300, 300],
        conversions: [15, 22],
        label: "segment=null0"
      },
      null1: {
        pulls: [300, 300],
        conversions: [15, 22],
        label: "segment=null1"
      },
      null2: {
        pulls: [300, 300],
        conversions: [15, 22],
        label: "segment=null2"
      }
    };
    const stats = statsFor(
      [
        { choice: ["a"], pulls: 1200, conversions: 81 },
        { choice: ["b"], pulls: 1200, conversions: 81 }
      ],
      buckets
    );
    const { top } = summarizeBuckets(stats, 4);
    const real = top.find(b => b.name === "segment=real");
    expect(real?.leader).toBe("a");
    expect(real?.probabilityBest ?? 0).toBeGreaterThan(0.9);
    // The pooled estimate sits between the bucket's raw ratio (0.12) and the
    // global rate (~0.0675): that is what "shrunk toward" means.
    expect(real?.leaderRate ?? 0).toBeGreaterThan(0.0675);
    expect(real?.leaderRate ?? 0).toBeLessThan(0.12);
  });
});
