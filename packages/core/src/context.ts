import { canonicalJson, fnv1a32, sha256Hex } from "./canonical.js";
import type { CtxDim, TestConfig } from "./schema.js";
import type { RequestSignals } from "./signals.js";

/**
 * Context handling. Raw context values ("country=NL") exist only at the
 * edge of the system: what gets stored and what the bandits see are the
 * derived forms below (an opaque bucket key and small hashed feature
 * indices), which is what keeps the privacy-by-minimization claim true.
 */

/** Feature-vector dimension for the linear bandit: slot 0 is the bias. */
export const FEATURE_DIM = 16;

/** Free-form dimension values longer than this are dropped. */
const MAX_CTX_VALUE_LENGTH = 64;

/**
 * Normalizes a raw context against the config: unknown keys dropped, and
 * declared `values` enforced as an allowlist. Without that enforcement a
 * crafted ?c_country=... creates an unbounded number of bucket counters
 * per test (storage growth plus stats fragmentation), since context
 * values arrive from URLs and page code.
 */
export function normalizeCtx(
  config: TestConfig,
  raw: Record<string, string> | null | undefined
): Record<string, string> | null {
  if (!raw || !config.ctx) {
    return null;
  }
  const dims = new Map(config.ctx.dims.map(d => [d.key, d.values]));
  const ctx: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!dims.has(key) || value === "") {
      continue;
    }
    const allowed = dims.get(key);
    if (
      allowed ? allowed.includes(value) : value.length <= MAX_CTX_VALUE_LENGTH
    ) {
      ctx[key] = value;
    }
  }
  return Object.keys(ctx).length > 0 ? ctx : null;
}

/**
 * The one id-hashing formula, shared by server and SDK: hashing with the
 * testId makes ids unlinkable across tests, and hashing client-side (SDK)
 * means the raw id never reaches the server at all.
 */
export async function externalIdHash(
  testId: string,
  externalId: string
): Promise<string> {
  return sha256Hex(`${testId}|${externalId}`);
}

/**
 * Values for dimensions the config asks the server to fill in. A caller
 * who supplied the dimension explicitly always wins, and a declared
 * `values` allowlist still applies, so a signal cannot invent buckets the
 * config never sanctioned.
 *
 * A supplied value lands here rather than staying in the caller's context
 * on purpose: see `splitAutoDims`.
 */
export function deriveAutoCtx(
  dims: readonly CtxDim[] | undefined,
  signals: RequestSignals,
  callerCtx: Record<string, string> | null
): Record<string, string> {
  const auto: Record<string, string> = {};
  for (const dim of dims ?? []) {
    if (!dim.from) {
      continue;
    }
    const value = callerCtx?.[dim.key] ?? signals[dim.from];
    if (value === undefined) {
      continue;
    }
    if (dim.values && !dim.values.includes(value)) {
      continue;
    }
    auto[dim.key] = value;
  }
  return auto;
}

/**
 * The caller's context minus any dimension the config marks `from`. Those
 * are composed separately (see `composeBucketKey`), and they have to be
 * composed the same way for every visitor: if a supplied `country=nl`
 * stayed in the caller's key while a derived `country=nl` was composed on
 * top of it, one effective context would split into two buckets and the
 * test would learn each half at half speed.
 */
export function splitAutoDims(
  dims: readonly CtxDim[] | undefined,
  ctx: Record<string, string> | null
): Record<string, string> | null {
  if (!ctx) {
    return null;
  }
  const auto = new Set((dims ?? []).filter(d => d.from).map(d => d.key));
  if (auto.size === 0) {
    return ctx;
  }
  const rest = Object.fromEntries(
    Object.entries(ctx).filter(([key]) => !auto.has(key))
  );
  return Object.keys(rest).length > 0 ? rest : null;
}

/**
 * Combines the caller's bucket key with server-derived values. JS-mode
 * callers send a HASH of their own context (raw values never leave the
 * page), so the server cannot mix its own dimensions into that map; it
 * composes on top of the hash instead. Redirect mode hashes the caller's
 * params first and then takes the same path, so both modes land on the
 * same key for the same context.
 */
export async function composeBucketKey(
  testId: string,
  callerCtxKey: string | null,
  autoCtx: Record<string, string>
): Promise<string | null> {
  if (Object.keys(autoCtx).length === 0) {
    return callerCtxKey;
  }
  return sha256Hex(`${testId}|${callerCtxKey ?? ""}|${canonicalJson(autoCtx)}`);
}

/**
 * Feature indices for server-derived dimensions, to be unioned with the
 * caller's. Each key=value pair hashes to its own slot independently, so
 * a union is exactly the same result as hashing the merged map.
 */
export function mergeFeatureIndices(
  callerFeatIdx: number[] | null,
  autoCtx: Record<string, string>,
  dim: number = FEATURE_DIM
): number[] {
  const merged = new Set<number>(callerFeatIdx ?? [0]);
  for (const index of featureIndices(autoCtx, dim)) {
    merged.add(index);
  }
  return [...merged].sort((a, b) => a - b);
}

/** Opaque per-test bucket key; the only context form the store ever sees. */
export async function bucketKey(
  testId: string,
  ctx: Record<string, string>
): Promise<string> {
  return sha256Hex(`${testId}|${canonicalJson(ctx)}`);
}

/**
 * Hashed one-hot feature indices for the linear bandit: bias slot 0 plus
 * one slot per context key=value pair, hashed into [1, dim). Collisions
 * just merge two features, which linear models tolerate.
 */
export function featureIndices(
  ctx: Record<string, string> | null,
  dim: number = FEATURE_DIM
): number[] {
  const indices = new Set<number>([0]);
  if (ctx) {
    for (const [key, value] of Object.entries(ctx)) {
      indices.add(1 + (fnv1a32(`${key}=${value}`) % (dim - 1)));
    }
  }
  return [...indices].sort((a, b) => a - b);
}
