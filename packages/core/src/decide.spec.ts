import { describe, expect, it } from "vitest";
import { analyzeOutcomes, marginalOutcomes } from "./decide.js";
import { mulberry32 } from "./rng.js";

describe("analyzeOutcomes", () => {
  it("splits the odds evenly when the arms are indistinguishable", () => {
    const a = analyzeOutcomes([
      { pulls: 1000, conversions: 100 },
      { pulls: 1000, conversions: 100 }
    ]);
    expect(a.probabilities[0]).toBeCloseTo(0.5, 1);
    expect(a.probabilities[1]).toBeCloseTo(0.5, 1);
    // Identical arms are the case where stopping is most tempting and
    // least justified: either choice still costs whatever the real gap is.
    expect(a.canStop).toBe(false);
  });

  it("is nearly certain when the gap is large and the data deep", () => {
    const a = analyzeOutcomes([
      { pulls: 5000, conversions: 250 }, // 5%
      { pulls: 5000, conversions: 400 } // 8%
    ]);
    expect(a.leader).toBe(1);
    expect(a.probabilities[1]).toBeGreaterThan(0.99);
    expect(a.canStop).toBe(true);
    expect(a.relativeLoss).toBeLessThan(0.01);
  });

  it("refuses to call the same gap on thin data", () => {
    // The trap this pins: 1/10 vs 2/10 is the same ratio as the case
    // above and means nothing. Comparing the two rates by eye says
    // "B wins by 100%"; the posterior says it is close to a coin flip.
    const a = analyzeOutcomes([
      { pulls: 10, conversions: 1 },
      { pulls: 10, conversions: 2 }
    ]);
    expect(a.probabilities[1]).toBeLessThan(0.85);
    expect(a.canStop).toBe(false);
  });

  it("never calls a test that has barely run, however lopsided", () => {
    // 0/5 vs 5/5 makes the relative loss look negligible while the whole
    // test is five visitors.
    const a = analyzeOutcomes([
      { pulls: 5, conversions: 0 },
      { pulls: 5, conversions: 5 }
    ]);
    expect(a.leader).toBe(1);
    expect(a.canStop).toBe(false);
  });

  it("measures the loss against the arm it actually recommends", () => {
    // Expected loss is the regret of keeping the leader, so it can never
    // be negative and must fall as the evidence grows.
    const thin = analyzeOutcomes([
      { pulls: 100, conversions: 10 },
      { pulls: 100, conversions: 13 }
    ]);
    const deep = analyzeOutcomes([
      { pulls: 10000, conversions: 1000 },
      { pulls: 10000, conversions: 1300 }
    ]);
    expect(thin.expectedLoss).toBeGreaterThanOrEqual(0);
    expect(deep.expectedLoss).toBeLessThan(thin.expectedLoss);
  });

  it("handles arms nobody has seen yet", () => {
    const a = analyzeOutcomes([
      { pulls: 0, conversions: 0 },
      { pulls: 0, conversions: 0 }
    ]);
    expect(a.probabilities.reduce((s, p) => s + p, 0)).toBeCloseTo(1, 5);
    expect(a.canStop).toBe(false);
  });

  it("explains the same numbers the same way twice", () => {
    // An assistant asked to re-check its own reading must not contradict
    // itself, so the default draw is seeded.
    const arms = [
      { pulls: 400, conversions: 40 },
      { pulls: 400, conversions: 52 }
    ];
    expect(analyzeOutcomes(arms)).toEqual(analyzeOutcomes(arms));
    // An explicit rng still overrides it.
    const custom = analyzeOutcomes(arms, { rng: mulberry32(7), draws: 4000 });
    expect(custom.probabilities).toHaveLength(2);
  });

  it("copes with a third arm and with more conversions than pulls", () => {
    // rewardTotal can exceed pulls when a visitor converts more than once,
    // and stats feed straight in here, so this must not produce NaN.
    const a = analyzeOutcomes([
      { pulls: 300, conversions: 30 },
      { pulls: 300, conversions: 45 },
      { pulls: 300, conversions: 320 }
    ]);
    expect(a.leader).toBe(2);
    expect(a.probabilities.every(p => Number.isFinite(p))).toBe(true);
    expect(a.rates.every(r => r >= 0 && r <= 1)).toBe(true);
  });
});

describe("marginalOutcomes", () => {
  it("rolls cells up to one slot's variants", () => {
    // 2x2 shape: cells [hero, cta] in row-major order.
    const cells = [
      { pulls: 10, conversions: 1 }, // (0,0)
      { pulls: 20, conversions: 2 }, // (0,1)
      { pulls: 30, conversions: 6 }, // (1,0)
      { pulls: 40, conversions: 4 } // (1,1)
    ];
    expect(marginalOutcomes(cells, [2, 2], 0)).toEqual([
      { pulls: 30, conversions: 3 },
      { pulls: 70, conversions: 10 }
    ]);
    expect(marginalOutcomes(cells, [2, 2], 1)).toEqual([
      { pulls: 40, conversions: 7 },
      { pulls: 60, conversions: 6 }
    ]);
  });

  it("is the identity for a single slot", () => {
    const cells = [
      { pulls: 5, conversions: 1 },
      { pulls: 7, conversions: 2 }
    ];
    expect(marginalOutcomes(cells, [2], 0)).toEqual(cells);
  });
});
