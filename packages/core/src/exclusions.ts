import type { AssignmentRecord } from "./state.js";

/**
 * Creator exclusions. `/choose` and `/reward` are unauthenticated writes
 * keyed on a public testId, so a script can invent visitors and steer a
 * test. The remedy is deliberately manual: the creator sees a per-source
 * breakdown in the stats and quarantines what doesn't belong.
 *
 * There is no automatic exclusion, and that is a decision rather than an
 * omission. Source buckets are address prefixes, and mail providers fetch
 * email images through their own infrastructure, so a large campaign's
 * opens legitimately share a handful of prefixes. Any automatic rule
 * would discard most of a real send while reporting the remainder with
 * full confidence, and a confidently wrong number is worse than a noisy
 * one.
 *
 * This is a PURE function of the event log: derived state is already a
 * function of that log, so applying exclusions at recompute time heals
 * history rather than only affecting new traffic. Determinism matters for
 * the same reason, hence the explicit ordering.
 */

export interface ExclusionPolicy {
  /** Source hashes the creator has quarantined. */
  excludedSources?: string[];
  /** Time windows (ms epoch, inclusive) the creator has quarantined. */
  excludedWindows?: Array<{ since: number; until: number }>;
}

export interface ExclusionResult {
  /** Records that count toward derived state and reported stats. */
  applied: AssignmentRecord[];
  /** What each rule removed, for creator-visible reporting. */
  excluded: { total: number; bySource: number; byWindow: number };
  /** Record count per source hash, before exclusions. */
  perSource: Record<string, number>;
}

/** Deterministic order: oldest first, idHash as the tie-break. */
function stableOrder(
  a: AssignmentRecord & { idHash?: string },
  b: AssignmentRecord & { idHash?: string }
): number {
  if (a.firstSeen !== b.firstSeen) {
    return a.firstSeen - b.firstSeen;
  }
  return (a.idHash ?? "").localeCompare(b.idHash ?? "");
}

export function applyExclusions(
  events: Iterable<AssignmentRecord>,
  policy: ExclusionPolicy = {}
): ExclusionResult {
  const ordered = [...events].sort(stableOrder);
  const excludedSources = new Set(policy.excludedSources ?? []);
  const windows = policy.excludedWindows ?? [];

  const perSource: Record<string, number> = {};
  for (const rec of ordered) {
    const key = rec.srcHash ?? "unknown";
    perSource[key] = (perSource[key] ?? 0) + 1;
  }

  const applied: AssignmentRecord[] = [];
  const excluded = { total: 0, bySource: 0, byWindow: 0 };

  for (const rec of ordered) {
    if (rec.srcHash && excludedSources.has(rec.srcHash)) {
      excluded.total++;
      excluded.bySource++;
      continue;
    }
    if (
      windows.some(w => rec.firstSeen >= w.since && rec.firstSeen <= w.until)
    ) {
      excluded.total++;
      excluded.byWindow++;
      continue;
    }
    applied.push(rec);
  }

  return { applied, excluded, perSource };
}
