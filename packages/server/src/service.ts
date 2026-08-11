import {
  applyExclusions,
  bucketKey,
  cellCount,
  choose,
  composeBucketKey,
  decodeCell,
  deriveAutoCtx,
  deriveResolvedCtx,
  dimForShape,
  effectivePriors,
  featureIndices,
  marginalOutcomes,
  mergeFeatureIndices,
  newDerivedState,
  normalizeCtx,
  observe,
  recomputeState,
  requestSignals,
  reward as modelReward,
  slotEntries,
  slotSizes as configSlotSizes,
  splitAutoDims,
  urlSignals,
  validCell,
  variantName,
  enumerateBucketLabels,
  labelBucketsFromSignals,
  type AssignmentRecord,
  type CloudflareGeo,
  type CtxDim,
  type DecodedConfig,
  type DerivedState,
  type ExclusionPolicy,
  type JointModel,
  type RequestSignals,
  type Rng,
  type TestRegion,
  type VariantPrior
} from "@livevariant/core";
import {
  arrayToCounts,
  blobToModel,
  modelToBlob,
  pullDelta,
  successDelta,
  type ModelBlob
} from "./store/snapshot.js";
import { ModelCache } from "./store/model-cache.js";
import {
  counterKey,
  GLOBAL_SCOPE,
  modelKey,
  sameShape,
  type StateStore,
  type TestPolicy
} from "./store/types.js";
import type { ResolveCtxFn } from "./ctx-resolver.js";
import type {
  CombinationStats,
  TestStats,
  VariantStats
} from "@livevariant/core";

export type { CombinationStats, TestStats, VariantStats };

/**
 * The serving logic both modes share. Redirect mode derives ServingParams
 * from the full config; JS mode receives them directly in the request
 * body (which is how the server serves /choose without ever seeing
 * variant content). There is no algorithm to name anywhere here: every
 * test runs the one joint model, and these params are just its shape.
 */
export interface ServingParams {
  testId: string;
  /** Variant counts per slot, canonical (sorted-key) order. */
  slotSizes: number[];
  /**
   * Model dimension; the SAME sizing on both ends, or the page and the server
   * hash features into different spaces and neither can read the other's
   * records.
   */
  dim: number;
  priors?: VariantPrior[];
  noise?: number;
  /**
   * Where the test's state lives (config.region). The Cloudflare
   * backend routes on it: a location hint places the Durable Object,
   * and "eu" addresses the EU-jurisdiction object, which is a different
   * object than the plain testId would reach. In-process backends
   * ignore it.
   */
  region?: TestRegion;
}

export function paramsFromConfig(decoded: DecodedConfig): ServingParams {
  const { config, testId } = decoded;
  const sizes = configSlotSizes(config);
  // Cardinality-aware sizing, and this REPLACED a flat per-dimension estimate
  // rather than being added beside it. dim is recomputed from the config on
  // every serve while featIdx is hashed modulo it and stored per record, so a
  // test that was serving under the old sizing has a model that now misreads
  // its own history. That was a deliberate call (livevariant#55): nothing was
  // running on it, and carrying a sizing version forever to protect tests that
  // do not exist is machinery nobody would ever set.
  const dim = dimForShape(sizes, config.ctx?.dims ?? []);
  return {
    testId,
    slotSizes: sizes,
    dim,
    priors: effectivePriors(config, dim),
    region: config.region
  };
}

/** Per-slot variant display names, for stats and URL stamps. */
export function labelsFromConfig(
  decoded: DecodedConfig
): Array<{ key: string; variants: string[] }> {
  return slotEntries(decoded.config).map(([key, variants]) => ({
    key,
    variants: variants.map((v, i) => variantName(v, i))
  }));
}

export interface RequestIdentity {
  idHash: string | null;
  ctxKey: string | null;
  /** Context feature indices only; the full set is derived at choose time. */
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
  dim: number,
  externalIdHashed: string | null,
  rawCtx: Record<string, string> | null,
  srcHash: string | null = null,
  request: RequestContext = {},
  resolveCtx?: ResolveCtxFn
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
  const networkSignalsSuppressed = Boolean(
    request.assetFetch || request.noAuto
  );
  const network = networkSignalsSuppressed ? {} : requestSignals(request);
  const signals = { ...network, ...urlSignals(request.query) };
  const dims = decoded.config.ctx?.dims;
  const autoCtx = deriveAutoCtx(dims, signals, ctx);
  // Dimensions the config asks the deployment to look up. This is the one
  // place raw context is still readable, and the answer is all that
  // survives into the hashes below.
  const needsResolving = dims?.some(d => d.resolve) ?? false;
  if (needsResolving && resolveCtx) {
    const resolved = await resolveCtx({
      dims: dims ?? [],
      raw: rawCtx ?? {},
      signals,
      networkSignalsSuppressed
    });
    Object.assign(autoCtx, deriveResolvedCtx(dims, resolved, ctx));
  }
  // Auto dimensions are composed on top of the caller's key even when the
  // caller supplied them, so supplied and derived values of the same
  // dimension share a bucket instead of splitting the test in half.
  const callerCtx = splitAutoDims(dims, ctx);
  const callerKey = callerCtx
    ? await bucketKey(decoded.testId, callerCtx)
    : null;
  return {
    idHash: externalIdHashed,
    ctxKey: await composeBucketKey(decoded.testId, callerKey, autoCtx),
    featIdx: mergeFeatureIndices(featureIndices(callerCtx, dim), autoCtx, dim),
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
    identity: RequestIdentity,
    meta?: { sdk?: string }
  ): Promise<{ cell: number; created: boolean }>;
  /**
   * Region rides along because reward is deliberately config-free: the
   * SDK, the pixel and the handoff know it, and without it an "eu"
   * test's rewards would route to the wrong object.
   */
  reward(
    testId: string,
    idHash: string,
    amount: number,
    region?: TestRegion,
    /** Sender's SDK version; stored (or backfilled) on the record. */
    sdk?: string
  ): Promise<{ cell: number; first: boolean } | null>;
  recompute(params: ServingParams): Promise<number>;
  updatePolicy(
    testId: string,
    patch: TestPolicy,
    region?: TestRegion
  ): Promise<TestPolicy>;
  stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>,
    ctxDims?: CtxDim[]
  ): Promise<TestStats>;
}

export class TestService implements TestBackend {
  /**
   * The cache is per-service by default, which is exactly right for the
   * Node server (one service for the process lifetime). The Durable
   * Object constructs a service per RPC and therefore passes its own
   * long-lived cache in.
   */
  constructor(
    private store: StateStore,
    private rng: Rng,
    private modelCache: ModelCache = new ModelCache()
  ) {}

  /** Stats from the event log, with the cap policy applied. */
  async stats(
    params: ServingParams,
    labels?: Array<{ key: string; variants: string[] }>,
    ctxDims?: CtxDim[]
  ): Promise<TestStats> {
    return buildStats(this.store, params, labels, ctxDims);
  }

  /** Creator-authorized quarantine; the caller checks the stats secret. */
  updatePolicy(
    testId: string,
    patch: TestPolicy,
    _region?: TestRegion
  ): Promise<TestPolicy> {
    return this.store.updatePolicy(testId, patch);
  }

  /**
   * Pins the shape a test is first served with. JS-mode callers declare
   * slotSizes/dim themselves and testIds are public, so a later caller
   * claiming a different shape is rejected here rather than writing
   * records the real config cannot represent.
   */
  async checkShape(
    params: ServingParams,
    authoritative = false
  ): Promise<boolean> {
    const shape = { slotSizes: params.slotSizes, dim: params.dim };
    const pinned = await this.store.pinShape(
      params.testId,
      shape,
      authoritative
    );
    return sameShape(pinned, shape);
  }

  /**
   * Sticky assignment: an existing record always wins; otherwise the
   * model picks a combination, the record is written (id'd traffic only),
   * and the derived cache is updated exactly once even under races.
   */
  async assign(
    params: ServingParams,
    identity: RequestIdentity,
    meta?: { sdk?: string }
  ): Promise<{ cell: number; created: boolean }> {
    const { idHash } = identity;
    if (idHash) {
      const existing = await this.store.getAssignment(params.testId, idHash);
      if (existing) {
        return { cell: existing.cell, created: false };
      }
    }

    const state = await this.loadState(params);
    const { cell, featIdx } = choose(
      state,
      identity.featIdx,
      this.rng,
      params.noise
    );

    if (!idHash) {
      // Anonymous traffic gets a choice but no record: it can never be
      // rewarded, so counting its pulls would only dilute the estimates.
      return { cell, created: false };
    }

    const rec: AssignmentRecord = {
      cell,
      // Serving snapshot: the cell's coordinate system and the model's
      // dimension at serve time, so /reward and replay run from the
      // record alone and never re-derive hashing.
      slotSizes: params.slotSizes,
      dim: params.dim,
      featIdx,
      ctxKey: identity.ctxKey,
      rewardTotal: 0,
      firstSeen: Date.now(),
      srcHash: identity.srcHash ?? null,
      signals: identity.signals ?? null,
      sdk: meta?.sdk ?? null
    };
    const result = await this.store.putAssignmentIfAbsent(
      params.testId,
      idHash,
      rec
    );
    if (!result.created) {
      // Lost a same-id race; the winner's cell is authoritative and the
      // winner's request already updated the cache.
      return { cell: result.rec.cell, created: false };
    }
    await this.recordPull(params, rec);
    return { cell, created: true };
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
    amount: number,
    _region?: TestRegion,
    sdk?: string
  ): Promise<{ cell: number; first: boolean } | null> {
    const result = await this.store.addReward(testId, idHash, amount, sdk);
    if (!result) {
      return null;
    }
    if (result.first) {
      const rec = result.rec;
      await this.recordFirstReward(
        { testId, slotSizes: rec.slotSizes, dim: rec.dim },
        rec
      );
    }
    return { cell: result.rec.cell, first: result.first };
  }

  /** Rebuilds the derived cache from the event log (prior changes, repair). */
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
      slotSizes: params.slotSizes,
      dim: params.dim,
      priors: params.priors
    });
    await this.store.replaceDerived(params.testId, state);
    return all.length;
  }

  private async loadState(params: ServingParams): Promise<DerivedState> {
    const cells = cellCount(params.slotSizes);
    const flat = await this.store.getCounters(
      counterKey(params.testId, GLOBAL_SCOPE),
      cells * 2
    );
    return {
      slotSizes: params.slotSizes,
      dim: params.dim,
      cells: arrayToCounts(flat, cells),
      model: (await this.loadModel(params)).model
    };
  }

  /**
   * ONE read supplies both the model and the version its CAS write must
   * present. Reading them separately opens a window where a concurrent
   * writer bumps the version between the two reads, making every
   * subsequent putBlob fail as stale without any genuine conflict, which
   * under sustained traffic burns the whole retry budget on phantom
   * races and silently drops the observation.
   */
  private async loadModel(
    params: ServingParams
  ): Promise<{ model: JointModel; version: number }> {
    const blob = await this.store.getBlob(modelKey(params.testId));
    if (!blob) {
      return { model: this.freshModel(params), version: 0 };
    }
    // The cache skips the decode, the biggest CPU term at large dims.
    // Keyed by version, so it can never serve a stale model; missing is
    // always safe, just slower.
    const stored =
      this.modelCache.get(params.testId, blob.version) ??
      this.decodeAndCache(params.testId, blob);
    // A blob written under another shape indexes different features;
    // shape pinning makes this unreachable in normal operation, so a
    // mismatch (or an undecodable blob) means corruption and a fresh
    // model is the safe answer (a recompute rebuilds the real one from
    // the log).
    if (
      stored &&
      stored.dim === params.dim &&
      stored.slotSizes.length === params.slotSizes.length &&
      stored.slotSizes.every((n, i) => n === params.slotSizes[i])
    ) {
      return { model: stored.model, version: blob.version };
    }
    return { model: this.freshModel(params), version: blob.version };
  }

  private decodeAndCache(
    testId: string,
    blob: { data: string; version: number }
  ): ModelBlob | null {
    try {
      const decoded = blobToModel(blob.data);
      this.modelCache.set(testId, blob.version, decoded);
      return decoded;
    } catch {
      return null;
    }
  }

  private freshModel(params: ServingParams): JointModel {
    return newDerivedState({
      slotSizes: params.slotSizes,
      dim: params.dim,
      priors: params.priors
    }).model;
  }

  /**
   * A record's stored features, bounded to the model's dimension. An
   * index past `dim` reads undefined out of the matrix and turns the
   * whole model into NaN, so hostile or stale indices are dropped.
   */
  private safeFeatIdx(dim: number, featIdx: number[] | null): number[] {
    const indices = (featIdx ?? [0]).filter(
      i => Number.isInteger(i) && i >= 0 && i < dim
    );
    return indices.length > 0 ? indices : [0];
  }

  private async recordPull(
    params: ServingParams,
    rec: AssignmentRecord
  ): Promise<void> {
    await this.store.incrCounters(
      counterKey(params.testId, GLOBAL_SCOPE),
      pullDelta(cellCount(params.slotSizes), rec.cell)
    );
    await this.updateModelWithRetry(params, model =>
      observe(model, this.safeFeatIdx(params.dim, rec.featIdx))
    );
  }

  private async recordFirstReward(
    params: ServingParams,
    rec: AssignmentRecord
  ): Promise<void> {
    await this.store.incrCounters(
      counterKey(params.testId, GLOBAL_SCOPE),
      successDelta(cellCount(params.slotSizes), rec.cell)
    );
    await this.updateModelWithRetry(params, model =>
      modelReward(model, this.safeFeatIdx(params.dim, rec.featIdx))
    );
  }

  /**
   * Model state is a read-modify-write blob behind CAS. On persistent
   * conflict the update is dropped: the cache self-heals on the next
   * recompute, and losing one observation is preferable to blocking the
   * serving path.
   */
  private async updateModelWithRetry(
    params: ServingParams,
    mutate: (model: JointModel) => void
  ): Promise<void> {
    const key = modelKey(params.testId);
    for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
      const { model, version } = await this.loadModel(params);
      mutate(model);
      const ok = await this.store.putBlob(
        key,
        modelToBlob({ slotSizes: params.slotSizes, dim: params.dim, model }),
        version
      );
      if (ok) {
        // Write-through: both stores bump the version by one on success,
        // so the next request decodes nothing. If an exotic adapter
        // versions differently the entry simply never matches, which is
        // a miss, not a wrong answer.
        this.modelCache.set(params.testId, version + 1, {
          slotSizes: params.slotSizes,
          dim: params.dim,
          model
        });
        return;
      }
    }
  }
}

/** Aggregates stats straight from the event log (the source of truth). */
export async function buildStats(
  store: StateStore,
  params: ServingParams,
  labels?: Array<{ key: string; variants: string[] }>,
  ctxDims?: CtxDim[]
): Promise<TestStats> {
  const all: AssignmentRecord[] = [];
  for await (const rec of store.scanAssignments(params.testId)) {
    all.push(rec);
  }
  const kept = applyExclusions(
    all,
    exclusionsFrom(await store.getPolicy(params.testId))
  );
  const cells = cellCount(params.slotSizes);
  const outcomes = Array.from({ length: cells }, () => ({
    pulls: 0,
    conversions: 0,
    rewardTotal: 0
  }));
  const buckets: TestStats["buckets"] = {};
  const bySignal: TestStats["bySignal"] = {};
  let total = 0;
  for (const rec of kept.applied) {
    total++;
    if (!validCell(params.slotSizes, rec.cell)) {
      continue; // record from an older shape; recompute will drop it
    }
    const outcome = outcomes[rec.cell];
    outcome.pulls++;
    if (rec.rewardTotal > 0) {
      outcome.conversions++;
      outcome.rewardTotal += rec.rewardTotal;
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
        pulls: new Array<number>(cells).fill(0),
        conversions: new Array<number>(cells).fill(0)
      });
      bucket.pulls[rec.cell]++;
      if (rec.rewardTotal > 0) {
        bucket.conversions[rec.cell]++;
      }
    }
  }

  if (ctxDims && Object.keys(buckets).length > 0) {
    // Readable names for the opaque bucket keys, recovered by hashing
    // every enumerable context and matching; never guessed.
    const bucketNames = await enumerateBucketLabels(params.testId, ctxDims);
    // Then the same thing from the other end, for the dimensions the
    // enumeration cannot reach: a signal-filled dimension rarely declares
    // its `values`, so its buckets would stay hashed forever while the very
    // same values print readable under audience signals. Both paths only
    // attach a label the hash agrees with.
    const fromSignals = await labelBucketsFromSignals(
      params.testId,
      ctxDims,
      kept.applied
    );
    for (const [key, bucket] of Object.entries(buckets)) {
      const label = bucketNames.get(key) ?? fromSignals.get(key);
      if (label !== undefined) {
        bucket.label = label;
      }
    }
  }

  const slotLabels =
    labels ??
    params.slotSizes.map((size, i) => ({
      key: params.slotSizes.length === 1 ? "main" : `slot${i}`,
      variants: Array.from({ length: size }, (_, v) => `v${v + 1}`)
    }));

  const combinations: CombinationStats[] = outcomes.map((outcome, cell) => {
    const choice = decodeCell(params.slotSizes, cell);
    return {
      cell,
      choice: choice.map(
        (v, slot) => slotLabels[slot]?.variants[v] ?? `v${v + 1}`
      ),
      ...outcome,
      conversionRate:
        outcome.pulls > 0 ? outcome.conversions / outcome.pulls : null
    };
  });

  const slots: TestStats["slots"] = {};
  for (let slot = 0; slot < params.slotSizes.length; slot++) {
    const marginal = marginalOutcomes(outcomes, params.slotSizes, slot);
    slots[slotLabels[slot].key] = marginal.map((m, v) => ({
      name: slotLabels[slot].variants[v] ?? `v${v + 1}`,
      pulls: m.pulls,
      conversions: m.conversions,
      conversionRate: m.pulls > 0 ? m.conversions / m.pulls : null
    }));
  }

  return {
    testId: params.testId,
    totalAssignments: total,
    combinations,
    slots,
    buckets,
    bySignal,
    excluded: kept.excluded,
    perSource: kept.perSource
  };
}
