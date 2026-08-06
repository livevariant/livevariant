import { cellCount, validCell } from "./cells.js";
import {
  cellFeatures,
  chooseCell as modelChooseCell,
  newModel,
  observe,
  reward,
  type JointModel,
  type VariantPrior
} from "./model.js";
import type { Rng } from "./rng.js";
import type { RequestSignals } from "./signals.js";

/**
 * Event-sourced state. The single source of truth is one AssignmentRecord
 * per (testId, idHash); the DerivedState below is a cache the hot path
 * updates incrementally and recomputeState can always rebuild. The
 * incremental and replay paths share the exact apply functions here,
 * which is what makes them provably equivalent (recompute.spec.ts).
 *
 * Derived state has two halves with two jobs:
 * - the JOINT MODEL serves: it is what the chooser samples from;
 * - the CELL COUNTERS report: exact pulls/conversions per combination,
 *   which is what stats and the stop/continue decision read.
 * Both replay from the same records.
 */

/** Pulls and successes for one cell (or one marginal variant). */
export interface CellCounts {
  pulls: number;
  successes: number;
}

export function emptyCounts(cells: number): CellCounts[] {
  return Array.from({ length: cells }, () => ({ pulls: 0, successes: 0 }));
}

export interface AssignmentRecord {
  /** The served combination, encoded (cells.ts) against slotSizes. */
  cell: number;
  /** Variant counts per slot at serve time; the cell's coordinate system. */
  slotSizes: number[];
  /** Model dimension at serve time. */
  dim: number;
  /**
   * The full hashed feature set of (cell, context) computed at serve
   * time: bias, context, variant mains, and every interaction. Stored so
   * replay and /reward never re-derive hashing, and so a record survives
   * the config's context definition changing under it.
   */
  featIdx: number[];
  /** Opaque bucket key, or null when the request carried no context. */
  ctxKey: string | null;
  /** Accumulated reward; only the first reward updates derived state. */
  rewardTotal: number;
  /**
   * The client SDK version that created (or, backfilled on reward,
   * rewarded) this record; null for server-created records (redirects)
   * whose visitor never spoke SDK wire. Diagnostic only today; exists
   * so "which sites run an outdated SDK" is answerable later without
   * asking anyone to re-instrument.
   */
  sdk?: string | null;
  /** ms epoch; also the replay order for recompute. */
  firstSeen: number;
  /**
   * Opaque, per-test, daily-rotating hash of the traffic source's address
   * prefix (source.ts). Never an address, never cross-test; exists so a
   * creator can see where traffic came from and quarantine what does not
   * belong (exclusions.ts).
   */
  srcHash?: string | null;
  /**
   * Coarse signals the server derived for this request (country, device,
   * utm tags). Stored readable, unlike the caller's own context, so stats
   * can say "nl / mobile" instead of an opaque hash.
   */
  signals?: RequestSignals | null;
}

export interface DerivedState {
  slotSizes: number[];
  dim: number;
  cells: CellCounts[];
  model: JointModel;
}

export interface StateInit {
  slotSizes: number[];
  dim: number;
  priors?: VariantPrior[];
}

export function newDerivedState(init: StateInit): DerivedState {
  return {
    slotSizes: init.slotSizes,
    dim: init.dim,
    cells: emptyCounts(cellCount(init.slotSizes)),
    model: newModel(init.dim, init.priors)
  };
}

/**
 * True when a record can be applied to this state. Records are written by
 * request handlers against a public testId, so a stale or hostile record
 * must never crash a replay: recompute is the creator's repair path and
 * has to survive anything already in the log. A record whose shape
 * disagrees with the config's current shape is simply skipped.
 */
function appliesTo(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "cell" | "slotSizes">
): boolean {
  return (
    Array.isArray(rec.slotSizes) &&
    rec.slotSizes.length === state.slotSizes.length &&
    rec.slotSizes.every((n, i) => n === state.slotSizes[i]) &&
    validCell(state.slotSizes, rec.cell)
  );
}

/**
 * Feature indices clamped to the model's dimension. An index past `dim`
 * reads undefined out of the matrix and silently turns the whole model
 * into NaN, so a record written under a different dim is dropped here
 * rather than poisoning the replay.
 */
function safeFeatIdx(dim: number, featIdx: number[] | null): number[] {
  const indices = (featIdx ?? [0]).filter(
    i => Number.isInteger(i) && i >= 0 && i < dim
  );
  return indices.length > 0 ? indices : [0];
}

/** Records a pull. Mutates state; callers own copy semantics. */
export function applyAssignment(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "cell" | "slotSizes" | "featIdx">
): void {
  if (!appliesTo(state, rec)) {
    return;
  }
  state.cells[rec.cell].pulls += 1;
  observe(state.model, safeFeatIdx(state.dim, rec.featIdx));
}

/** Records the FIRST reward (later rewards only accumulate on the record). */
export function applyFirstReward(
  state: DerivedState,
  rec: Pick<AssignmentRecord, "cell" | "slotSizes" | "featIdx">
): void {
  if (!appliesTo(state, rec)) {
    return;
  }
  state.cells[rec.cell].successes += 1;
  reward(state.model, safeFeatIdx(state.dim, rec.featIdx));
}

/**
 * Rebuilds derived state from the event log: the repair path for a
 * corrupted cache, and how prior changes take effect mid-test.
 */
export function recomputeState(
  events: Iterable<AssignmentRecord>,
  init: StateInit
): DerivedState {
  const state = newDerivedState(init);
  const ordered = [...events].sort((a, b) => a.firstSeen - b.firstSeen);
  for (const rec of ordered) {
    applyAssignment(state, rec);
    if (rec.rewardTotal > 0) {
      applyFirstReward(state, rec);
    }
  }
  return state;
}

/**
 * Serve-time choice: one Thompson draw over the joint model, the exactly
 * best cell under it. Also returns the features that made the choice, so
 * the caller can store them on the record and never re-derive hashing.
 */
export function choose(
  state: DerivedState,
  ctxFeatIdx: number[],
  rng: Rng,
  noise?: number
): { cell: number; featIdx: number[] } {
  const ctx = safeFeatIdx(state.dim, ctxFeatIdx);
  const cell = modelChooseCell(state.model, state.slotSizes, ctx, rng, noise);
  return {
    cell,
    featIdx: cellFeatures(state.dim, state.slotSizes, cell, ctx)
  };
}
