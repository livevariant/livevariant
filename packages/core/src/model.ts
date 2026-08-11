import { fnv1a32 } from "./canonical.js";
import { cellCount, decodeCell } from "./cells.js";
import { sampleGaussian, type Rng } from "./rng.js";

/**
 * THE model. LiveVariant runs exactly one algorithm for every test: joint
 * linear Thompson sampling over hashed binary features. A plain A/B test,
 * a contextual test and a multi-slot test are the same mathematics with
 * different features active, which is what lets users never choose an
 * algorithm and never tune one.
 *
 * Features of a (cell, context) pair:
 *   - bias (index 0), always active
 *   - the caller's context features (hashed key=value indices, computed
 *     by featureIndices in context.ts)
 *   - one main effect per chosen slot variant
 *   - one interaction per pair of chosen slot variants (slot x slot):
 *     this is what lets the model learn that hero B only wins WITH cta A,
 *     the thing per-slot testing structurally cannot see
 *   - one interaction per (context feature, chosen slot variant): this is
 *     "a different winner per audience segment"
 *
 * Everything is hashed into a fixed dimension sized from the config
 * (dimForShape), so two features can land in one slot instead of the model
 * erroring. Collisions are not rare, and this comment used to imply they
 * were: measured at shipped dimensions, 26.7% of features share a slot for
 * [3,3] at dim 32, 41.7% once a country dimension is added, 55.6% for
 * [2,2,2], 45.5% for the 8-segment shape a bluestars newsletter runs.
 *
 * What makes that tolerable is not the rate but WHICH collisions happen. No
 * shape tested produced same-slot main-effect aliasing, the one that would
 * actually hurt: two variants of a single slot becoming indistinguishable to
 * the model. And the 3x3 local-optimum simulation in model.spec.ts reaches the
 * global optimum at dim 32, 64 and 128 alike, so the mechanism this model
 * exists for survives the collisions it has. Feature hashing is Weinberger et
 * al. (2009), Feature Hashing for Large Scale Multitask Learning (ICML),
 * doi:10.1145/1553374.1553516; note that its guarantees are asymptotic in a
 * sparse, high-dimensional regime, and dimForShape's ~2x features-to-slots
 * ratio sits well below it. We are relying on the measurement, not the theorem.
 *
 * Serving draws one plausible weight vector from the posterior
 * (theta = mean + noise * L * z, L the Cholesky factor of the covariance)
 * and plays the exactly best cell under it: the action space is capped at
 * MAX_CELLS, so enumeration replaces the greedy search a larger space
 * would force, and there are no local optima to worry about.
 */

export interface JointModel {
  /** Inverse design matrix A^-1, dim x dim, row-major. */
  aInv: number[][];
  /** Reward-weighted feature sums. */
  b: number[];
}

/** Exploration scale for the posterior draw. Fixed: not a user knob. */
export const MODEL_NOISE = 0.5;

/**
 * Warm-start prior for one slot variant, typically an LLM's guess at its
 * conversion rate expressed as `strength` pseudo-observations. Capped by
 * priorStrengthCap in the schema so a confident wrong guess costs a
 * little early traffic, never the test.
 */
export interface VariantPrior {
  slot: number;
  variant: number;
  mean: number;
  strength: number;
  /**
   * When set, the belief holds only for visitors in this context: it is
   * written to the (context x variant) interaction features instead of the
   * variant's main effect. Already-hashed indices, because that is the only
   * form of context this model ever sees.
   */
  ctxFeatIdx?: number[];
}

// ------------------------------------------------------------- features

function hashed(dim: number, key: string): number {
  return 1 + (fnv1a32(key) % (dim - 1));
}

/** Main-effect feature index of one slot variant. */
export function variantFeature(
  dim: number,
  slot: number,
  variant: number
): number {
  return hashed(dim, `s${slot}=${variant}`);
}

/**
 * Feature index of "this variant, for visitors carrying this context
 * feature". Used both when recording a pull and when writing a
 * segment-conditioned prior, so a warm start lands on exactly the feature
 * the traffic will later move.
 */
export function ctxVariantFeature(
  dim: number,
  ctxFeat: number,
  slot: number,
  variant: number
): number {
  return hashed(dim, `x${ctxFeat}|s${slot}=${variant}`);
}

/**
 * Full feature set for choosing/recording one cell under a context. The
 * context arrives as already-hashed indices (client-side hashing keeps
 * raw values off the wire), so interactions combine index with index.
 */
export function cellFeatures(
  dim: number,
  slotSizes: number[],
  cell: number,
  ctxFeatIdx: number[]
): number[] {
  const choice = decodeCell(slotSizes, cell);
  const features = new Set<number>([0]);
  const ctx = ctxFeatIdx.filter(f => Number.isInteger(f) && f > 0 && f < dim);
  for (const f of ctx) {
    features.add(f);
  }
  for (let i = 0; i < choice.length; i++) {
    features.add(variantFeature(dim, i, choice[i]));
    for (let j = i + 1; j < choice.length; j++) {
      features.add(hashed(dim, `s${i}=${choice[i]}|s${j}=${choice[j]}`));
    }
    for (const f of ctx) {
      features.add(ctxVariantFeature(dim, f, i, choice[i]));
    }
  }
  return [...features].sort((a, b) => a - b);
}

/**
 * Model dimension, decided from the shape so nobody ever picks it. Sized to
 * roughly twice the number of distinct features the test can express, then
 * rounded to a power of two and clamped.
 *
 * Twice is not enough to make collisions rare, and it is not meant to be: see
 * the note on cellFeatures above for the measured rates (25-56%) and for why
 * they cost nothing here. It is enough to keep main effects apart, which is
 * the property that matters.
 */
export function dimForShape(slotSizes: number[], ctxDimCount = 0): number {
  const mains = slotSizes.reduce((sum, n) => sum + n, 0);
  let pairs = 0;
  for (let i = 0; i < slotSizes.length; i++) {
    for (let j = i + 1; j < slotSizes.length; j++) {
      pairs += slotSizes[i] * slotSizes[j];
    }
  }
  const ctx = ctxDimCount * (8 + mains);
  const wanted = 2 * (1 + mains + pairs + ctx);
  let dim = 16;
  while (dim < wanted && dim < 256) {
    dim *= 2;
  }
  return dim;
}

// ---------------------------------------------------------------- model

export function newModel(dim: number, priors: VariantPrior[] = []): JointModel {
  const aInv = identity(dim);
  const b = new Array<number>(dim).fill(0);
  for (const prior of priors) {
    if (prior.strength <= 0) {
      continue;
    }
    // "strength" pseudo-observations at rate "mean" on each feature the
    // belief is about: A += strength * e_f e_f^T, b += strength * mean *
    // e_f. Starting from the identity ridge this keeps A diagonal, so the
    // inverse update is exact and cheap.
    //
    // An unconditioned prior is a belief about everybody, so it lands on
    // the variant's main effect. A conditioned one is a belief about one
    // segment, so it lands on the (context x variant) interactions, which
    // is exactly where that segment's own traffic will later move.
    const features =
      prior.ctxFeatIdx && prior.ctxFeatIdx.length > 0
        ? prior.ctxFeatIdx.map(ctxFeat =>
            ctxVariantFeature(dim, ctxFeat, prior.slot, prior.variant)
          )
        : [variantFeature(dim, prior.slot, prior.variant)];
    for (const f of features) {
      aInv[f][f] = 1 / (1 / aInv[f][f] + prior.strength);
      b[f] += prior.strength * prior.mean;
    }
  }
  return { aInv, b };
}

/** Rank-1 Sherman-Morrison update of A^-1 for one observed pull. */
export function observe(model: JointModel, featIdx: number[]): void {
  const dim = model.b.length;
  const u = new Array<number>(dim).fill(0);
  for (let i = 0; i < dim; i++) {
    let sum = 0;
    for (const j of featIdx) {
      sum += model.aInv[i][j];
    }
    u[i] = sum;
  }
  let denom = 1;
  for (const i of featIdx) {
    denom += u[i];
  }
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      model.aInv[i][j] -= (u[i] * u[j]) / denom;
    }
  }
  // Guard symmetry against float drift.
  for (let i = 0; i < dim; i++) {
    for (let j = i + 1; j < dim; j++) {
      const mean = (model.aInv[i][j] + model.aInv[j][i]) / 2;
      model.aInv[i][j] = mean;
      model.aInv[j][i] = mean;
    }
  }
}

/** Adds reward for a pull that had the given features. */
export function reward(model: JointModel, featIdx: number[]): void {
  for (const i of featIdx) {
    model.b[i] += 1;
  }
}

/**
 * One Thompson draw, then the exactly best cell under it. Theta is
 * sampled ONCE and every cell scored against the same draw: sampling per
 * cell would break the posterior-probability-matching property that makes
 * Thompson sampling work.
 */
export function chooseCell(
  model: JointModel,
  slotSizes: number[],
  ctxFeatIdx: number[],
  rng: Rng,
  noise: number = MODEL_NOISE
): number {
  // The Cholesky is O(dim^3) per serve: ~16M flops at the dim=256 cap,
  // single-digit milliseconds, and most tests sit at 16-64 where it is
  // negligible. Caching the FACTOR was considered and rejected: every
  // id'd pull rank-1-updates aInv, invalidating it, so even the server's
  // decoded-model cache (ModelCache) would rarely have a live factor to
  // reuse. Revisit with a rank-1 Cholesky update (O(dim^2)) only if
  // profiling ever says so.
  const dim = model.b.length;
  const thetaHat = matVec(model.aInv, model.b);
  const chol = cholesky(model.aInv);
  const z = Array.from({ length: dim }, () => sampleGaussian(rng));
  const theta = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    let noiseTerm = 0;
    for (let j = 0; j <= i; j++) {
      noiseTerm += chol[i][j] * z[j];
    }
    theta[i] = thetaHat[i] + noise * noiseTerm;
  }

  const cells = cellCount(slotSizes);
  let best = 0;
  let bestScore = -Infinity;
  for (let cell = 0; cell < cells; cell++) {
    let score = 0;
    for (const f of cellFeatures(dim, slotSizes, cell, ctxFeatIdx)) {
      score += theta[f];
    }
    if (score > bestScore) {
      bestScore = score;
      best = cell;
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
