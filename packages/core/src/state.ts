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

/** Records a pull. Mutates state; callers own copy semantics. */
export function applyAssignment(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "armIndex" | "ctxKey" | "featIdx">
): void {
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
      linearObserve(state.arms[rec.armIndex], rec.featIdx ?? [0]);
      return;
  }
}

/** Records the FIRST reward for an assignment (later rewards only accumulate). */
export function applyFirstReward(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "armIndex" | "ctxKey" | "featIdx">
): void {
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
      linearReward(state.arms[rec.armIndex], rec.featIdx ?? [0]);
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
      return chooseLinear(state.arms, input.featIdx ?? [0], rng, options.noise);
  }
}
