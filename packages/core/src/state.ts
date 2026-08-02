import {
  chooseBucketed,
  chooseLinear,
  chooseThompson,
  emptyCounts,
  initLinearArm,
  linearObserve,
  linearReward,
  type ArmCounts,
  type LinearArmState
} from "./bandits.js";
import { FEATURE_DIM } from "./context.js";
import type { LinearPrior } from "./priors.js";
import type { ArmPrior } from "./schema.js";
import type { Rng } from "./rng.js";
import type { RequestSignals } from "./signals.js";

/**
 * Event-sourced state. The single source of truth is one AssignmentRecord
 * per (testId, idHash); the bandit-facing DerivedState is a cache that the
 * hot path updates incrementally and recomputeState can always rebuild.
 * The incremental and replay paths share the exact apply functions below,
 * which is what makes them provably equivalent (see recompute.spec.ts).
 */

export interface AssignmentRecord {
  armIndex: number;
  /** Opaque bucket key, or null when the request carried no context. */
  ctxKey: string | null;
  /** Hashed feature indices (linear alg), enough to replay without ctx. */
  featIdx: number[] | null;
  /** Accumulated reward; only the first reward updates derived state. */
  rewardTotal: number;
  /** ms epoch; also the replay order for recompute. */
  firstSeen: number;
  /**
   * Opaque, per-test, daily-rotating hash of the traffic source's address
   * prefix (see source.ts). Never an address, never cross-test. Used only
   * so a creator can see where traffic came from and quarantine what
   * doesn't belong (see exclusions.ts).
   */
  srcHash?: string | null;
  /**
   * Coarse signals the server derived for this request (country, device,
   * and friends). Stored readable, unlike the caller's own context, so
   * stats can say "nl / mobile" instead of an opaque bucket hash. These
   * are recorded whether or not the test uses them as context, since
   * they cost nothing and make a test's numbers legible after the fact.
   */
  signals?: RequestSignals | null;
  /**
   * Serving snapshot: how this assignment was made. Makes /reward
   * self-sufficient ({testId, idHash, amount} only): the derived-state
   * update reads these instead of requiring the caller to echo them.
   */
  alg: "ts" | "bucketed" | "linear";
  armCount: number;
  dim: number;
}

export type DerivedState =
  | { alg: "ts"; arms: ArmCounts[] }
  | {
      alg: "bucketed";
      global: ArmCounts[];
      buckets: Record<string, ArmCounts[]>;
    }
  | { alg: "linear"; dim: number; arms: LinearArmState[] };

export interface StateInit {
  alg: "ts" | "bucketed" | "linear";
  armCount: number;
  dim?: number;
  linearPriors?: LinearPrior[];
}

export function newDerivedState(init: StateInit): DerivedState {
  switch (init.alg) {
    case "ts":
      return { alg: "ts", arms: emptyCounts(init.armCount) };
    case "bucketed":
      return {
        alg: "bucketed",
        global: emptyCounts(init.armCount),
        buckets: {}
      };
    case "linear": {
      const dim = init.dim ?? FEATURE_DIM;
      return {
        alg: "linear",
        dim,
        arms: Array.from({ length: init.armCount }, (_, i) =>
          initLinearArm(dim, init.linearPriors?.[i])
        )
      };
    }
  }
}

/**
 * True when a record can be applied to this state. Records are written by
 * request handlers, so a stale or hostile armIndex must never crash a
 * replay: recompute is the creator's repair path and has to survive
 * anything already in the log.
 */
function appliesTo(state: DerivedState, armIndex: number): boolean {
  const armCount =
    state.alg === "bucketed" ? state.global.length : state.arms.length;
  return Number.isInteger(armIndex) && armIndex >= 0 && armIndex < armCount;
}

/**
 * Feature indices clamped to the model's dimension. An index past `dim`
 * reads undefined out of the matrix and silently turns the whole model
 * into NaN, so a record written under a different dim is dropped here
 * rather than poisoning the replay.
 */
function safeFeatIdx(dim: number, featIdx: number[] | null): number[] {
  const indices = (featIdx ?? [0]).filter(
    i => Number.isInteger(i) && i >= 0 && i < dim
  );
  return indices.length > 0 ? indices : [0];
}

/** Records a pull. Mutates state; callers own copy semantics. */
export function applyAssignment(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "armIndex" | "ctxKey" | "featIdx">
): void {
  if (!appliesTo(state, rec.armIndex)) {
    return;
  }
  switch (state.alg) {
    case "ts":
      state.arms[rec.armIndex].pulls += 1;
      return;
    case "bucketed": {
      state.global[rec.armIndex].pulls += 1;
      if (rec.ctxKey) {
        const bucket = (state.buckets[rec.ctxKey] ??= emptyCounts(
          state.global.length
        ));
        bucket[rec.armIndex].pulls += 1;
      }
      return;
    }
    case "linear":
      linearObserve(
        state.arms[rec.armIndex],
        safeFeatIdx(state.dim, rec.featIdx)
      );
      return;
  }
}

/** Records the FIRST reward for an assignment (later rewards only accumulate). */
export function applyFirstReward(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "armIndex" | "ctxKey" | "featIdx">
): void {
  if (!appliesTo(state, rec.armIndex)) {
    return;
  }
  switch (state.alg) {
    case "ts":
      state.arms[rec.armIndex].successes += 1;
      return;
    case "bucketed": {
      state.global[rec.armIndex].successes += 1;
      if (rec.ctxKey) {
        const bucket = (state.buckets[rec.ctxKey] ??= emptyCounts(
          state.global.length
        ));
        bucket[rec.armIndex].successes += 1;
      }
      return;
    }
    case "linear":
      linearReward(
        state.arms[rec.armIndex],
        safeFeatIdx(state.dim, rec.featIdx)
      );
      return;
  }
}

/**
 * Rebuilds derived state from the event log. Used when alg or linear
 * priors change mid-test and as the repair path for a corrupted cache.
 */
export function recomputeState(
  events: Iterable<AssignmentRecord>,
  init: StateInit
): DerivedState {
  const state = newDerivedState(init);
  const ordered = [...events].sort((a, b) => a.firstSeen - b.firstSeen);
  for (const rec of ordered) {
    applyAssignment(state, rec);
    if (rec.rewardTotal > 0) {
      applyFirstReward(state, rec);
    }
  }
  return state;
}

export interface ChooseInput {
  ctxKey?: string | null;
  featIdx?: number[] | null;
}

export interface ChooseOptions {
  armPriors?: ArmPrior[];
  bucketPriors?: Record<string, ArmPrior[]>;
  minBucketPulls?: number;
  noise?: number;
}

/** Dispatches a choice against the derived state for the given context. */
export function chooseArm(
  state: DerivedState,
  input: ChooseInput,
  options: ChooseOptions,
  rng: Rng
): number {
  switch (state.alg) {
    case "ts":
      return chooseThompson(state.arms, options.armPriors, rng);
    case "bucketed": {
      const bucket = input.ctxKey ? state.buckets[input.ctxKey] : undefined;
      return chooseBucketed(
        state.global,
        bucket,
        {
          minBucketPulls: options.minBucketPulls ?? 100,
          armPriors: options.armPriors,
          bucketPriors: input.ctxKey
            ? options.bucketPriors?.[input.ctxKey]
            : undefined
        },
        rng
      );
    }
    case "linear":
      return chooseLinear(
        state.arms,
        safeFeatIdx(state.dim, input.featIdx ?? null),
        rng,
        options.noise
      );
  }
}
