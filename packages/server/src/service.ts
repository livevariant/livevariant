import {
  bucketKey,
  applyExclusions,
  composeBucketKey,
  deriveAutoCtx,
  mergeFeatureIndices,
  recommendFromObserved,
  requestSignals,
  urlSignals,
  chooseArm,
  effectiveArmPriors,
  effectiveBucketPriors,
  effectiveLinearPriors,
  featureIndices,
  linearObserve,
  linearReward,
  newDerivedState,
  normalizeCtx,
  splitAutoDims,
  recomputeState,
  FEATURE_DIM,
  type ArmPrior,
  type AssignmentRecord,
  type DecodedConfig,
  type AlgorithmRecommendation,
  type CloudflareGeo,
  type DerivedState,
  type ExclusionPolicy,
  type RequestSignals,
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
  type StateStore,
  type TestPolicy
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
  /** Choose-path only (bucketed fallback threshold); rewards never read it. */
  minBucketPulls?: number;
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
  /** Opaque source bucket for the stats breakdown; null when unknown. */
  srcHash?: string | null;
  /** Coarse server-derived signals, stored readable for stats. */
  signals?: RequestSignals | null;
}

/** What the server can observe about a request, before any mapping. */
export interface RequestContext {
  geo?: CloudflareGeo | null;
  userAgent?: string;
  acceptLanguage?: string;
  /** True for proxied asset fetches, where geo is the proxy's, not a person's. */
  assetFetch?: boolean;
  /** True when the link itself opted out of derived context (?auto=0). */
  noAuto?: boolean;
  /** The request's query string, source of the campaign-tag signals. */
  query?: URLSearchParams | null;
}

/** Resolves raw request context into the opaque forms used everywhere else. */
export async function resolveIdentity(
  decoded: DecodedConfig,
  externalIdHashed: string | null,
  rawCtx: Record<string, string> | null,
  srcHash: string | null = null,
  request: RequestContext = {}
): Promise<RequestIdentity> {
  const ctx = normalizeCtx(decoded.config, rawCtx);
  // Signals come in two kinds and only one of them can be wrong here.
  //
  // Network signals are guessed from the connection, so a mail provider
  // or a link scanner fetching on someone's behalf answers all of them
  // about itself. Those are dropped for a proxied fetch, and for a link
  // that said outright it is going somewhere unreadable (?auto=0).
  //
  // Campaign tags are read off the URL the sender wrote, so a proxy
  // relays them untouched. They are as true for Gmail's fetcher as for
  // the reader, which makes them the one kind of derived context that
  // works properly in email, so nothing suppresses them.
  const network =
    request.assetFetch || request.noAuto ? {} : requestSignals(request);
  const signals = { ...network, ...urlSignals(request.query) };
  const autoCtx = deriveAutoCtx(decoded.config.ctx?.dims, signals, ctx);
  // Auto dimensions are composed on top of the caller's key even when the
  // caller supplied them, so supplied and derived values of the same
  // dimension share a bucket instead of splitting the test in half.
  const callerCtx = splitAutoDims(decoded.config.ctx?.dims, ctx);
  const callerKey = callerCtx
    ? await bucketKey(decoded.testId, callerCtx)
    : null;
  return {
    idHash: externalIdHashed,
    ctxKey: await composeBucketKey(decoded.testId, callerKey, autoCtx),
    featIdx: mergeFeatureIndices(featureIndices(callerCtx), autoCtx),
    srcHash,
    signals
  };
}

const CAS_RETRIES = 5;

/** The creator's quarantine list, in the shape core expects. */
function exclusionsFrom(policy: TestPolicy): ExclusionPolicy {
  return {
    excludedSources: policy.excludedSources,
    excludedWindows: policy.excludedWindows
  };
}

/**
 * The whole-operation surface the HTTP layer talks to. TestService is the
 * in-process implementation over a StateStore; the Cloudflare deployment
 * implements it as RPC into the test's Durable Object, so one serving
 * request is one round-trip instead of one per storage primitive.
 */
export interface TestBackend {
  checkShape(params: ServingParams, authoritative: boolean): Promise<boolean>;
  assign(
    params: ServingParams,
    identity: RequestIdentity
  ): Promise<{ armIndex: number; created: boolean }>;
  reward(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ armIndex: number; first: boolean } | null>;
  recompute(params: ServingParams): Promise<number>;
  stats(params: ServingParams, armNames?: string[]): Promise<TestStats>;
  /** Creator-authorized quarantine; returns the merged policy. */
  updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy>;
}

export class TestService implements TestBackend {
  constructor(
    private store: StateStore,
    private rng: Rng
  ) {}

  /** Stats from the event log, with the cap policy applied. */
  async stats(params: ServingParams, armNames?: string[]): Promise<TestStats> {
    return buildStats(this.store, params, armNames);
  }

  /** Creator-authorized quarantine; the caller checks the stats secret. */
  updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy> {
    return this.store.updatePolicy(testId, patch);
  }

  /**
   * Pins the shape a test is first served with. JS-mode callers declare
   * armCount/alg/dim themselves and testIds are public, so a later caller
   * claiming a different shape is rejected here rather than writing
   * records the real config cannot represent.
   */
  async checkShape(
    params: ServingParams,
    authoritative = false
  ): Promise<boolean> {
    const pinned = await this.store.pinShape(
      params.testId,
      {
        armCount: params.armCount,
        alg: params.alg,
        dim: params.dim
      },
      authoritative
    );
    return (
      pinned.armCount === params.armCount &&
      pinned.alg === params.alg &&
      pinned.dim === params.dim
    );
  }

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
      firstSeen: Date.now(),
      // Serving snapshot: lets /reward run from the record alone.
      alg: params.alg,
      armCount: params.armCount,
      dim: params.dim,
      srcHash: identity.srcHash ?? null,
      signals: identity.signals ?? null
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

  /**
   * Accumulates reward; only the first per assignment touches the cache.
   * Needs no serving params: the assignment record carries its own
   * serving snapshot, so callers (SDK, pixel, handoff rewards) send just
   * testId + idHash + amount.
   */
  async reward(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ armIndex: number; first: boolean } | null> {
    const result = await this.store.addReward(testId, idHash, amount);
    if (!result) {
      return null;
    }
    // Records written before the serving-snapshot fields existed can't
    // update the cache here; a recompute reconciles them.
    if (result.first && result.rec.alg !== undefined) {
      const rec = result.rec;
      await this.recordFirstReward(
        { testId, armCount: rec.armCount, alg: rec.alg, dim: rec.dim },
        rec
      );
    }
    return { armIndex: result.rec.armIndex, first: result.first };
  }

  /** Rebuilds the derived cache from the event log (alg changes, repair). */
  async recompute(params: ServingParams): Promise<number> {
    const all: AssignmentRecord[] = [];
    for await (const rec of this.store.scanAssignments(params.testId)) {
      all.push(rec);
    }
    const policy = await this.store.getPolicy(params.testId);
    // Exclusions are applied here, so they heal history: a test attacked
    // before a source was quarantined is cleaned up by recomputing.
    const events = applyExclusions(all, exclusionsFrom(policy)).applied;
    const state = recomputeState(events, {
      alg: params.alg,
      armCount: params.armCount,
      dim: params.dim,
      linearPriors: params.linearPriors
    });
    await this.store.replaceDerived(params.testId, state);
    return all.length;
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
      pullDelta(armCount, rec.armIndex)
    );
    if (params.alg === "bucketed" && rec.ctxKey) {
      await this.store.incrCounters(
        counterKey(testId, rec.ctxKey),
        pullDelta(armCount, rec.armIndex)
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
  /** What the creator's quarantine removed, so the numbers are auditable. */
  excluded: {
    total: number;
    bySource: number;
    byWindow: number;
  };
  /** Assignment count per opaque source bucket, before exclusions. */
  perSource: Record<string, number>;
  /**
   * Pulls and conversions per derived signal value, e.g.
   * { country: { nl: {...}, de: {...} }, device: { mobile: {...} } }.
   * Recorded for every signal, not only those a test uses as context, so
   * a plain test still gets a legible breakdown.
   */
  bySignal: Record<
    string,
    Record<string, { pulls: number; conversions: number }>
  >;
  /**
   * Advice based on what this test actually saw, not what it declared.
   * Null when the current algorithm still fits. Acting on it is a config
   * edit plus a recompute: `alg` is outside the identity hash, so the
   * test keeps its id and its history.
   */
  suggestion: AlgorithmRecommendation | null;
}

/** Aggregates stats straight from the event log (the source of truth). */
export async function buildStats(
  store: StateStore,
  params: ServingParams,
  armNames?: string[]
): Promise<TestStats> {
  const all: AssignmentRecord[] = [];
  for await (const rec of store.scanAssignments(params.testId)) {
    all.push(rec);
  }
  const kept = applyExclusions(
    all,
    exclusionsFrom(await store.getPolicy(params.testId))
  );
  const arms: ArmStats[] = Array.from({ length: params.armCount }, (_, i) => ({
    name: armNames?.[i],
    pulls: 0,
    conversions: 0,
    rewardTotal: 0,
    conversionRate: null
  }));
  const buckets: TestStats["buckets"] = {};
  const bySignal: TestStats["bySignal"] = {};
  let total = 0;
  for (const rec of kept.applied) {
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
    for (const [signal, value] of Object.entries(rec.signals ?? {})) {
      const perValue = (bySignal[signal] ??= {});
      const entry = (perValue[value] ??= { pulls: 0, conversions: 0 });
      entry.pulls++;
      if (rec.rewardTotal > 0) {
        entry.conversions++;
      }
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
    buckets,
    bySignal,
    excluded: kept.excluded,
    perSource: kept.perSource,
    suggestion: recommendFromObserved({
      alg: params.alg,
      bucketCount: Object.keys(buckets).length,
      totalAssignments: total,
      minBucketPulls: params.minBucketPulls
    })
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
