import { fnv1a32 } from "./canonical.js";
import { cellCount, decodeCell } from "./cells.js";
import { sampleGaussian, type Rng } from "./rng.js";
import { SIGNAL_CARDINALITY, type AutoSignal } from "./signals.js";

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
 * How many slots a free-form context dimension is charged for.
 *
 * Free-form means no `values` list and no signal to look the size up from, so
 * the value space is genuinely unknown: a caller can pass anything. This is the
 * old flat estimate, kept as the conservative default for exactly that case.
 */
const FREEFORM_CTX_CARDINALITY = 8;

/**
 * Model dimension, decided from the shape so nobody ever picks it. Sized to
 * roughly twice the number of distinct features the test can express, then
 * rounded to a power of two and clamped.
 *
 * Twice is not enough to make collisions rare, and it is not meant to be: see
 * the note on cellFeatures above for the measured rates (25-56%) and for why
 * they cost nothing here. It is enough to keep main effects apart, which is
 * the property that matters.
 *
 * Context is charged by CARDINALITY, not per dimension, and that is a fix
 * rather than a refinement. This used to charge a flat `8 + mains` per
 * dimension however many values it could take, so declaring `country` bought
 * dim=32 for roughly 803 distinct features. Measured: with 200 countries each
 * having a genuinely different best variant, the model picked correctly 36.3%
 * of the time against a 33.3% chance baseline. It was not learning per-segment
 * winners at all, and the 256 cap meant no setting could rescue it. A
 * dimension that cannot be represented is now refused at config time
 * (see schema.ts) rather than silently under-served.
 */
export function dimForShape(
  slotSizes: number[],
  ctxDims: ReadonlyArray<CtxCardinality> = []
): number {
  const mains = slotSizes.reduce((sum, n) => sum + n, 0);
  let pairs = 0;
  for (let i = 0; i < slotSizes.length; i++) {
    for (let j = i + 1; j < slotSizes.length; j++) {
      pairs += slotSizes[i] * slotSizes[j];
    }
  }
  // One (context value x variant) interaction per value per variant, plus the
  // value's own main effect. That is what cellFeatures actually hashes, which
  // is why counting dimensions instead of values under-sized the model.
  const ctx = ctxDims.reduce(
    (sum, dim) => sum + ctxCardinality(dim) * (1 + mains),
    0
  );
  const wanted = 2 * (1 + mains + pairs + ctx);
  let dim = 16;
  while (dim < wanted && dim < MAX_DIM) {
    dim *= 2;
  }
  return dim;
}

/** The largest model the hashing is allowed to grow to. */
export const MAX_DIM = 256;

/**
 * What dimForShape needs to know about one context dimension. Structural on
 * purpose: core must not import the zod schema, and the server, the sdk and a
 * test fixture all have to be able to describe a dimension the same way.
 */
export interface CtxCardinality {
  values?: readonly string[];
  from?: string;
}

/**
 * How many distinct values a dimension can take.
 *
 * A declared `values` list is exact. A signal-filled dimension uses the
 * repo's own estimate in SIGNAL_CARDINALITY, which is the number the old
 * code already had and did not consult. Anything else is free-form.
 */
export function ctxCardinality(dim: CtxCardinality): number {
  if (dim.values && dim.values.length > 0) {
    return dim.values.length;
  }
  if (dim.from) {
    return (
      SIGNAL_CARDINALITY[dim.from as AutoSignal] ?? FREEFORM_CTX_CARDINALITY
    );
  }
  return FREEFORM_CTX_CARDINALITY;
}

/**
 * The dimension a config WOULD need to represent its context honestly, with no
 * cap applied. What schema.ts compares against MAX_DIM to decide whether a
 * dimension is representable at all.
 */
export function wantedDimForShape(
  slotSizes: number[],
  ctxDims: ReadonlyArray<CtxCardinality> = []
): number {
  const mains = slotSizes.reduce((sum, n) => sum + n, 0);
  let pairs = 0;
  for (let i = 0; i < slotSizes.length; i++) {
    for (let j = i + 1; j < slotSizes.length; j++) {
      pairs += slotSizes[i] * slotSizes[j];
    }
  }
  const ctx = ctxDims.reduce(
    (sum, dim) => sum + ctxCardinality(dim) * (1 + mains),
    0
  );
  return 2 * (1 + mains + pairs + ctx);
}

/**
 * The pre-cardinality sizing, kept because a test that is already RUNNING was
 * sized by it.
 *
 * dim is not stored in the config and not part of the test id; it is
 * recomputed from the config on every serve and every read. featIdx, however,
 * IS stored per assignment record, hashed modulo the dim in force when the
 * record was written. So changing dimForShape does not invalidate a test id,
 * it silently re-points every historical feature: state.ts's safeFeatIdx only
 * drops indices that fall outside the new dim, and when dim GROWS every old
 * index is still in range and simply means something else now.
 *
 * That is why this function still exists. `paramsFromConfig` takes an explicit
 * sizing version so a test registered before the fix keeps its original
 * geometry and its history stays readable.
 */
export function legacyDimForShape(
  slotSizes: number[],
  ctxDimCount = 0
): number {
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
  while (dim < wanted && dim < MAX_DIM) {
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
