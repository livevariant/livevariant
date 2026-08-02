import type { Rng } from "./rng.js";
import { sampleBeta, sampleGaussian } from "./rng.js";
import type { ArmPrior } from "./schema.js";
import type { LinearPrior } from "./priors.js";

/**
 * The three bandits. All pure and synchronous: derived-state in, arm index
 * out; the caller owns persistence, hashing, and randomness.
 */

// ---------------------------------------------------------------- Thompson

/** Beta-Bernoulli sufficient statistics per arm. */
export interface ArmCounts {
  pulls: number;
  successes: number;
}

export function emptyCounts(armCount: number): ArmCounts[] {
  return Array.from({ length: armCount }, () => ({ pulls: 0, successes: 0 }));
}

/**
 * Thompson sampling: draw a plausible reward rate per arm from its
 * posterior, play the argmax. Priors are pseudo-counts layered on the
 * uniform Beta(1,1) at sampling time, so they can change without touching
 * recorded state.
 */
export function chooseThompson(
  arms: ArmCounts[],
  priors: ArmPrior[] | undefined,
  rng: Rng
): number {
  let best = 0;
  let bestSample = -1;
  for (let i = 0; i < arms.length; i++) {
    const prior = priors?.[i] ?? { alpha: 0, beta: 0 };
    const { pulls, successes } = arms[i];
    const sample = sampleBeta(
      1 + prior.alpha + successes,
      1 + prior.beta + (pulls - successes),
      rng
    );
    if (sample > bestSample) {
      bestSample = sample;
      best = i;
    }
  }
  return best;
}

/**
 * Bucketed Thompson: each context bucket is its own independent bandit,
 * but until a bucket has seen minBucketPulls pulls the global counters
 * decide, so thin buckets don't thrash on noise.
 */
export function chooseBucketed(
  global: ArmCounts[],
  bucket: ArmCounts[] | undefined,
  options: {
    minBucketPulls: number;
    armPriors?: ArmPrior[];
    bucketPriors?: ArmPrior[];
  },
  rng: Rng
): number {
  const bucketPulls = bucket?.reduce((sum, a) => sum + a.pulls, 0) ?? 0;
  if (bucket && bucketPulls >= options.minBucketPulls) {
    return chooseThompson(
      bucket,
      options.bucketPriors ?? options.armPriors,
      rng
    );
  }
  return chooseThompson(global, options.armPriors, rng);
}

// ------------------------------------------------------------------ Linear

/**
 * Disjoint linear Thompson sampling (one ridge model per arm) over sparse
 * binary features. We store A⁻¹ directly and update it with rank-1
 * Sherman-Morrison steps, so serving never inverts a matrix.
 */
export interface LinearArmState {
  /** Inverse design matrix A⁻¹, dim x dim, row-major. */
  aInv: number[][];
  /** Reward-weighted feature sums. */
  b: number[];
}

/** Exploration scale for the posterior draw. */
export const LINEAR_NOISE = 0.5;

export function initLinearArm(
  dim: number,
  prior?: LinearPrior
): LinearArmState {
  const aInv = identity(dim);
  const b = new Array<number>(dim).fill(0);
  if (prior && prior.strength > 0) {
    // Prior lives on the bias coordinate: A += strength·e₀e₀ᵀ,
    // b += strength·mean·e₀, i.e. "strength" pseudo-pulls at rate "mean".
    aInv[0][0] = 1 / (1 + prior.strength);
    b[0] = prior.strength * prior.mean;
  }
  return { aInv, b };
}

/** Rank-1 Sherman-Morrison update of A⁻¹ for one observed pull. */
export function linearObserve(state: LinearArmState, featIdx: number[]): void {
  const dim = state.b.length;
  const u = new Array<number>(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    let sum = 0;
    for (const j of featIdx) {
      sum += state.aInv[i][j];
    }
    u[i] = sum;
  }
  let denom = 1;
  for (const i of featIdx) {
    denom += u[i];
  }
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      state.aInv[i][j] -= (u[i] * u[j]) / denom;
    }
  }
  // Guard symmetry against float drift; cheap at dim<=16.
  for (let i = 0; i < dim; i++) {
    for (let j = i + 1; j < dim; j++) {
      const mean = (state.aInv[i][j] + state.aInv[j][i]) / 2;
      state.aInv[i][j] = mean;
      state.aInv[j][i] = mean;
    }
  }
}

/** Adds one unit of reward for a pull that had the given features. */
export function linearReward(state: LinearArmState, featIdx: number[]): void {
  for (const i of featIdx) {
    state.b[i] += 1;
  }
}

/**
 * Linear Thompson draw: θ ~ N(A⁻¹b, noise²·A⁻¹) per arm, score the active
 * features, play the argmax.
 */
export function chooseLinear(
  arms: LinearArmState[],
  featIdx: number[],
  rng: Rng,
  noise: number = LINEAR_NOISE
): number {
  let best = 0;
  let bestScore = -Infinity;
  for (let armIndex = 0; armIndex < arms.length; armIndex++) {
    const { aInv, b } = arms[armIndex];
    const dim = b.length;
    const thetaHat = matVec(aInv, b);
    const chol = cholesky(aInv);
    const z = Array.from({ length: dim }, () => sampleGaussian(rng));
    let score = 0;
    for (const i of featIdx) {
      let noiseTerm = 0;
      for (let j = 0; j <= i; j++) {
        noiseTerm += chol[i][j] * z[j];
      }
      score += thetaHat[i] + noise * noiseTerm;
    }
    if (score > bestScore) {
      bestScore = score;
      best = armIndex;
    }
  }
  return best;
}

// ------------------------------------------------------- matrix utilities

export function identity(dim: number): number[][] {
  return Array.from({ length: dim }, (_, i) =>
    Array.from({ length: dim }, (_, j) => (i === j ? 1 : 0))
  );
}

export function matVec(m: number[][], v: number[]): number[] {
  return m.map(row => row.reduce((sum, cell, j) => sum + cell * v[j], 0));
}

/** Lower-triangular Cholesky factor; clamps tiny negatives from drift. */
export function cholesky(m: number[][]): number[][] {
  const dim = m.length;
  const l = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = m[i][j];
      for (let k = 0; k < j; k++) {
        sum -= l[i][k] * l[j][k];
      }
      if (i === j) {
        l[i][j] = Math.sqrt(Math.max(sum, Number.EPSILON));
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }
  return l;
}
