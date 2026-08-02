import { mulberry32, sampleBeta, type Rng } from "./rng.js";

/**
 * "Which variant won, and can I stop?" answered from the posterior rather
 * than by eye. This is the arithmetic an assistant reading a test's stats
 * would otherwise have to invent, and inventing it is exactly how a
 * confident wrong call gets made: comparing two raw conversion rates says
 * nothing about whether the gap is real.
 *
 * Beta-Bernoulli throughout, matching the bandits: arm i has posterior
 * Beta(1 + conversions, 1 + pulls - conversions).
 */

export interface ArmOutcome {
  pulls: number;
  conversions: number;
}

export interface DecisionAnalysis {
  /** P(arm i has the highest true rate), summing to 1. */
  probabilities: number[];
  /** Index of the arm most likely to be best. */
  leader: number;
  /**
   * Expected regret of stopping now and keeping the leader forever, in
   * conversion-rate points: E[max_j(rate_j) - rate_leader]. The standard
   * stopping rule, and the honest one, because it answers "how much could
   * this decision still cost me" rather than "is p < 0.05".
   */
  expectedLoss: number;
  /** expectedLoss as a fraction of the leader's own rate. */
  relativeLoss: number;
  /** True when the remaining risk is below the caller's threshold. */
  canStop: boolean;
  /** Posterior mean rate per arm, which is what the leader is judged on. */
  rates: number[];
}

export interface DecisionOptions {
  /** Monte Carlo draws. 20k keeps the error well under a tenth of a point. */
  draws?: number;
  rng?: Rng;
  /**
   * Stop when the expected loss is under this fraction of the leader's
   * rate. 1% is the usual convention and is deliberately not a p-value.
   */
  threshold?: number;
}

/**
 * Monte Carlo over the arms' posteriors. Sampling rather than a closed
 * form because there is no clean one past two arms, and the sampler is
 * the same one the bandit itself uses, so the answer agrees with the
 * mechanism that produced the data.
 */
export function analyzeOutcomes(
  arms: ArmOutcome[],
  options: DecisionOptions = {}
): DecisionAnalysis {
  const draws = options.draws ?? 20_000;
  // Seeded by default: the same stats must explain the same way twice, or
  // an assistant asked to re-check its own reasoning contradicts itself.
  const rng = options.rng ?? mulberry32(0x5eed);
  const threshold = options.threshold ?? 0.01;

  const wins = new Array<number>(arms.length).fill(0);
  const rates = arms.map(
    arm => (1 + arm.conversions) / (2 + Math.max(arm.pulls, arm.conversions))
  );
  if (arms.length === 0) {
    return {
      probabilities: [],
      leader: -1,
      expectedLoss: 0,
      relativeLoss: 0,
      canStop: false,
      rates: []
    };
  }

  // The leader is judged on the posterior mean, then the loss is measured
  // against THAT choice: picking the leader per-draw would measure a
  // decision nobody can actually make.
  let leader = 0;
  for (let i = 1; i < arms.length; i++) {
    if (rates[i] > rates[leader]) {
      leader = i;
    }
  }

  let lossTotal = 0;
  const sample = new Array<number>(arms.length).fill(0);
  for (let d = 0; d < draws; d++) {
    let best = 0;
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      sample[i] = sampleBeta(
        1 + arm.conversions,
        1 + Math.max(0, arm.pulls - arm.conversions),
        rng
      );
      if (sample[i] > sample[best]) {
        best = i;
      }
    }
    wins[best]++;
    lossTotal += Math.max(0, sample[best] - sample[leader]);
  }

  const expectedLoss = lossTotal / draws;
  const leaderRate = rates[leader];
  const relativeLoss = leaderRate > 0 ? expectedLoss / leaderRate : Infinity;
  return {
    probabilities: wins.map(w => w / draws),
    leader,
    expectedLoss,
    relativeLoss,
    // A test nobody has seen has no risk to speak of and still cannot be
    // called, so require some evidence before ever saying "stop".
    canStop:
      relativeLoss <= threshold &&
      arms.some(arm => arm.pulls >= MIN_PULLS_TO_CALL),
    rates
  };
}

/** Below this, "the risk is small" only means "there is no data yet". */
export const MIN_PULLS_TO_CALL = 100;
