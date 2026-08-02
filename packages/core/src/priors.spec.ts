import { describe, expect, it } from "vitest";
import { capArmPriors } from "./priors.js";
import { chooseThompson, emptyCounts, type ArmCounts } from "./bandits.js";
import { mulberry32 } from "./rng.js";
import type { ArmPrior } from "./schema.js";

/**
 * The two properties LLM warm-start priors must have (per the warm-start
 * literature): roughly-right priors accelerate early performance, and
 * wrong priors get washed out by real data instead of locking in.
 */

function runRounds(
  rounds: number,
  priors: ArmPrior[] | undefined,
  seed: number,
  rates: number[]
): { arms: ArmCounts[]; rewards: number; lastChosen: number[] } {
  const rng = mulberry32(seed);
  const arms = emptyCounts(rates.length);
  let rewards = 0;
  const lastChosen: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const arm = chooseThompson(arms, priors, rng);
    arms[arm].pulls += 1;
    if (rng() < rates[arm]) {
      arms[arm].successes += 1;
      rewards += 1;
    }
    lastChosen.push(arm);
  }
  return { arms, rewards, lastChosen };
}

describe("prior capping", () => {
  it("scales overconfident priors down to the cap", () => {
    const capped = capArmPriors([{ alpha: 900, beta: 100 }], 50);
    expect(capped[0].alpha + capped[0].beta).toBeCloseTo(50);
    expect(capped[0].alpha / capped[0].beta).toBeCloseTo(9); // ratio kept
  });

  it("leaves weak priors untouched", () => {
    expect(capArmPriors([{ alpha: 4, beta: 6 }], 50)[0]).toEqual({
      alpha: 4,
      beta: 6
    });
  });
});

describe("warm-start behavior", () => {
  const rates = [0.05, 0.2]; // arm 1 is truly best

  it("roughly-right priors accelerate early reward", () => {
    // "The LLM guessed arm 1 wins at ~20% vs ~5%", capped-strength form.
    const goodPriors: ArmPrior[] = [
      { alpha: 1, beta: 19 },
      { alpha: 4, beta: 16 }
    ];
    // Averaged over seeds: a single seed would make this a coin flip.
    let primed = 0;
    let cold = 0;
    for (let seed = 0; seed < 20; seed++) {
      primed += runRounds(300, goodPriors, 100 + seed, rates).rewards;
      cold += runRounds(300, undefined, 100 + seed, rates).rewards;
    }
    expect(primed).toBeGreaterThan(cold * 1.05);
  });

  it("wrong priors are washed out by real data", () => {
    // The LLM was confidently backwards, at the strength cap.
    const wrongPriors: ArmPrior[] = [
      { alpha: 45, beta: 5 },
      { alpha: 5, beta: 45 }
    ];
    const { lastChosen } = runRounds(6000, wrongPriors, 77, rates);
    const tail = lastChosen.slice(-1000);
    const bestShare = tail.filter(a => a === 1).length / tail.length;
    expect(bestShare).toBeGreaterThan(0.6);
  });
});
