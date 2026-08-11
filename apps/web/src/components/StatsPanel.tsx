/**
 * The live results panel: one subscription (SSE with polling fallback),
 * everything derivable from the test's state, moving numbers.
 *
 * Design notes (DESIGN.md): all metrics are mono with tabular numerals;
 * the variant colors are reserved for variant identity and nothing else;
 * live green appears only on things that are actually live (the LIVE
 * dot, "still testing"); hairline rules, no decoration.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@/components/ui/card";
import { subscribeStats, type StreamState } from "@/lib/stats";
import {
  analyzeCombinations,
  analyzeSlots,
  decisionLine,
  normalizeStats,
  signalBreakdowns,
  sourceRows,
  summarizeBuckets,
  type SlotAnalysis,
  type TestStats
} from "@livevariant/core";

/** Variant identity colors, cycling past three (DESIGN.md role system). */
const VARIANT_COLORS = [
  "var(--variant-a)",
  "var(--variant-b)",
  "var(--variant-c)"
];

function variantColor(index: number): string {
  return VARIANT_COLORS[index % VARIANT_COLORS.length];
}

const nf = new Intl.NumberFormat("en-US");

function pct(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined
    ? "–"
    : `${(value * 100).toFixed(digits)}%`;
}

/**
 * A metric that visibly ticks: remounting on change replays the short
 * odometer-style roll (CSS, and frozen under prefers-reduced-motion).
 */
function Tick({ children }: { children: string }) {
  return (
    <span key={children} className="stat-roll inline-block">
      {children}
    </span>
  );
}

/** The connection's health, worn on the sleeve. Green means live. */
function LiveChip({ state }: { state: StreamState }) {
  if (state === "live") {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs text-live">
        <span className="live-dot size-2 rounded-full bg-live" /> LIVE
      </span>
    );
  }
  if (state === "polling") {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span className="size-2 rounded-full bg-muted-foreground" /> polling
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="font-mono text-xs text-muted-foreground">
        connecting…
      </span>
    );
  }
  return null;
}

/** A thin horizontal share bar; color carries variant identity only. */
function ShareBar({ share, color }: { share: number; color?: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-muted">
      <div
        className="h-1.5 rounded-full transition-[width] duration-300 ease-in-out"
        style={{
          width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%`,
          background: color ?? "var(--muted-foreground)"
        }}
      />
    </div>
  );
}

/**
 * The 95% interval drawn as a range on a shared scale, with a dot at the
 * observed rate: what "is the gap real" looks like before the posterior
 * math answers it.
 */
function IntervalBar({
  rate,
  interval,
  scale,
  color
}: {
  rate: number | null;
  interval: [number, number];
  scale: number;
  color: string;
}) {
  if (rate === null || scale <= 0) {
    return <div className="h-1.5 w-full rounded-full bg-muted" />;
  }
  const lo = (interval[0] / scale) * 100;
  const width = ((interval[1] - interval[0]) / scale) * 100;
  const at = (rate / scale) * 100;
  return (
    <div className="relative h-1.5 w-full rounded-full bg-muted">
      <div
        className="absolute h-1.5 rounded-full opacity-40"
        style={{ left: `${lo}%`, width: `${width}%`, background: color }}
      />
      <div
        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `${Math.min(at, 100)}%`, background: color }}
      />
    </div>
  );
}

function SlotTable({ slot, multi }: { slot: SlotAnalysis; multi: boolean }) {
  // One scale per slot so the intervals are comparable across its rows.
  const scale = Math.max(...slot.variants.map(v => v.interval[1]), 0.01);
  return (
    <div className="space-y-2">
      {multi && (
        <div className="font-mono text-sm text-muted-foreground">
          {slot.key}
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 font-medium">Variant</th>
            <th className="w-[18%] py-2 font-medium">Traffic</th>
            <th className="py-2 text-right font-medium">Pulls</th>
            <th className="py-2 text-right font-medium">Conv.</th>
            <th className="py-2 text-right font-medium">Rate</th>
            <th className="w-[18%] py-2 pl-3 font-medium">95% interval</th>
            <th className="py-2 text-right font-medium">P(best)</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {slot.variants.map((variant, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="py-2.5 pr-2">
                <span className="flex items-center gap-2 font-sans">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: variantColor(i) }}
                  />
                  <span
                    className={
                      i === slot.leader && slot.variants[i].pulls > 0
                        ? "underline decoration-2 underline-offset-4"
                        : undefined
                    }
                    style={
                      i === slot.leader && slot.variants[i].pulls > 0
                        ? { textDecorationColor: variantColor(i) }
                        : undefined
                    }
                  >
                    {variant.name}
                  </span>
                </span>
              </td>
              <td className="py-2.5 pr-3">
                <ShareBar share={variant.share} color={variantColor(i)} />
              </td>
              <td className="py-2.5 text-right">
                <Tick>{nf.format(variant.pulls)}</Tick>
              </td>
              <td className="py-2.5 text-right">
                <Tick>{nf.format(variant.conversions)}</Tick>
              </td>
              <td className="py-2.5 text-right">
                <Tick>{pct(variant.rate)}</Tick>
              </td>
              <td className="py-2.5 pl-3">
                <IntervalBar
                  rate={variant.rate}
                  interval={variant.interval}
                  scale={scale}
                  color={variantColor(i)}
                />
              </td>
              <td className="py-2.5 text-right font-medium">
                <Tick>{pct(variant.probabilityBest, 0)}</Tick>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatsPanel({
  encoded,
  statsSecret,
  hasSecret
}: {
  encoded: string;
  statsSecret: string | null;
  /** Whether a secret exists at all; decides the 401 hint copy. */
  hasSecret: boolean;
}) {
  const [stats, setStats] = useState<TestStats | null>(null);
  const [state, setState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStats(null);
    setState("connecting");
    setError(null);
    return subscribeStats(
      encoded,
      statsSecret,
      next => setStats(normalizeStats(next)),
      (nextState, detail) => {
        setState(nextState);
        setError(nextState === "error" ? (detail ?? "connection lost") : null);
      }
    );
  }, [encoded, statsSecret]);

  const derived = useMemo(() => {
    if (!stats) {
      return null;
    }
    const joint = analyzeCombinations(stats);
    return {
      slots: analyzeSlots(stats),
      joint,
      line: decisionLine(stats, joint),
      buckets: summarizeBuckets(stats),
      signals: signalBreakdowns(stats),
      sources: sourceRows(stats)
    };
  }, [stats]);

  const totalConversions =
    stats?.combinations.reduce((sum, c) => sum + c.conversions, 0) ?? 0;
  const overallRate =
    stats && stats.totalAssignments > 0
      ? totalConversions / stats.totalAssignments
      : null;
  const multiSlot = Object.keys(stats?.slots ?? {}).length > 1;

  return (
    <Card>
      <CardHeader className="flex-row items-start space-y-0">
        <div className="flex-1 space-y-1.5">
          <CardTitle>Results</CardTitle>
          <CardDescription>
            {error
              ? `Could not load stats: ${error}${
                  hasSecret
                    ? ""
                    : " (open the manage link with its #secret, or sign in to the owning account)"
                }`
              : stats
                ? "Numbers update on their own while this page is open."
                : "loading…"}
          </CardDescription>
        </div>
        <LiveChip state={state} />
      </CardHeader>
      {stats && derived && (
        <CardContent className="space-y-8">
          {/* Headline strip: the whole test in four numbers. */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                ["assignments", nf.format(stats.totalAssignments)],
                ["conversions", nf.format(totalConversions)],
                ["overall rate", pct(overallRate)],
                ["combinations", nf.format(stats.combinations.length)]
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-lg border p-3">
                <div className="font-mono text-2xl tabular-nums">
                  <Tick>{value}</Tick>
                </div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>

          {/* The verdict, and the honest amount of doubt around it. */}
          {stats.totalAssignments > 0 && (
            <p className="text-sm">
              {derived.line}{" "}
              {!derived.joint.canStop && (
                <span className="font-mono text-live">still testing</span>
              )}
            </p>
          )}

          {stats.totalAssignments === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing has been served yet. The moment the first visitor lands,
              the numbers appear here on their own.
            </p>
          ) : (
            <>
              {/* Per-slot marginals: for a single-slot test this IS the
                  whole picture. */}
              <div className="space-y-6">
                {derived.slots.map(slot => (
                  <SlotTable key={slot.key} slot={slot} multi={multiSlot} />
                ))}
              </div>

              {/* Exact per-combination outcomes, the answer a
                  multi-element test exists to give. */}
              {multiSlot && (
                <div className="space-y-2">
                  <div className="font-mono text-sm text-muted-foreground">
                    combinations
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 font-medium">Combination</th>
                        <th className="py-2 text-right font-medium">Pulls</th>
                        <th className="py-2 text-right font-medium">Conv.</th>
                        <th className="py-2 text-right font-medium">Rate</th>
                        <th className="py-2 text-right font-medium">Reward</th>
                        <th className="py-2 text-right font-medium">P(best)</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {[...stats.combinations]
                        .map((combo, cell) => ({
                          combo,
                          p: derived.joint.probabilities[cell] ?? 0
                        }))
                        .sort((a, b) => b.combo.pulls - a.combo.pulls)
                        .map(({ combo, p }) => (
                          <tr
                            key={combo.cell}
                            className="border-b last:border-0"
                          >
                            <td className="py-2 font-sans">
                              {combo.choice.join(" + ")}
                            </td>
                            <td className="py-2 text-right">
                              <Tick>{nf.format(combo.pulls)}</Tick>
                            </td>
                            <td className="py-2 text-right">
                              <Tick>{nf.format(combo.conversions)}</Tick>
                            </td>
                            <td className="py-2 text-right">
                              <Tick>{pct(combo.conversionRate)}</Tick>
                            </td>
                            <td className="py-2 text-right">
                              <Tick>{nf.format(combo.rewardTotal)}</Tick>
                            </td>
                            <td className="py-2 text-right">
                              <Tick>{pct(p, 0)}</Tick>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Context buckets: where "a different winner per audience
                  segment" becomes visible. */}
              {derived.buckets.top.length > 0 && (
                <div className="space-y-2">
                  <div className="font-mono text-sm text-muted-foreground">
                    context buckets
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-2 font-medium">Segment</th>
                        <th className="py-2 text-right font-medium">Pulls</th>
                        <th className="py-2 text-right font-medium">Conv.</th>
                        <th className="py-2 pl-4 font-medium">
                          Leading combination
                        </th>
                        <th className="py-2 text-right font-medium">Rate</th>
                        <th className="py-2 text-right font-medium">P(best)</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono tabular-nums">
                      {derived.buckets.top.map(bucket => (
                        <tr key={bucket.key} className="border-b last:border-0">
                          <td
                            className={
                              bucket.labeled
                                ? "py-2"
                                : "py-2 text-muted-foreground"
                            }
                          >
                            {bucket.name}
                          </td>
                          <td className="py-2 text-right">
                            <Tick>{nf.format(bucket.pulls)}</Tick>
                          </td>
                          <td className="py-2 text-right">
                            <Tick>{nf.format(bucket.conversions)}</Tick>
                          </td>
                          <td className="py-2 pl-4 font-sans">
                            {/*
                             * A bucket under the exposure gate has no leader
                             * to show, and a blank cell would read as a bug.
                             * Its counts are still worth seeing; its "winner"
                             * is not, because with enough thin segments one of
                             * them always looks like a winner.
                             */}
                            {bucket.leader ?? (
                              <span className="text-muted-foreground">
                                too few to call
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-right">
                            <Tick>{pct(bucket.leaderRate)}</Tick>
                          </td>
                          <td className="py-2 text-right">
                            <Tick>{pct(bucket.probabilityBest, 0)}</Tick>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {derived.buckets.hidden > 0 && (
                    <p className="text-xs text-muted-foreground">
                      and {derived.buckets.hidden} smaller buckets
                    </p>
                  )}
                </div>
              )}

              {/* Derived signals: recorded for every test, so a plain
                  A/B still gets a legible audience breakdown. */}
              {derived.signals.length > 0 && (
                <div className="space-y-2">
                  <div className="font-mono text-sm text-muted-foreground">
                    audience signals
                  </div>
                  <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                    {derived.signals.map(signal => (
                      <table key={signal.signal} className="w-full text-sm">
                        <caption className="pb-1 text-left font-mono text-xs text-muted-foreground">
                          {signal.signal}
                        </caption>
                        <tbody className="font-mono tabular-nums">
                          {signal.values.slice(0, 6).map(row => (
                            <tr
                              key={row.value}
                              className="border-b last:border-0"
                            >
                              <td className="py-1.5 pr-2">{row.value}</td>
                              <td className="w-[30%] py-1.5 pr-3">
                                <ShareBar
                                  share={
                                    signal.totalPulls > 0
                                      ? row.pulls / signal.totalPulls
                                      : 0
                                  }
                                />
                              </td>
                              <td className="py-1.5 text-right">
                                <Tick>{nf.format(row.pulls)}</Tick>
                              </td>
                              <td className="py-1.5 text-right">
                                <Tick>{pct(row.rate)}</Tick>
                              </td>
                            </tr>
                          ))}
                          {signal.values.length > 6 && (
                            <tr>
                              <td
                                colSpan={4}
                                className="py-1.5 text-xs text-muted-foreground"
                              >
                                and {signal.values.length - 6} more values
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    ))}
                  </div>
                </div>
              )}

              {/* Traffic sources feed the exclude workflow; the audit
                  line keeps quarantined history visible, not vanished. */}
              {(derived.sources.length > 0 || stats.excluded.total > 0) && (
                <div className="space-y-2">
                  <div className="font-mono text-sm text-muted-foreground">
                    traffic sources
                  </div>
                  {derived.sources.length > 0 && (
                    <table className="w-full text-sm">
                      <tbody className="font-mono tabular-nums">
                        {derived.sources.slice(0, 8).map(source => (
                          <tr
                            key={source.hash}
                            className="border-b last:border-0"
                          >
                            <td className="py-1.5 text-muted-foreground">
                              {source.hash.slice(0, 12)}…
                            </td>
                            <td className="w-[40%] py-1.5 pr-3">
                              <ShareBar share={source.share} />
                            </td>
                            <td className="py-1.5 text-right">
                              <Tick>{nf.format(source.count)}</Tick>
                            </td>
                            <td className="py-1.5 pl-3 text-right">
                              <Tick>{pct(source.share, 0)}</Tick>
                            </td>
                          </tr>
                        ))}
                        {derived.sources.length > 8 && (
                          <tr>
                            <td
                              colSpan={4}
                              className="py-1.5 text-xs text-muted-foreground"
                            >
                              and {derived.sources.length - 8} smaller sources
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                  {stats.excluded.total > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {nf.format(stats.excluded.total)} assignments excluded (
                      {nf.format(stats.excluded.bySource)} by source,{" "}
                      {nf.format(stats.excluded.byWindow)} by time window), and
                      not counted above.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
