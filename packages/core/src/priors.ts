import { featureIndices } from "./context.js";
import type { VariantPrior } from "./model.js";
import { slotEntries, type TestConfig } from "./schema.js";

/**
 * LLM warm-start priors. The literature's one hard lesson (warm-start
 * bandits, Shivaswamy & Joachims 2012): priors must be weak enough for
 * real data to override, so every prior is capped to priorStrengthCap
 * pseudo-observations per variant before it touches the model.
 *
 * Two kinds, and the difference is which feature they land on. A plain
 * prior is a belief about a variant for everybody, so it goes on the
 * variant's main effect. A `ctxPriors` block is a belief about a variant
 * for ONE segment, so it goes on the (context x variant) interaction: the
 * same feature that segment's own traffic moves, which is what makes the
 * warm start and the learning talk about the same thing.
 *
 * Priors are identity-excluded: adding or changing them keeps the test's
 * id, and a recompute rebuilds the model with them applied from the start
 * of the event log.
 */
export function effectivePriors(
  config: TestConfig,
  dim: number
): VariantPrior[] {
  const priors: VariantPrior[] = [];
  const entries = slotEntries(config);
  const slotIndex = new Map(entries.map(([key], index) => [key, index]));

  const collect = (
    perSlot: Record<string, Array<{ mean: number; strength: number }>>,
    ctxFeatIdx?: number[]
  ) => {
    for (const [slotKey, slotPriors] of Object.entries(perSlot)) {
      const slot = slotIndex.get(slotKey);
      if (slot === undefined) {
        continue;
      }
      for (let variant = 0; variant < slotPriors.length; variant++) {
        const { mean, strength } = slotPriors[variant];
        if (strength <= 0) {
          continue;
        }
        priors.push({
          slot,
          variant,
          mean,
          strength: Math.min(strength, config.priorStrengthCap),
          ...(ctxFeatIdx ? { ctxFeatIdx } : {})
        });
      }
    }
  };

  collect(config.priors ?? {});
  for (const block of config.ctxPriors ?? []) {
    // The feature index of `color=blauw` is a pure function of the string
    // and the dimension, so a belief about a segment can be placed without
    // a single visitor from that segment being present. Feature 0 is the
    // bias and belongs to every request, so conditioning on it would make
    // the prior unconditional by another name.
    const ctxFeatIdx = featureIndices(block.when, dim).filter(f => f !== 0);
    if (ctxFeatIdx.length === 0) {
      continue;
    }
    collect(block.priors, ctxFeatIdx);
  }
  return priors;
}
