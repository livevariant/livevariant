import type { AssignmentRecord, DerivedState } from "@livevariant/core";

/**
 * Storage contract for a LiveVariant backend. Assignment records are the
 * event-sourced source of truth; counters and blobs are the derived cache
 * the hot path reads.
 *
 * Every adapter must pass the conformance suite, importable from
 * `@livevariant/server/testing`:
 *
 *   import { storeContract } from "@livevariant/server/testing";
 *   storeContract("MyStore", () => new MyStore(client));
 *
 * THE CONCURRENCY CONTRACT, which is where adapters actually go wrong: a
 * store built as read-modify-write over a plain key-value API satisfies
 * every signature here, passes every sequential test, and corrupts data
 * under real traffic. The Durable Object deployment gets serialization
 * for free; nothing else does. What each method requires is written on
 * the method, but the map is:
 *
 * - Event log (`putAssignmentIfAbsent`, `addReward`): must be atomic at
 *   the storage layer. Failures here are PERMANENT, because the log is
 *   the source of truth; nothing downstream can reconstruct a lost
 *   reward or un-split a doubly-assigned visitor.
 * - Derived cache (`incrCounters`, `putBlob`, `replaceDerived`): must be
 *   atomic too, but failures here are REPAIRABLE, since `recompute`
 *   rebuilds the cache from the log. Wrong until healed, not forever.
 */
/**
 * The serving shape a test was first seen with: variant counts per slot
 * (canonical sorted order) and the model dimension. JS-mode callers
 * supply these in the request body (the server never sees configs on
 * that path), and a testId is public, so without pinning anyone could
 * claim a foreign shape and write records the real config can't represent.
 */
export interface TestShape {
  slotSizes: number[];
  dim: number;
}

/** Structural equality for shapes; array-valued, so no ===. */
export function sameShape(a: TestShape, b: TestShape): boolean {
  return (
    a.dim === b.dim &&
    a.slotSizes.length === b.slotSizes.length &&
    a.slotSizes.every((n, i) => n === b.slotSizes[i])
  );
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
   *
   * MUST be a single atomic operation in the storage layer: SQL
   * `INSERT ... ON CONFLICT DO NOTHING` + read back, a conditional put,
   * a transaction. Never `get` then `put`: two first-touch requests in
   * that window each create their own record, one visitor is shown two
   * variants, and the event log is permanently wrong.
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
   *
   * MUST be atomic per record: SQL `UPDATE ... SET total = total + ?`
   * with the previous total read in the same statement, or a serialized
   * queue per key. Read-modify-write loses concurrent conversions (two
   * reads of the same total collapse two purchases into one), and can
   * report `first` twice, double-counting a success in the derived
   * model. Rewards are part of the event log: losses are permanent.
   */
  addReward(
    testId: string,
    idHash: string,
    amount: number,
    /** Backfills rec.sdk when the record has none (tag-only visitors). */
    sdk?: string
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null>;

  /** Streams every assignment of a test, for stats and recompute. */
  scanAssignments(testId: string): AsyncIterable<AssignmentRecord>;

  // ----------------------------------------------------- derived cache

  /**
   * Adds deltas to a counter array (missing = zeros). MUST be an atomic
   * increment (SQL `SET n = n + ?`, Redis INCRBY, a serialized writer);
   * read-modify-write silently drops concurrent pulls. Derived cache, so
   * a recompute heals the damage, which excuses nothing about causing it.
   */
  incrCounters(key: string, deltas: number[]): Promise<void>;

  /** Reads a counter array, zero-filled to `length`. */
  getCounters(key: string, length: number): Promise<number[]>;

  /** Versioned blob for the joint-model state. */
  getBlob(key: string): Promise<{ data: string; version: number } | null>;

  /**
   * Compare-and-set: succeed only if the stored version still equals
   * `expectedVersion`, and at most one concurrent writer per version may
   * win. False means the caller reloads and retries. An adapter that
   * lets two writers succeed at one version silently discards one arm
   * of the model's update.
   */
  putBlob(key: string, data: string, expectedVersion: number): Promise<boolean>;

  /**
   * Atomically replaces every derived artifact of a test with a freshly
   * recomputed snapshot (the recompute/repair path).
   */
  replaceDerived(testId: string, state: DerivedState): Promise<void>;
}

/** Counter key for a test's per-cell pulls/successes array. */
export function counterKey(testId: string, scope: string): string {
  return `c:${testId}:${scope}`;
}

export const GLOBAL_SCOPE = "global";

/** Blob key for a test's joint-model state. */
export function modelKey(testId: string): string {
  return `m:${testId}`;
}
