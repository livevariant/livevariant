import type { AssignmentRecord, DerivedState } from "@livevariant/core";

/**
 * Storage contract for a LiveVariant backend. Assignment records are the
 * event-sourced source of truth; counters and blobs are the derived cache
 * the hot path reads. Every adapter must satisfy store.contract.spec.ts.
 */
/**
 * The serving shape a test was first seen with. JS-mode callers supply
 * armCount/alg/dim in the request body (the server never sees configs on
 * that path), and a testId is public, so without pinning anyone could
 * claim a foreign shape and write records the real config can't represent.
 */
export interface TestShape {
  armCount: number;
  alg: "ts" | "bucketed" | "linear";
  dim: number;
}

/**
 * Per-test server-side policy: the state that is NOT derived from the
 * config. Bootstrapped on first sight and mutable only by the creator
 * (stats secret). Every trust control lands here.
 */
export interface TestPolicy {
  shape?: TestShape;
  /** Source hashes the creator quarantined. */
  excludedSources?: string[];
  /** Time windows (ms epoch) the creator quarantined. */
  excludedWindows?: Array<{ since: number; until: number }>;
}

/**
 * Merges a policy patch, ignoring keys the caller left undefined. A plain
 * spread would set them to undefined and silently drop exclusions the
 * creator had already made: POST /exclude with only `windows` would wipe
 * every quarantined source.
 */
export function mergePolicy(
  current: TestPolicy,
  patch: TestPolicy
): TestPolicy {
  const merged: TestPolicy = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

export interface StateStore {
  // ------------------------------------------------ events (source of truth)

  /**
   * Records the shape and returns whatever is authoritative afterwards.
   * `authoritative` is true when the shape came from the decoded config
   * (redirect paths), which always wins; JS-mode callers pass false, so
   * they pin only on first sight and must agree from then on.
   */
  pinShape(
    testId: string,
    shape: TestShape,
    authoritative: boolean
  ): Promise<TestShape>;

  /** The test's policy record (empty object when nothing is set). */
  getPolicy(testId: string): Promise<TestPolicy>;

  /** Merges a patch into the policy; creator-authorized callers only. */
  updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy>;

  getAssignment(
    testId: string,
    idHash: string
  ): Promise<AssignmentRecord | null>;

  /**
   * Writes the record unless one exists; returns the record that is now
   * authoritative (the existing one when racing). Concurrent callers for
   * the same idHash must all observe the same winner.
   */
  putAssignmentIfAbsent(
    testId: string,
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }>;

  /**
   * Accumulates reward on an existing assignment. Returns null when no
   * assignment exists (reward without a recorded serve is dropped);
   * `first` is true exactly once per assignment, which is what gates the
   * single derived-state success update.
   */
  addReward(
    testId: string,
    idHash: string,
    amount: number
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null>;

  /** Streams every assignment of a test, for stats and recompute. */
  scanAssignments(testId: string): AsyncIterable<AssignmentRecord>;

  // ----------------------------------------------------- derived cache

  /** Atomically adds deltas to a counter array (missing = zeros). */
  incrCounters(key: string, deltas: number[]): Promise<void>;

  /** Reads a counter array, zero-filled to `length`. */
  getCounters(key: string, length: number): Promise<number[]>;

  /** Versioned blob for linear-model state. */
  getBlob(key: string): Promise<{ data: string; version: number } | null>;

  /** Compare-and-set; false means the caller must reload and retry. */
  putBlob(key: string, data: string, expectedVersion: number): Promise<boolean>;

  /**
   * Atomically replaces every derived artifact of a test with a freshly
   * recomputed snapshot (the recompute/repair path).
   */
  replaceDerived(testId: string, state: DerivedState): Promise<void>;
}

/** Counter key for a test's global (contextless) scope. */
export function counterKey(testId: string, scope: string): string {
  return `c:${testId}:${scope}`;
}

export const GLOBAL_SCOPE = "global";

/** Blob key for a test's linear-model state. */
export function linearKey(testId: string): string {
  return `l:${testId}`;
}
