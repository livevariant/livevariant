import { canonicalJson, fnv1a32, sha256Hex } from "./canonical.js";
import type { TestConfig } from "./schema.js";

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
