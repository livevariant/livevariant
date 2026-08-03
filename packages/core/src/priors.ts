import type { VariantPrior } from "./model.js";
import { slotEntries, type TestConfig } from "./schema.js";

/**
 * LLM warm-start priors. The literature's one hard lesson (warm-start
 * bandits, Shivaswamy & Joachims 2012): priors must be weak enough for
 * real data to override, so every prior is capped to priorStrengthCap
 * pseudo-observations per variant before it touches the model.
 *
 * Priors are identity-excluded: adding or changing them keeps the test's
 * id, and a recompute rebuilds the model with them applied from the start
 * of the event log.
 */
export function effectivePriors(config: TestConfig): VariantPrior[] {
  const priors: VariantPrior[] = [];
  const entries = slotEntries(config);
  for (let slot = 0; slot < entries.length; slot++) {
    const [slotKey] = entries[slot];
    const slotPriors = config.priors?.[slotKey];
    if (!slotPriors) {
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
        strength: Math.min(strength, config.priorStrengthCap)
      });
    }
  }
  return priors;
}
