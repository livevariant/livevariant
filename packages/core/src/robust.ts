import type { AssignmentRecord } from "./state.js";

/**
 * Robust aggregation. `/choose` and `/reward` are unauthenticated writes
 * keyed on a public testId, so a script can invent visitors and steer a
 * test. Rather than authenticate every visitor (which would cost a
 * secret, a round-trip, or a third party), we bound how much any single
 * traffic source can contribute to the derived state.
 *
 * This is deliberately a PURE function of the event log: derived state is
 * already a function of that log, so applying the policy at recompute
 * time heals tests that were attacked before the policy existed.
 * Determinism matters for the same reason, hence the explicit ordering.
 */

export interface CapPolicy {
  /** A source may contribute at most this share of a test's records. */
  maxSourceShare: number;
  /** ...but never less than this many, so small tests still work. */
  minSourceFloor: number;
  /** Source hashes the creator has quarantined outright. */
  excludedSources?: string[];
  /** Time windows (ms epoch) the creator has quarantined. */
  excludedWindows?: Array<{ since: number; until: number }>;
}

export const DEFAULT_CAP_POLICY: CapPolicy = {
  // Generous on purpose: carrier-grade NAT and corporate gateways put
  // many genuine visitors behind one prefix, so the cap exists to blunt
  // a 10x skew, not to allocate traffic fairly.
  maxSourceShare: 0.05,
  minSourceFloor: 50
};

export interface CapResult {
  /** Records that count toward derived state and reported stats. */
  applied: AssignmentRecord[];
  /** How many records each rule removed, for creator-visible reporting. */
  excluded: {
    total: number;
    byCap: number;
    bySource: number;
    byWindow: number;
  };
  /** Record count per source hash, before capping. */
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

export function capContributions(
  events: Iterable<AssignmentRecord>,
  policy: CapPolicy = DEFAULT_CAP_POLICY
): CapResult {
  const ordered = [...events].sort(stableOrder);
  const excludedSources = new Set(policy.excludedSources ?? []);
  const windows = policy.excludedWindows ?? [];

  const perSource: Record<string, number> = {};
  for (const rec of ordered) {
    const key = rec.srcHash ?? "unknown";
    perSource[key] = (perSource[key] ?? 0) + 1;
  }

  const cap = Math.max(
    policy.minSourceFloor,
    Math.ceil(policy.maxSourceShare * ordered.length)
  );

  const applied: AssignmentRecord[] = [];
  const seen: Record<string, number> = {};
  const excluded = { total: 0, byCap: 0, bySource: 0, byWindow: 0 };

  for (const rec of ordered) {
    const key = rec.srcHash ?? "unknown";
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
    // Records with no source (anonymous or a store predating this field)
    // are never capped as a group: they would otherwise all share one
    // bucket and cap each other out.
    if (rec.srcHash) {
      const count = (seen[key] ?? 0) + 1;
      seen[key] = count;
      if (count > cap) {
        excluded.total++;
        excluded.byCap++;
        continue;
      }
    }
    applied.push(rec);
  }

  return { applied, excluded, perSource };
}

/**
 * Live-path check: whether one more record from this source should feed
 * the derived cache. The full policy still runs at recompute, so this is
 * an optimization to stop an in-flight attack from moving the model, not
 * the authority on what counts.
 */
export function sourceWithinCap(
  sourceCount: number,
  totalCount: number,
  policy: CapPolicy = DEFAULT_CAP_POLICY
): boolean {
  const cap = Math.max(
    policy.minSourceFloor,
    Math.ceil(policy.maxSourceShare * totalCount)
  );
  return sourceCount <= cap;
}
