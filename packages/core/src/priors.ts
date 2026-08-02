import { bucketKey } from "./context.js";
import type { ArmPrior, TestConfig } from "./schema.js";

/**
 * LLM warm-start priors. The literature's one hard lesson (see plan):
 * priors must be weak enough for real data to override, so every prior is
 * capped to priorStrengthCap pseudo-observations per arm before use.
 */

export function capArmPriors(priors: ArmPrior[], cap: number): ArmPrior[] {
  return priors.map(({ alpha, beta }) => {
    const total = alpha + beta;
    if (total <= cap) {
      return { alpha, beta };
    }
    const scale = cap / total;
    return { alpha: alpha * scale, beta: beta * scale };
  });
}

/** Capped global per-arm priors, or undefined when none are configured. */
export function effectiveArmPriors(config: TestConfig): ArmPrior[] | undefined {
  if (!config.priors?.arms) {
    return undefined;
  }
  return capArmPriors(config.priors.arms, config.priorStrengthCap);
}

/**
 * Bucket priors resolved to the same opaque bucket keys the serving path
 * uses, so lookups never touch raw context values after this point.
 */
export async function effectiveBucketPriors(
  config: TestConfig,
  testId: string
): Promise<Record<string, ArmPrior[]>> {
  const resolved: Record<string, ArmPrior[]> = {};
  for (const bucket of config.priors?.buckets ?? []) {
    const key = await bucketKey(testId, bucket.ctx);
    resolved[key] = capArmPriors(bucket.arms, config.priorStrengthCap);
  }
  return resolved;
}

export interface LinearPrior {
  mean: number;
  strength: number;
}

export function effectiveLinearPriors(
  config: TestConfig
): LinearPrior[] | undefined {
  if (!config.priors?.linear) {
    return undefined;
  }
  return config.priors.linear.map(({ mean, strength }) => ({
    mean,
    strength: Math.min(strength, config.priorStrengthCap)
  }));
}
