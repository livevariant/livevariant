import {
  applyFirstReward,
  bucketKey,
  chooseArm,
  effectiveArmPriors,
  effectiveBucketPriors,
  effectiveLinearPriors,
  featureIndices,
  linearObserve,
  linearReward,
  newDerivedState,
  normalizeCtx,
  recomputeState,
  FEATURE_DIM,
  type ArmPrior,
  type AssignmentRecord,
  type DecodedConfig,
  type DerivedState,
  type LinearPrior,
  type Rng
} from "@livevariant/core";
import {
  arrayToCounts,
  blobToLinearState,
  pullDelta,
  successDelta
} from "./store/snapshot.js";
import {
  counterKey,
  GLOBAL_SCOPE,
  linearKey,
  type StateStore
} from "./store/types.js";

/**
 * The serving logic both modes share. Redirect mode derives ServingParams
 * from the full config; JS mode receives them directly in the request
 * body (which is how the server serves /choose without ever seeing
 * variant content).
 */
export interface ServingParams {
  testId: string;
  armCount: number;
  alg: "ts" | "bucketed" | "linear";
  dim: number;
  minBucketPulls: number;
  armPriors?: ArmPrior[];
  bucketPriors?: Record<string, ArmPrior[]>;
  linearPriors?: LinearPrior[];
  noise?: number;
}

export async function paramsFromConfig(
  decoded: DecodedConfig
): Promise<ServingParams> {
  const { config, testId } = decoded;
  return {
    testId,
    armCount: config.arms.length,
    alg: config.alg,
    dim: FEATURE_DIM,
    minBucketPulls: config.minBucketPulls,
    armPriors: effectiveArmPriors(config),
    bucketPriors: await effectiveBucketPriors(config, testId),
    linearPriors: effectiveLinearPriors(config)
  };
}

export interface RequestIdentity {
  idHash: string | null;
  ctxKey: string | null;
  featIdx: number[];
}

/** Resolves raw request context into the opaque forms used everywhere else. */
export async function resolveIdentity(
  decoded: DecodedConfig,
  externalIdHashed: string | null,
  rawCtx: Record<string, string> | null
): Promise<RequestIdentity> {
  const ctx = normalizeCtx(decoded.config, rawCtx);
  return {
    idHash: externalIdHashed,
    ctxKey: ctx ? await bucketKey(decoded.testId, ctx) : null,
    featIdx: featureIndices(ctx)
  };
}

const CAS_RETRIES = 5;

export class TestService {
  constructor(
    private store: StateStore,
    private rng: Rng
  ) {}

  /**
   * Sticky assignment: an existing record always wins; otherwise the
   * bandit picks, the record is written (id'd traffic only), and the
   * derived cache is updated exactly once even under races.
   */
  async assign(
    params: ServingParams,
    identity: RequestIdentity
  ): Promise<{ armIndex: number; created: boolean }> {
    const { idHash } = identity;
    if (idHash) {
      const existing = await this.store.getAssignment(params.testId, idHash);
      if (existing) {
        return { armIndex: existing.armIndex, created: false };
      }
    }

    const state = await this.loadState(params, identity.ctxKey);
    const armIndex = chooseArm(
      state,
      { ctxKey: identity.ctxKey, featIdx: identity.featIdx },
      {
        armPriors: params.armPriors,
        bucketPriors: params.bucketPriors,
        minBucketPulls: params.minBucketPulls,
        noise: params.noise
      },
      this.rng
    );

    if (!idHash) {
      // Anonymous traffic gets a choice but no record: it can never be
      // rewarded, so counting its pulls would only dilute the estimates.
      return { armIndex, created: false };
    }

    const rec: AssignmentRecord = {
      armIndex,
      ctxKey: identity.ctxKey,
      featIdx: identity.featIdx,
      rewardTotal: 0,
      firstSeen: Date.now()
    };
    const result = await this.store.putAssignmentIfAbsent(
      params.testId,
      idHash,
      rec
    );
    if (!result.created) {
      // Lost a same-id race; the winner's arm is authoritative and the
      // winner's request already updated the cache.
      return { armIndex: result.rec.armIndex, created: false };
    }
    await this.recordPull(params, rec);
    return { armIndex, created: true };
  }

  /** Accumulates reward; only the first per assignment touches the cache. */
  async reward(
    params: ServingParams,
    idHash: string,
    amount: number
  ): Promise<{ armIndex: number; first: boolean } | null> {
    const result = await this.store.addReward(params.testId, idHash, amount);
    if (!result) {
      return null;
    }
    if (result.first) {
      await this.recordFirstReward(params, result.rec);
    }
    return { armIndex: result.rec.armIndex, first: result.first };
  }

  /** Rebuilds the derived cache from the event log (alg changes, repair). */
  async recompute(params: ServingParams): Promise<number> {
    const events: AssignmentRecord[] = [];
    for await (const rec of this.store.scanAssignments(params.testId)) {
      events.push(rec);
    }
    const state = recomputeState(events, {
      alg: params.alg,
      armCount: params.armCount,
      dim: params.dim,
      linearPriors: params.linearPriors
    });
    await this.store.replaceDerived(params.testId, state);
    return events.length;
  }

  private async loadState(
    params: ServingParams,
    ctxKey: string | null
  ): Promise<DerivedState> {
    const { testId, armCount } = params;
    switch (params.alg) {
      case "ts": {
        const flat = await this.store.getCounters(
          counterKey(testId, GLOBAL_SCOPE),
          armCount * 2
        );
        return { alg: "ts", arms: arrayToCounts(flat, armCount) };
      }
      case "bucketed": {
        const globalFlat = await this.store.getCounters(
          counterKey(testId, GLOBAL_SCOPE),
          armCount * 2
        );
        const buckets: Record<string, ReturnType<typeof arrayToCounts>> = {};
        if (ctxKey) {
          const bucketFlat = await this.store.getCounters(
            counterKey(testId, ctxKey),
            armCount * 2
          );
          buckets[ctxKey] = arrayToCounts(bucketFlat, armCount);
        }
        return {
          alg: "bucketed",
          global: arrayToCounts(globalFlat, armCount),
          buckets
        };
      }
      case "linear":
        return this.loadLinearState(params);
    }
  }

  private async loadLinearState(
    params: ServingParams
  ): Promise<Extract<DerivedState, { alg: "linear" }>> {
    const blob = await this.store.getBlob(linearKey(params.testId));
    if (blob) {
      return blobToLinearState(blob.data);
    }
    return newDerivedState({
      alg: "linear",
      armCount: params.armCount,
      dim: params.dim,
      linearPriors: params.linearPriors
    }) as Extract<DerivedState, { alg: "linear" }>;
  }

  private async recordPull(
    params: ServingParams,
    rec: AssignmentRecord
  ): Promise<void> {
    const { testId, armCount } = params;
    if (params.alg === "linear") {
      await this.updateLinearWithRetry(params, state =>
        linearObserve(state.arms[rec.armIndex], rec.featIdx ?? [0])
      );
      return;
    }
    await this.store.incrCounters(
      counterKey(testId, GLOBAL_SCOPE),
      pullDelta(armCount, rec.armIndex, false)
    );
    if (params.alg === "bucketed" && rec.ctxKey) {
      await this.store.incrCounters(
        counterKey(testId, rec.ctxKey),
        pullDelta(armCount, rec.armIndex, false)
      );
    }
  }

  private async recordFirstReward(
    params: ServingParams,
    rec: AssignmentRecord
  ): Promise<void> {
    const { testId, armCount } = params;
    if (params.alg === "linear") {
      await this.updateLinearWithRetry(params, state =>
        linearReward(state.arms[rec.armIndex], rec.featIdx ?? [0])
      );
      return;
    }
    await this.store.incrCounters(
      counterKey(testId, GLOBAL_SCOPE),
      successDelta(armCount, rec.armIndex)
    );
    if (params.alg === "bucketed" && rec.ctxKey) {
      await this.store.incrCounters(
        counterKey(testId, rec.ctxKey),
        successDelta(armCount, rec.armIndex)
      );
    }
  }

  /**
   * Linear state is a read-modify-write blob behind CAS. On persistent
   * conflict the update is dropped: the cache self-heals on the next
   * recompute, and losing one observation is preferable to blocking the
   * serving path.
   */
  private async updateLinearWithRetry(
    params: ServingParams,
    mutate: (state: Extract<DerivedState, { alg: "linear" }>) => void
  ): Promise<void> {
    const key = linearKey(params.testId);
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const blob = await this.store.getBlob(key);
      const state = blob
        ? blobToLinearState(blob.data)
        : (newDerivedState({
            alg: "linear",
            armCount: params.armCount,
            dim: params.dim,
            linearPriors: params.linearPriors
          }) as Extract<DerivedState, { alg: "linear" }>);
      mutate(state);
      const ok = await this.store.putBlob(
        key,
        JSON.stringify({ dim: state.dim, arms: state.arms }),
        blob?.version ?? 0
      );
      if (ok) {
        return;
      }
    }
  }
}

export interface ArmStats {
  name?: string;
  pulls: number;
  conversions: number;
  rewardTotal: number;
  conversionRate: number | null;
}

export interface TestStats {
  testId: string;
  alg: string;
  totalAssignments: number;
  arms: ArmStats[];
  buckets: Record<string, { pulls: number[]; conversions: number[] }>;
  linearTheta?: number[][];
}

/** Aggregates stats straight from the event log (the source of truth). */
export async function buildStats(
  store: StateStore,
  params: ServingParams,
  armNames?: string[]
): Promise<TestStats> {
  const arms: ArmStats[] = Array.from({ length: params.armCount }, (_, i) => ({
    name: armNames?.[i],
    pulls: 0,
    conversions: 0,
    rewardTotal: 0,
    conversionRate: null
  }));
  const buckets: TestStats["buckets"] = {};
  let total = 0;
  for await (const rec of store.scanAssignments(params.testId)) {
    total++;
    const arm = arms[rec.armIndex];
    if (!arm) {
      continue; // record from an older arm list; recompute will drop it
    }
    arm.pulls++;
    if (rec.rewardTotal > 0) {
      arm.conversions++;
      arm.rewardTotal += rec.rewardTotal;
    }
    if (rec.ctxKey) {
      const bucket = (buckets[rec.ctxKey] ??= {
        pulls: new Array<number>(params.armCount).fill(0),
        conversions: new Array<number>(params.armCount).fill(0)
      });
      bucket.pulls[rec.armIndex]++;
      if (rec.rewardTotal > 0) {
        bucket.conversions[rec.armIndex]++;
      }
    }
  }
  for (const arm of arms) {
    arm.conversionRate = arm.pulls > 0 ? arm.conversions / arm.pulls : null;
  }

  const stats: TestStats = {
    testId: params.testId,
    alg: params.alg,
    totalAssignments: total,
    arms,
    buckets
  };
  if (params.alg === "linear") {
    const blob = await store.getBlob(linearKey(params.testId));
    if (blob) {
      const state = blobToLinearState(blob.data);
      stats.linearTheta = state.arms.map(({ aInv, b }) =>
        aInv.map(row => row.reduce((sum, cell, j) => sum + cell * b[j], 0))
      );
    }
  }
  return stats;
}
