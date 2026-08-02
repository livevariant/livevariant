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

/** Normalizes a raw context against the config: unknown keys dropped. */
export function normalizeCtx(
  config: TestConfig,
  raw: Record<string, string> | null | undefined
): Record<string, string> | null {
  if (!raw || !config.ctx) {
    return null;
  }
  const known = new Set(config.ctx.dims.map(d => d.key));
  const ctx: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key) && value !== "") {
      ctx[key] = value;
    }
  }
  return Object.keys(ctx).length > 0 ? ctx : null;
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
