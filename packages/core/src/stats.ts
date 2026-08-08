/**
 * The shape of a test's results: what GET /stats returns, and the one
 * definition of it.
 *
 * It lives in core rather than in the server because both ends need it
 * and neither should own it. The server produces it; a dashboard consumes
 * it; a dashboard that imported the server package to name its own data
 * would drag an HTTP framework and an MCP server into a browser bundle
 * for a handful of interfaces. It was duplicated by hand for exactly that
 * reason, and the two copies had already drifted.
 */

export interface VariantStats {
  name: string;
  pulls: number;
  conversions: number;
  conversionRate: number | null;
}

export interface CombinationStats {
  cell: number;
  /** Variant name per slot, canonical slot order. */
  choice: string[];
  pulls: number;
  conversions: number;
  rewardTotal: number;
  conversionRate: number | null;
}

export interface BucketStats {
  /** Arrays indexed by cell. */
  pulls: number[];
  conversions: number[];
  /** Recovered readable context; absent when the key stays opaque. */
  label?: string;
}

export interface TestStats {
  testId: string;
  totalAssignments: number;
  /** Exact outcomes per served combination (single-slot: per variant). */
  combinations: CombinationStats[];
  /**
   * Per-slot marginal rollups: how each variant did across every
   * combination it appeared in. The multi-slot answer to "how is hero B
   * doing overall"; for a single-slot test it mirrors `combinations`.
   */
  slots: Record<string, VariantStats[]>;
  /**
   * Per-context-bucket outcomes, arrays indexed by cell. `label` is the
   * recovered readable context ("country=nl") when every dimension in
   * the bucket has a declared `values` list; absent for free-form
   * dimensions, whose keys stay the opaque hashes they are stored as.
   */
  buckets: Record<string, BucketStats>;
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
}

/**
 * Fills the optional sections, so a dashboard renders against an older
 * server instead of crashing on a field that deployment does not send
 * yet. The two ends of this contract deploy independently.
 */
export function normalizeStats(raw: unknown): TestStats {
  const partial = (raw ?? {}) as Partial<TestStats>;
  return {
    testId: partial.testId ?? "",
    totalAssignments: partial.totalAssignments ?? 0,
    combinations: partial.combinations ?? [],
    slots: partial.slots ?? {},
    buckets: partial.buckets ?? {},
    bySignal: partial.bySignal ?? {},
    perSource: partial.perSource ?? {},
    excluded: partial.excluded ?? { total: 0, bySource: 0, byWindow: 0 }
  };
}
