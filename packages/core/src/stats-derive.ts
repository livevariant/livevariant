/**
 * Everything a results view DERIVES from the raw counts, kept out of any
 * component so the arithmetic is unit-testable and so two different
 * dashboards cannot disagree about what the same numbers mean.
 *
 * The posterior work (P(best), expected loss, stop advice) is
 * analyzeOutcomes next door: the same Beta-Bernoulli sampler the bandit
 * itself runs, so a view's verdicts agree with the mechanism that
 * produced the data rather than approximating it.
 */
import {
  analyzeOutcomes,
  BUCKET_POOLING_STRENGTH,
  MIN_BUCKET_PULLS_TO_CALL,
  MIN_PROBABILITY_GAP_TO_NAME_LEADER,
  MIN_PULLS_TO_CALL,
  THIN_EXPOSURE_SHARE,
  type ArmOutcome,
  type DecisionAnalysis
} from "./decide.js";
import type { TestStats } from "./stats.js";

/**
 * Wilson 95% score interval for a conversion rate. Chosen over a normal
 * approximation because test traffic is exactly the regime where the
 * normal one lies: small n, rates near zero.
 */
export function wilson95(conversions: number, pulls: number): [number, number] {
  if (pulls === 0) {
    return [0, 1];
  }
  const z = 1.96;
  const p = conversions / pulls;
  const denom = 1 + z ** 2 / pulls;
  const center = (p + z ** 2 / (2 * pulls)) / denom;
  const spread =
    (z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * pulls)) / pulls)) / denom;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

export interface SlotAnalysis {
  key: string;
  variants: Array<{
    name: string;
    pulls: number;
    conversions: number;
    /** Share of the slot's traffic, 0..1. */
    share: number;
    rate: number | null;
    interval: [number, number];
    probabilityBest: number;
    /**
     * True when this variant has been starved hard enough that its reported
     * rate reads low and its interval is not what it looks like. See
     * THIN_EXPOSURE_SHARE. A surface that renders `rate` or `interval` should
     * say so rather than presenting them as a measurement.
     */
    thinExposure: boolean;
  }>;
  leader: number;
  canStop: boolean;
  /** Expected regret of stopping now, as a fraction of the leader's rate. */
  relativeLoss: number;
}

/** Per-slot marginal view with the posterior verdicts attached. */
export function analyzeSlots(stats: TestStats): SlotAnalysis[] {
  return Object.entries(stats.slots).map(([key, variants]) => {
    const analysis = analyzeOutcomes(
      variants.map(v => ({ pulls: v.pulls, conversions: v.conversions }))
    );
    const slotPulls = variants.reduce((sum, v) => sum + v.pulls, 0);
    return {
      key,
      variants: variants.map((v, i) => ({
        name: v.name,
        pulls: v.pulls,
        conversions: v.conversions,
        share: slotPulls > 0 ? v.pulls / slotPulls : 0,
        rate: v.conversionRate,
        interval: wilson95(v.conversions, v.pulls),
        probabilityBest: analysis.probabilities[i] ?? 0,
        // Relative to EVEN allocation, not to a fixed fraction: with two
        // variants a quarter-of-even share is 12.5%, with four it is 6.25%,
        // and in both cases it means the same thing about how starved the arm
        // is. A slot nobody has served yet is not thin, it is empty.
        thinExposure:
          slotPulls > 0 &&
          variants.length > 1 &&
          v.pulls / slotPulls < THIN_EXPOSURE_SHARE / variants.length
      })),
      leader: analysis.leader,
      canStop: analysis.canStop,
      relativeLoss: analysis.relativeLoss
    };
  });
}

/** The joint per-combination verdict; what a multi-slot test exists for. */
export function analyzeCombinations(stats: TestStats): DecisionAnalysis {
  return analyzeOutcomes(
    stats.combinations.map(c => ({
      pulls: c.pulls,
      conversions: c.conversions
    }))
  );
}

/**
 * The one-line reading of the whole test. Mirrors the registry's
 * get_stats advice so the dashboard and an agent reading the API reach
 * the same verdict from the same numbers.
 */
export function decisionLine(
  stats: TestStats,
  analysis: DecisionAnalysis
): string {
  if (stats.totalAssignments === 0) {
    return "Nothing has been served yet.";
  }
  const leader = stats.combinations[analysis.leader];
  const name = leader ? leader.choice.join(" + ") : "none";

  // Evidence FIRST, and the order is the whole point. Two arms with three
  // pulls each have overlapping posteriors for the obvious reason, and the tie
  // test cannot tell "measured, and equal" from "nobody has looked yet". Put
  // the tie branch above this and a brand-new test reads "either is safe to
  // ship", which is the same false confidence this task set out to remove,
  // moved one line down.
  const thin = !stats.combinations.some(c => c.pulls >= MIN_PULLS_TO_CALL);
  if (thin) {
    return `${name} leads on thin data; too early to mean much.`;
  }

  // Two arms this close are not separable, and saying one "leads" invents a
  // finding. See MIN_PROBABILITY_GAP_TO_NAME_LEADER: with genuinely equal
  // arms the stopping rule still fires, and it names the arm that happened to
  // run lucky roughly half the time.
  const tied = tiedAtTop(stats, analysis);
  if (tied) {
    return (
      `No difference detected between ${tied[0]} and ${tied[1]} — ` +
      "either is safe to ship. The test keeps adapting either way."
    );
  }

  if (analysis.canStop) {
    // Deliberately no longer promises "under 1% of its rate". The threshold
    // bounds expected loss at ONE look, and a dashboard polls until it fires;
    // measured that way the small-lift case realized 2.59%. See canStop's doc
    // comment in decide.ts.
    return (
      `${name} leads and the remaining risk looks small. ` +
      "The test keeps adapting either way."
    );
  }
  return `${name} leads, but the gap could still flip.`;
}

/**
 * The top two combinations when no one of them is distinguishable, by name.
 *
 * Ranked on P(best) rather than on the posterior mean, because that is the
 * quantity the gap is defined over and the one the dashboard already shows.
 */
function tiedAtTop(
  stats: TestStats,
  analysis: DecisionAnalysis
): [string, string] | null {
  const ranked = analysis.probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => b.probability - a.probability);
  if (ranked.length < 2) {
    return null;
  }
  if (
    ranked[0].probability - ranked[1].probability >=
    MIN_PROBABILITY_GAP_TO_NAME_LEADER
  ) {
    return null;
  }
  const nameOf = (index: number) =>
    stats.combinations[index]?.choice.join(" + ") ?? "none";
  return [nameOf(ranked[0].index), nameOf(ranked[1].index)];
}

export interface BucketSummary {
  key: string;
  /** Recovered readable context, or a shortened opaque key. */
  name: string;
  labeled: boolean;
  pulls: number;
  conversions: number;
  /**
   * The bucket's own leading combination, or null when the bucket has not
   * been seen enough times to name one. Counts are still reported: a thin
   * segment is worth showing, a thin segment's "winner" is not. See
   * MIN_BUCKET_PULLS_TO_CALL.
   */
  leader: string | null;
  /**
   * The leader's PARTIALLY POOLED rate: the posterior mean under a prior of
   * the whole test's rate for the same combination, at
   * BUCKET_POOLING_STRENGTH pseudo-observations. Deliberately not the raw
   * ratio of this bucket's counts. The raw counts are right beside it; the
   * estimate is what the bucket's thin evidence justifies BELIEVING, which
   * for a small bucket is mostly the global result.
   */
  leaderRate: number | null;
  /** P(leader is best IN THIS BUCKET), under the same pooled posterior. */
  probabilityBest: number | null;
}

export interface BucketSummaries {
  /** The busiest buckets, fully analyzed, biggest first. */
  top: BucketSummary[];
  /** How many smaller buckets exist beyond `top`. */
  hidden: number;
}

/**
 * Per-bucket leaders: the product's headline claim ("a different winner
 * can emerge per audience segment") made visible. The posterior work is
 * spent only on the buckets that will actually be shown: ranking needs
 * nothing but pull totals, and a test with hundreds of buckets must not
 * pay millions of Monte Carlo draws on the main thread per live update.
 * Fewer draws than the headline analysis, too: per-bucket data is thin.
 */
export function summarizeBuckets(
  stats: TestStats,
  limit = 12
): BucketSummaries {
  const ranked = Object.entries(stats.buckets)
    .map(([key, bucket]) => ({
      key,
      bucket,
      pulls: bucket.pulls.reduce((sum, pulls) => sum + pulls, 0)
    }))
    .sort((a, b) => b.pulls - a.pulls);
  const top = ranked.slice(0, limit).map(({ key, bucket, pulls }) => {
    const arms: ArmOutcome[] = bucket.pulls.map((cellPulls, cell) => ({
      pulls: cellPulls,
      conversions: bucket.conversions[cell] ?? 0
    }));
    const conversions = arms.reduce((sum, arm) => sum + arm.conversions, 0);
    const base = {
      key,
      name: bucket.label ?? `${key.slice(0, 8)}…`,
      labeled: bucket.label !== undefined,
      pulls,
      conversions
    };
    // Thin buckets report what happened and stop there. Running the analysis
    // anyway and hiding it would still be one more chance to see a winner
    // that is not there; the whole point is that the claim is not made.
    if (pulls < MIN_BUCKET_PULLS_TO_CALL) {
      return { ...base, leader: null, leaderRate: null, probabilityBest: null };
    }
    // Partial pooling: each arm's prior is the whole test's rate for that
    // same combination. Independent flat-prior analyses per bucket were the
    // false-discovery machine the audit measured (52.7% of null runs at 8x2
    // showed a confident segment winner); under this prior a bucket only
    // contradicts the global result when its own data sustains it.
    const analysis = analyzeOutcomes(arms, {
      draws: 4000,
      priors: arms.map((_, cell) => {
        const combo = stats.combinations[cell];
        const globalRate = combo
          ? (1 + combo.conversions) / (2 + combo.pulls)
          : 0.5;
        return { mean: globalRate, strength: BUCKET_POOLING_STRENGTH };
      })
    });
    const combo = stats.combinations[analysis.leader];
    return {
      ...base,
      leader: combo ? combo.choice.join(" + ") : "–",
      // The pooled posterior mean, not the raw ratio: see BucketSummary.
      leaderRate: analysis.rates[analysis.leader] ?? null,
      probabilityBest: analysis.probabilities[analysis.leader] ?? 0
    };
  });
  return { top, hidden: Math.max(0, ranked.length - limit) };
}

export interface SignalBreakdown {
  signal: string;
  values: Array<{
    value: string;
    pulls: number;
    conversions: number;
    rate: number | null;
  }>;
  totalPulls: number;
}

/** bySignal as sorted rows: busiest signals first, busiest values first. */
export function signalBreakdowns(stats: TestStats): SignalBreakdown[] {
  return Object.entries(stats.bySignal)
    .map(([signal, values]) => {
      const rows = Object.entries(values)
        .map(([value, v]) => ({
          value,
          pulls: v.pulls,
          conversions: v.conversions,
          rate: v.pulls > 0 ? v.conversions / v.pulls : null
        }))
        .sort((a, b) => b.pulls - a.pulls);
      return {
        signal,
        values: rows,
        totalPulls: rows.reduce((sum, row) => sum + row.pulls, 0)
      };
    })
    .sort((a, b) => b.totalPulls - a.totalPulls);
}

export interface SourceRow {
  hash: string;
  count: number;
  /** Share of all assignments, 0..1. */
  share: number;
}

/** perSource as sorted rows; the input to the exclude workflow. */
export function sourceRows(stats: TestStats): SourceRow[] {
  const total = Object.values(stats.perSource).reduce((a, b) => a + b, 0);
  return Object.entries(stats.perSource)
    .map(([hash, count]) => ({
      hash,
      count,
      share: total > 0 ? count / total : 0
    }))
    .sort((a, b) => b.count - a.count);
}
