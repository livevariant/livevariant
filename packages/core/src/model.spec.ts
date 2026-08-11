import { describe, expect, it, vi } from "vitest";
import { encodeCell } from "./cells.js";
import {
  ctxCardinality,
  dimForShape,
  MAX_DIM,
  observe,
  reward,
  wantedDimForShape
} from "./model.js";
import { mulberry32, type Rng } from "./rng.js";
import {
  choose,
  newDerivedState,
  type DerivedState,
  type StateInit
} from "./state.js";

/**
 * Simulations, because this is the file where the product's one claim has
 * to be earned: a single model (joint linear Thompson sampling) serves
 * plain A/B, contextual, and multi-slot tests well enough that nobody
 * ever chooses an algorithm.
 *
 * These run tens of thousands of Thompson draws. Deterministic, ~1s on a
 * laptop, but CI containers can be many times slower and the default 5s
 * per-test timeout has flaked there, so the budget is explicit.
 */
vi.setConfig({ testTimeout: 60_000 });

/** One simulated visitor: choose, observe, maybe reward. */
function play(
  state: DerivedState,
  ctx: number[],
  convertProbability: (cell: number) => number,
  rng: Rng
): { cell: number; converted: boolean } {
  const { cell, featIdx } = choose(state, ctx, rng);
  state.cells[cell].pulls += 1;
  observe(state.model, featIdx);
  const converted = rng() < convertProbability(cell);
  if (converted) {
    state.cells[cell].successes += 1;
    reward(state.model, featIdx);
  }
  return { cell, converted };
}

function fresh(init: Omit<StateInit, "dim"> & { dim?: number }): DerivedState {
  return newDerivedState({
    dim: init.dim ?? dimForShape(init.slotSizes),
    slotSizes: init.slotSizes,
    priors: init.priors
  });
}

describe("dimForShape", () => {
  it("scales with the shape and stays in bounds", () => {
    expect(dimForShape([2])).toBe(16);
    expect(dimForShape([3, 3])).toBeGreaterThanOrEqual(32);
    expect(dimForShape([4, 4, 4, 4])).toBeLessThanOrEqual(256);
  });
});

describe("plain A/B (single slot)", () => {
  it("converges to the better variant and beats a frozen 50/50", () => {
    const rng = mulberry32(11);
    const rates = [0.05, 0.1];
    const state = fresh({ slotSizes: [2] });
    let conversions = 0;
    const lateCells: number[] = [];
    const rounds = 4000;
    for (let t = 0; t < rounds; t++) {
      const { cell, converted } = play(state, [], c => rates[c], rng);
      if (converted) {
        conversions++;
      }
      if (t >= rounds - 1000) {
        lateCells.push(cell);
      }
    }
    // Late traffic overwhelmingly on the winner...
    const lateWinnerShare =
      lateCells.filter(c => c === 1).length / lateCells.length;
    expect(lateWinnerShare).toBeGreaterThan(0.85);
    // ...and cumulative conversions beat the 7.5% a frozen split earns.
    expect(conversions / rounds).toBeGreaterThan(0.08);
  });
});

describe("contextual (different winner per segment)", () => {
  it("learns opposite winners for two audiences", () => {
    const rng = mulberry32(17);
    const state = fresh({ slotSizes: [2] });
    const segments = [
      { ctx: [3], best: 0 }, // audience A: variant 1 wins
      { ctx: [7], best: 1 } // audience B: variant 2 wins
    ];
    const rate = (segment: number, cell: number) =>
      cell === segments[segment].best ? 0.12 : 0.04;
    const late: Array<{ segment: number; cell: number }> = [];
    const rounds = 6000;
    for (let t = 0; t < rounds; t++) {
      const segment = t % 2;
      const { cell } = play(
        state,
        segments[segment].ctx,
        c => rate(segment, c),
        rng
      );
      if (t >= rounds - 2000) {
        late.push({ segment, cell });
      }
    }
    for (const segment of [0, 1]) {
      const mine = late.filter(l => l.segment === segment);
      const right =
        mine.filter(l => l.cell === segments[segment].best).length /
        mine.length;
      // A context-blind test would sit at 50% here by construction.
      expect(right).toBeGreaterThan(0.75);
    }
  });
});

describe("multi-slot (the reason one model was worth it)", () => {
  /**
   * The construction per-slot testing cannot solve. In a 2x2, two
   * independent bandits adapting to each other perform coordinate ascent
   * and escape most traps, so the honest adversarial case is a 3x3 with a
   * genuine local-optimum basin:
   *
   *              cta v1  cta v2  cta v3     hero marginal (uniform)
   *   hero v1     .11     .09     .01   ->   .070   <- highest
   *   hero v2     .09     .09     .01   ->   .063
   *   hero v3     .01     .01     .16   ->   .060   <- lowest
   *
   * Both marginals point INTO the top-left plateau, and once each bandit
   * settles there, reaching the global best at (v3, v3) requires both to
   * deviate AT ONCE through .01 territory, which converged independent
   * bandits essentially never do. The joint model carries an explicit
   * (hero v3 x cta v3) interaction feature, so Thompson sampling keeps
   * that cell's posterior alive until it has actually been tried.
   */
  const slotSizes = [3, 3];
  const R = [
    [0.11, 0.09, 0.01],
    [0.09, 0.09, 0.01],
    [0.01, 0.01, 0.16]
  ];
  const rate = (cell: number) => {
    const hero = Math.floor(cell / 3);
    const cta = cell % 3;
    return R[hero][cta];
  };
  const BEST = encodeCell(slotSizes, [2, 2]);
  const rounds = 9000;

  it("finds the isolated winner that marginals point away from", () => {
    const rng = mulberry32(23);
    const state = fresh({ slotSizes });
    const late: number[] = [];
    let conversions = 0;
    for (let t = 0; t < rounds; t++) {
      const { cell, converted } = play(state, [], rate, rng);
      if (converted) {
        conversions++;
      }
      if (t >= rounds - 3000) {
        late.push(cell);
      }
    }
    const bestShare = late.filter(c => c === BEST).length / late.length;
    expect(bestShare).toBeGreaterThan(0.5);
    expect(conversions / rounds).toBeGreaterThan(0.1);
  });

  it("beats two independent per-slot tests on the same rewards", () => {
    // The baseline everyone actually runs: one bandit per element, each
    // rewarded by a combined outcome it can only see marginally.
    function runIndependent(seed: number) {
      const rng = mulberry32(seed);
      const hero = fresh({ slotSizes: [3] });
      const cta = fresh({ slotSizes: [3] });
      let conversions = 0;
      const late: number[] = [];
      for (let t = 0; t < rounds; t++) {
        const h = choose(hero, [], rng);
        const c = choose(cta, [], rng);
        const combined = encodeCell(slotSizes, [h.cell, c.cell]);
        hero.cells[h.cell].pulls += 1;
        cta.cells[c.cell].pulls += 1;
        observe(hero.model, h.featIdx);
        observe(cta.model, c.featIdx);
        if (rng() < rate(combined)) {
          conversions++;
          hero.cells[h.cell].successes += 1;
          cta.cells[c.cell].successes += 1;
          reward(hero.model, h.featIdx);
          reward(cta.model, c.featIdx);
        }
        if (t >= rounds - 3000) {
          late.push(combined);
        }
      }
      return {
        conversions,
        bestShare: late.filter(c => c === BEST).length / late.length
      };
    }

    function runJoint(seed: number) {
      const rng = mulberry32(seed);
      const state = fresh({ slotSizes });
      let conversions = 0;
      const late: number[] = [];
      for (let t = 0; t < rounds; t++) {
        const { cell, converted } = play(state, [], rate, rng);
        if (converted) {
          conversions++;
        }
        if (t >= rounds - 3000) {
          late.push(cell);
        }
      }
      return {
        conversions,
        bestShare: late.filter(c => c === BEST).length / late.length
      };
    }

    // Averaged over seeds: single runs of a stochastic process prove luck.
    const seeds = [29, 31, 37];
    const independent = seeds.map(runIndependent);
    const joint = seeds.map(runJoint);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    const jointShare = mean(joint.map(r => r.bestShare));
    const independentShare = mean(independent.map(r => r.bestShare));
    expect(jointShare).toBeGreaterThan(independentShare + 0.25);
    expect(mean(joint.map(r => r.conversions))).toBeGreaterThan(
      mean(independent.map(r => r.conversions))
    );
  });
});

describe("warm-start priors", () => {
  const rates = [0.04, 0.1];

  function run(priors: StateInit["priors"], seed: number, rounds: number) {
    const rng = mulberry32(seed);
    const state = fresh({ slotSizes: [2], priors });
    let conversions = 0;
    let lateBest = 0;
    for (let t = 0; t < rounds; t++) {
      const { cell, converted } = play(state, [], c => rates[c], rng);
      if (converted) {
        conversions++;
      }
      if (t >= rounds - 500 && cell === 1) {
        lateBest++;
      }
    }
    return { conversions, lateBestShare: lateBest / 500 };
  }

  it("a roughly-right prior speeds the start", () => {
    // Measured where a prior can matter: the opening rounds of a CLOSE
    // race, before data has said much. With an easy gap the cold model
    // converges so fast the prior has nothing left to add.
    const close = [0.05, 0.07];
    function earlyBestShare(priors: StateInit["priors"], seed: number) {
      const rng = mulberry32(seed);
      const state = fresh({ slotSizes: [2], priors });
      let best = 0;
      const horizon = 150;
      for (let t = 0; t < horizon; t++) {
        const { cell } = play(state, [], c => close[c], rng);
        if (cell === 1) {
          best++;
        }
      }
      return best / horizon;
    }
    const seeds = [31, 41, 43, 47, 53, 59, 61, 67];
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const cold = mean(seeds.map(s => earlyBestShare(undefined, s)));
    const warm = mean(
      seeds.map(s =>
        earlyBestShare(
          [
            { slot: 0, variant: 0, mean: 0.05, strength: 40 },
            { slot: 0, variant: 1, mean: 0.07, strength: 40 }
          ],
          s
        )
      )
    );
    // The margin is modest ON PURPOSE: priors are capped weak enough for
    // data to override (see the washout test below), so the honest claim
    // is "leans the right way sooner", not "starts converged". A prior
    // strong enough to triple this margin would be one strong enough to
    // survive being wrong, which is the failure mode the cap exists for.
    expect(warm).toBeGreaterThan(cold + 0.02);
    expect(warm).toBeGreaterThan(0.58);
  });

  it("a confidently wrong prior is washed out by data", () => {
    // The LLM was sure the LOSER would win. Capped strength means real
    // traffic overrides it within the horizon.
    const misled = run(
      [
        { slot: 0, variant: 0, mean: 0.2, strength: 50 },
        { slot: 0, variant: 1, mean: 0.01, strength: 50 }
      ],
      37,
      6000
    );
    expect(misled.lateBestShare).toBeGreaterThan(0.7);
  });
});

describe("dimForShape and context cardinality", () => {
  it("charges for how many values a dimension can take, not just that it exists", () => {
    // The bug this replaces: a flat per-dimension cost meant `country` and a
    // two-value flag bought the same model. Measured consequence with 200
    // countries each having a different best variant: 36.3% correct against a
    // 33.3% chance baseline, i.e. no learning at all.
    const few = dimForShape([3], [{ key: "seg", values: ["a", "b"] }]);
    const many = dimForShape([3], [{ key: "country", from: "country" }]);
    expect(many).toBeGreaterThan(few);
  });

  it("reports what a context would really need, uncapped", () => {
    // dimForShape clamps at MAX_DIM and so cannot say "this does not fit".
    // wantedDimForShape can, which is what a config-time refusal would read.
    expect(
      wantedDimForShape([3], [{ key: "c", from: "country" }])
    ).toBeGreaterThan(MAX_DIM);
    expect(
      wantedDimForShape([3], [{ key: "c", from: "continent" }])
    ).toBeLessThanOrEqual(MAX_DIM);
  });

  it("knows a declared list exactly and falls back conservatively", () => {
    expect(ctxCardinality({ key: "s", values: ["a", "b", "c"] })).toBe(3);
    expect(ctxCardinality({ key: "s", from: "country" })).toBe(200);
    // Free-form: no list, no signal, so the size is genuinely unknown.
    expect(ctxCardinality({ key: "s" })).toBe(8);
  });
});
