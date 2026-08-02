/**
 * Algorithm auto-pick, used by the web builder and (once it exists) the
 * planned MCP server so both give identical advice. Heuristic from the plan: no context ->
 * plain Thompson; one coarse dimension with healthy per-bucket traffic ->
 * bucketed; richer or thinner -> linear (generalizes instead of
 * fragmenting).
 */
export interface AlgorithmRecommendation {
  alg: "ts" | "bucketed" | "linear";
  reasoning: string;
}

export function recommendAlgorithm(options: {
  ctxDims: Array<{ key: string; values?: string[] }>;
  /** Rough expected visitors for the test's lifetime, if known. */
  expectedTraffic?: number;
  minBucketPulls?: number;
}): AlgorithmRecommendation {
  const dims = options.ctxDims;
  if (dims.length === 0) {
    return {
      alg: "ts",
      reasoning:
        "No context dimensions: plain Thompson sampling converges fastest."
    };
  }
  const bucketCount = dims.reduce(
    // Free-form dims count as ~8 distinct values for sizing purposes.
    (product, dim) => product * (dim.values?.length ?? 8),
    1
  );
  const minBucketPulls = options.minBucketPulls ?? 100;
  const perBucket =
    options.expectedTraffic !== undefined
      ? options.expectedTraffic / bucketCount
      : undefined;

  if (
    dims.length === 1 &&
    bucketCount <= 4 &&
    (perBucket === undefined || perBucket >= minBucketPulls * 2)
  ) {
    return {
      alg: "bucketed",
      reasoning:
        `One coarse dimension (~${bucketCount} buckets): independent ` +
        "per-bucket bandits are assumption-free and each bucket has " +
        "enough traffic to learn on its own."
    };
  }
  return {
    alg: "linear",
    reasoning:
      `~${bucketCount} context combinations` +
      (perBucket !== undefined
        ? ` at ~${Math.round(perBucket)} visitors each`
        : "") +
      ": too sparse for per-bucket learning; the linear model generalizes " +
      "across contexts instead of fragmenting the data."
  };
}
