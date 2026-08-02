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

/**
 * The same judgement made against what a test ACTUALLY saw rather than
 * what it was configured to expect. Declared dimensions lie: free-form
 * values (a persona merge tag, a city) fragment far past the estimate,
 * and a test that looked bucketable on paper starves in practice.
 *
 * Switching is cheap by construction: `alg` is excluded from the identity
 * hash, so changing it keeps the same testId, and a recompute rebuilds
 * the model from the full event log. No history is lost.
 */
export function recommendFromObserved(options: {
  alg: "ts" | "bucketed" | "linear";
  bucketCount: number;
  totalAssignments: number;
  minBucketPulls?: number;
}): AlgorithmRecommendation | null {
  const { alg, bucketCount, totalAssignments } = options;
  const minBucketPulls = options.minBucketPulls ?? 100;
  if (bucketCount === 0 || totalAssignments === 0) {
    return null;
  }
  const perBucket = totalAssignments / bucketCount;
  if (alg === "bucketed" && perBucket < minBucketPulls) {
    return {
      alg: "linear",
      reasoning:
        `${bucketCount} context buckets are averaging ${Math.round(perBucket)} ` +
        `assignments, below the ${minBucketPulls} a bucket needs before it ` +
        "stops falling back to the global model. The linear model shares " +
        "what it learns across contexts instead of starving each one. " +
        "Switching keeps this test's id and history: change alg, then " +
        "recompute."
    };
  }
  if (alg === "linear" && bucketCount <= 4 && perBucket >= minBucketPulls * 4) {
    return {
      alg: "bucketed",
      reasoning:
        `Only ${bucketCount} context buckets, each with ~${Math.round(perBucket)} ` +
        "assignments. Independent per-bucket bandits are assumption-free " +
        "and will beat a linear model at this shape. Switching keeps this " +
        "test's id and history: change alg, then recompute."
    };
  }
  if (alg === "ts" && bucketCount > 1) {
    return {
      alg: perBucket >= minBucketPulls * 2 ? "bucketed" : "linear",
      reasoning:
        `Context is arriving (${bucketCount} buckets) but the test ignores ` +
        "it. A contextual algorithm can serve a different winner per " +
        "segment. Switching keeps this test's id and history."
    };
  }
  return null;
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
