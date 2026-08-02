import { describe, expect, it } from "vitest";
import {
  chooseArm,
  applyAssignment,
  applyFirstReward,
  newDerivedState,
  type DerivedState
} from "./state.js";
import { featureIndices } from "./context.js";
import { mulberry32, type Rng } from "./rng.js";

/**
 * Monte-Carlo convergence checks with fixed seeds. Margins are deliberately
 * generous: these tests must prove the algorithms learn, not benchmark them.
 */

interface SimEnv {
  /** True reward probability per arm for a given context. */
  rates(ctx: Record<string, string> | null): number[];
  contexts: Array<Record<string, string> | null>;
}

function simulate(
  state: DerivedState,
  env: SimEnv,
  rounds: number,
  rng: Rng,
  options: Parameters<typeof chooseArm>[2] = {}
): { chosen: number[]; ctxUsed: Array<Record<string, string> | null> } {
  const chosen: number[] = [];
  const ctxUsed: Array<Record<string, string> | null> = [];
  for (let round = 0; round < rounds; round++) {
    const ctx = env.contexts[Math.floor(rng() * env.contexts.length)];
    const ctxKey = ctx ? JSON.stringify(ctx) : null; // stand-in for the hash
    const featIdx = featureIndices(ctx);
    const arm = chooseArm(state, { ctxKey, featIdx }, options, rng);
    const rec = { armIndex: arm, ctxKey, featIdx };
    applyAssignment(state, rec);
    if (rng() < env.rates(ctx)[arm]) {
      applyFirstReward(state, rec);
    }
    chosen.push(arm);
    ctxUsed.push(ctx);
  }
  return { chosen, ctxUsed };
}

function shareOfBest(
  chosen: number[],
  ctxUsed: Array<Record<string, string> | null>,
  env: SimEnv,
  lastN: number
): number {
  let best = 0;
  const start = chosen.length - lastN;
  for (let i = start; i < chosen.length; i++) {
    const rates = env.rates(ctxUsed[i]);
    if (chosen[i] === rates.indexOf(Math.max(...rates))) {
      best++;
    }
  }
  return best / lastN;
}

describe("thompson", () => {
  it("converges traffic to the best arm", () => {
    const env: SimEnv = {
      rates: () => [0.05, 0.1, 0.2],
      contexts: [null]
    };
    const state = newDerivedState({ alg: "ts", armCount: 3 });
    const { chosen, ctxUsed } = simulate(state, env, 5000, mulberry32(42));
    expect(shareOfBest(chosen, ctxUsed, env, 1000)).toBeGreaterThan(0.8);
  });

  it("splits roughly evenly when arms are identical", () => {
    const env: SimEnv = { rates: () => [0.1, 0.1], contexts: [null] };
    const state = newDerivedState({ alg: "ts", armCount: 2 });
    const { chosen } = simulate(state, env, 2000, mulberry32(7));
    const armZero = chosen.filter(c => c === 0).length / chosen.length;
    expect(armZero).toBeGreaterThan(0.2);
    expect(armZero).toBeLessThan(0.8);
  });
});

describe("bucketed", () => {
  const env: SimEnv = {
    // The best arm flips per device: exactly the case plain TS cannot win.
    rates: ctx => (ctx?.device === "mobile" ? [0.2, 0.05] : [0.05, 0.2]),
    contexts: [{ device: "mobile" }, { device: "desktop" }]
  };

  it("learns a different winner per bucket", () => {
    const state = newDerivedState({ alg: "bucketed", armCount: 2 });
    const { chosen, ctxUsed } = simulate(state, env, 6000, mulberry32(11), {
      minBucketPulls: 100
    });
    expect(shareOfBest(chosen, ctxUsed, env, 1500)).toBeGreaterThan(0.75);
  });

  it("beats plain thompson on context-dependent rewards", () => {
    const bucketed = newDerivedState({ alg: "bucketed", armCount: 2 });
    const plain = newDerivedState({ alg: "ts", armCount: 2 });
    const b = simulate(bucketed, env, 6000, mulberry32(13), {
      minBucketPulls: 100
    });
    const p = simulate(plain, env, 6000, mulberry32(13));
    expect(shareOfBest(b.chosen, b.ctxUsed, env, 1500)).toBeGreaterThan(
      shareOfBest(p.chosen, p.ctxUsed, env, 1500) + 0.15
    );
  });
});

describe("linear", () => {
  it("learns context-dependent winners through generalization", () => {
    const env: SimEnv = {
      rates: ctx => (ctx?.device === "mobile" ? [0.2, 0.05] : [0.05, 0.2]),
      contexts: [{ device: "mobile" }, { device: "desktop" }]
    };
    const state = newDerivedState({ alg: "linear", armCount: 2 });
    const { chosen, ctxUsed } = simulate(state, env, 4000, mulberry32(21));
    expect(shareOfBest(chosen, ctxUsed, env, 1000)).toBeGreaterThan(0.7);
  });

  it("outperforms bucketed when context is rich and data is thin", () => {
    // 2x8x3 = 48 combos over 2500 rounds (~52 pulls per bucket): every
    // bucket starves below minBucketPulls, so bucketed is stuck on its
    // global fallback (~coin flip here), while the linear model
    // generalizes the single dimension that matters across all buckets.
    const countries = ["nl", "de", "fr", "uk", "es", "it", "be", "pl"];
    const contexts: Array<Record<string, string>> = [];
    for (const device of ["mobile", "desktop"]) {
      for (const country of countries) {
        for (const persona of ["new", "returning", "power"]) {
          contexts.push({ device, country, persona });
        }
      }
    }
    const env: SimEnv = {
      rates: ctx => (ctx?.device === "mobile" ? [0.25, 0.05] : [0.05, 0.25]),
      contexts
    };
    const linear = newDerivedState({ alg: "linear", armCount: 2 });
    const bucketed = newDerivedState({ alg: "bucketed", armCount: 2 });
    const l = simulate(linear, env, 2500, mulberry32(31));
    const b = simulate(bucketed, env, 2500, mulberry32(31), {
      minBucketPulls: 100
    });
    expect(shareOfBest(l.chosen, l.ctxUsed, env, 800)).toBeGreaterThan(
      shareOfBest(b.chosen, b.ctxUsed, env, 800) + 0.1
    );
  });
});
