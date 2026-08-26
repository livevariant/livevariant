import { featureIndices } from "./context.js";
import type { VariantPrior } from "./model.js";
import { slotEntries, type TestConfig } from "./schema.js";

/**
 * LLM warm-start priors.
 *
 * Warm-starting a bandit with history is sound and it pays: Shivaswamy &
 * Joachims (2012), Multi-armed Bandit Problems with History (AISTATS), show
 * that a logarithmic amount of historic data takes regret from logarithmic to
 * constant, and that regret tends to zero as the history grows. That is the
 * reason to have priors at all.
 *
 * It is NOT the reason for the cap, and this comment used to claim it was.
 * That result holds under an explicit assumption the paper states plainly:
 * "The historic rewards for each arm are assumed to be drawn independently
 * from the same distributions as the non-historic rewards." A rate an LLM
 * guessed is not a draw from the arm's reward distribution, so we are outside
 * the theorem, and what governs us instead is prior MISSPECIFICATION: Loecher
 * (2021), The Perils of Misspecified Priors and Optional Stopping in
 * Multi-Armed Bandits, Frontiers in Artificial Intelligence 4:715690,
 * doi:10.3389/frai.2021.715690. Hence priorStrengthCap: every prior is capped
 * to that many pseudo-observations per variant so real data can override a
 * guess that is simply wrong.
 *
 * The cap's cost is measured rather than assumed. An adversarial prior sitting
 * at the cap (pointed at the wrong variant, mean 0.90, strength 50) delayed
 * finding the true winner from ~370 visitors to ~472, and never once prevented
 * recovery across 30 runs.
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
    //
    // The schema allows exactly one condition, which is what keeps this a
    // single index: the model is additive across context dimensions, so
    // two conditions would put the whole belief on each of them and move
    // every visitor matching either one.
    const ctxFeatIdx = featureIndices(block.when, dim).filter(f => f !== 0);
    if (ctxFeatIdx.length === 0) {
      continue;
    }
    collect(block.priors, ctxFeatIdx);
  }
  return priors;
}
