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
  /**
   * True when the remaining risk is below the caller's threshold AT THIS
   * LOOK. That qualifier is load-bearing and used to be missing.
   *
   * The rule bounds posterior expected loss for a single evaluation. A
   * dashboard polls it continuously and acts the first time it turns true,
   * which is a different quantity: measured over 5% vs 6%, realized regret
   * came out at 2.59% of the best rate against the 1% the threshold reads
   * like it promises. This is optional stopping, and it is the same effect
   * Loecher (2021), doi:10.3389/frai.2021.715690, documents for bandits. A
   * rule that keeps its guarantee under repeated evaluation has to be built
   * for it: Johari, Koomen, Pekelis & Walsh (2022), Always Valid Inference:
   * Continuous Monitoring of A/B Tests, Operations Research 70(3),
   * doi:10.1287/opre.2021.2135.
   *
   * So read canStop as "the risk is small right now", not as a bound that
   * survives watching. The wording in decisionLine says the same.
   */
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

/**
 * How far the best arm's P(best) must clear the runner-up's before anyone is
 * called a leader.
 *
 * Without this, two genuinely equal arms produce a confident-sounding verdict:
 * simulated at 5% vs 5% under continuous monitoring, canStop fired in 109 of
 * 150 runs and named the "wrong" arm in 54 of them. Realized regret in those
 * runs is exactly zero, which is expected loss doing its job (with equal arms
 * either choice is fine), but "X leads" asserts a finding that does not exist,
 * and the people reading it are marketers.
 *
 * A gap this small means the posteriors overlap too much to separate, so the
 * honest sentence is that there is no difference to find.
 */
export const MIN_PROBABILITY_GAP_TO_NAME_LEADER = 0.1;

/**
 * Pulls a single context bucket needs before it is allowed to name a winner.
 *
 * summarizeBuckets runs an independent analysis per bucket, so every bucket is
 * another chance to see a difference that is not there, and nothing controls
 * the family-wise rate. Measured with every segment and every variant given an
 * IDENTICAL 5% rate, so no real winner exists anywhere:
 *
 *   4 segments x 2 variants   30.7% of runs show a bucket at P(best) >= 95%
 *   8 segments x 2 variants   52.7%
 *   12 segments x 3 variants  20.0%
 *
 * The 8x2 line is a bluestars newsletter with the BSR8 pack: more than half of
 * null runs would display a confident per-segment winner. Since "a different
 * winner per audience" is the product's headline claim, a false one is the
 * feature appearing to work when it is not.
 *
 * This gate is the cheap half of the fix, and it is the same idea as
 * MIN_PULLS_TO_CALL one level down: below it a bucket still reports its counts,
 * it just does not get to claim a leader. It reduces the exposure; it does not
 * make the per-bucket analysis multiplicity-aware. The real fix is to report
 * the joint model's posterior per segment, shrunk toward the global effect,
 * instead of a fresh independent analysis of that bucket's raw counts. See the
 * partial-pooling follow-up issue.
 */
export const MIN_BUCKET_PULLS_TO_CALL = 200;

/**
 * Below this share of a slot's traffic, a variant's reported rate is biased
 * low enough to say so.
 *
 * Thompson sampling starves the loser, which is the whole point, and that
 * makes the sample mean a biased estimator of the true rate: an arm with an
 * unlucky start is sampled less and few observations arrive to correct it.
 * Measured over 300 replications x 1500 visitors at 5% vs 10%, the losing
 * arm's reported rate came out **10.8% below its own true value** (-0.00541
 * on 0.05) while the winner's was unbiased, and Wilson coverage drifted to
 * 0.940-0.947 against a nominal 0.95. Under the null both arms read low.
 *
 * So a customer comparing "4.5% vs 10%" is reading a gap that is really 5%
 * vs 10%. Nie, Tian, Taylor & Zou (2018, AISTATS) prove the negative bias for
 * optimism-driven algorithms including Thompson sampling; Shin, Ramdas &
 * Rinaldo (2019, NeurIPS) give the sign per arm.
 *
 * A quarter of even allocation is the threshold: at two variants that is a
 * 12.5% share, by which point the arm is being visibly starved rather than
 * merely behind. This does not correct anything. It marks the number so it is
 * not read as a fixed-design estimate, which is the cheap half of the fix;
 * the other half is an adaptively-weighted estimator (Hadad et al. 2021,
 * doi:10.1073/pnas.2014602118) over the event log.
 */
export const THIN_EXPOSURE_SHARE = 0.25;

/**
 * Rolls per-cell outcomes up to one slot's variants: pulls and
 * conversions of every cell that used the variant. What "how is hero B
 * doing overall" means for a multi-slot test.
 */
export function marginalOutcomes(
  cells: ArmOutcome[],
  slotSizes: number[],
  slot: number
): ArmOutcome[] {
  const out: ArmOutcome[] = Array.from({ length: slotSizes[slot] }, () => ({
    pulls: 0,
    conversions: 0
  }));
  let stride = 1;
  for (let i = slot + 1; i < slotSizes.length; i++) {
    stride *= slotSizes[i];
  }
  for (let cell = 0; cell < cells.length; cell++) {
    const variant = Math.floor(cell / stride) % slotSizes[slot];
    out[variant].pulls += cells[cell].pulls;
    out[variant].conversions += cells[cell].conversions;
  }
  return out;
}
