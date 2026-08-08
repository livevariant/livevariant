import type {
  AssignmentRecord,
  DerivedState,
  RequestSignals
} from "@livevariant/core";
import {
  mergePolicy,
  type StateStore,
  type TestPolicy,
  type TestShape
} from "@livevariant/server";
import { derivedToArtifacts } from "@livevariant/server";
import type { Queryable } from "./queryable.js";

/**
 * A StateStore whose event log and derived cache live in Postgres.
 *
 * The Durable Object deployment serializes every access to one test and
 * therefore gets away with read-modify-write throughout
 * (packages/workers/src/test-storage.ts says so in as many words). Nothing
 * else does, and an adapter that keeps that shape passes every sequential
 * test in the conformance suite and then loses conversions under real
 * traffic. So every method below that the contract calls atomic is ONE
 * statement, and the two that genuinely need more are transactions.
 *
 * The SQL is written out rather than built by an ORM because the exact
 * shapes are load-bearing: the no-op `DO UPDATE` that makes `RETURNING`
 * fire on the conflict path, the `xmax = 0` that distinguishes an insert
 * from a conflict, the `WHERE` on a `DO UPDATE` that turns an upsert into
 * a compare-and-set. See ./schema.ts for the drizzle table definitions,
 * which exist so an embedding application can own the migrations.
 */

const ASSIGNMENTS = "livevariant_assignments";
const COUNTERS = "livevariant_counters";
const BLOBS = "livevariant_blobs";
const SHAPES = "livevariant_shapes";
const POLICIES = "livevariant_policies";

/** Rows per round trip while streaming a test's log. */
const SCAN_PAGE = 500;

const ASSIGNMENT_COLUMNS =
  "cell, slot_sizes, dim, feat_idx, ctx_key, reward_total, sdk, first_seen, src_hash, signals";

interface AssignmentRow {
  cell: number;
  slot_sizes: number[];
  dim: number;
  feat_idx: number[];
  ctx_key: string | null;
  reward_total: number;
  sdk: string | null;
  /** int8 arrives as a string from node-postgres; ms epoch is safe in a number. */
  first_seen: string | number;
  src_hash: string | null;
  signals: RequestSignals | null;
}

function toRecord(row: AssignmentRow): AssignmentRecord {
  return {
    cell: row.cell,
    slotSizes: row.slot_sizes,
    dim: row.dim,
    featIdx: row.feat_idx,
    ctxKey: row.ctx_key,
    rewardTotal: row.reward_total,
    sdk: row.sdk,
    firstSeen: Number(row.first_seen),
    srcHash: row.src_hash,
    signals: row.signals
  };
}

/**
 * The store's keys are structured, not opaque: `counterKey` and
 * `modelKey` build them and are exported from the server package, so an
 * adapter is entitled to take them apart. Doing so buys real columns and
 * an indexed equality where a prefix `LIKE` would otherwise be needed to
 * wipe a test's counters.
 */
function parseCounterKey(key: string): { testId: string; scope: string } {
  const match = /^c:([^:]+):(.*)$/.exec(key);
  if (!match) {
    throw new Error(`not a LiveVariant counter key: ${key}`);
  }
  return { testId: match[1], scope: match[2] };
}

function parseModelKey(key: string): string {
  const match = /^m:(.+)$/.exec(key);
  if (!match) {
    throw new Error(`not a LiveVariant model key: ${key}`);
  }
  return match[1];
}

export class PostgresStore implements StateStore {
  constructor(private db: Queryable) {}

  // ------------------------------------------------ events (source of truth)

  async pinShape(
    testId: string,
    shape: TestShape,
    authoritative: boolean
  ): Promise<TestShape> {
    // The decoded config always wins; a JS-mode caller only ever pins on
    // first sight, which the no-op DO UPDATE expresses: it still returns
    // the stored row, so contested first-sighters all read one winner.
    const onConflict = authoritative
      ? "SET slot_sizes = EXCLUDED.slot_sizes, dim = EXCLUDED.dim"
      : `SET test_id = ${SHAPES}.test_id`;
    const { rows } = await this.db.query<{ slot_sizes: number[]; dim: number }>(
      `INSERT INTO ${SHAPES} (test_id, slot_sizes, dim)
       VALUES ($1, $2::int[], $3)
       ON CONFLICT (test_id) DO UPDATE ${onConflict}
       RETURNING slot_sizes, dim`,
      [testId, shape.slotSizes, shape.dim]
    );
    return { slotSizes: rows[0].slot_sizes, dim: rows[0].dim };
  }

  async getPolicy(testId: string): Promise<TestPolicy> {
    const { rows } = await this.db.query<{ policy: TestPolicy }>(
      `SELECT policy FROM ${POLICIES} WHERE test_id = $1`,
      [testId]
    );
    return rows[0]?.policy ?? {};
  }

  async updatePolicy(testId: string, patch: TestPolicy): Promise<TestPolicy> {
    return this.db.transaction(async tx => {
      // Upsert-to-itself both creates the row when absent and locks it
      // when present, so the read-merge-write below cannot interleave.
      const { rows } = await tx.query<{ policy: TestPolicy }>(
        `INSERT INTO ${POLICIES} (test_id, policy)
         VALUES ($1, '{}'::jsonb)
         ON CONFLICT (test_id) DO UPDATE SET policy = ${POLICIES}.policy
         RETURNING policy`,
        [testId]
      );
      // mergePolicy, not a spread: a patch that says nothing about a key
      // must not erase it (POST /exclude with only windows would wipe
      // every quarantined source).
      const merged = mergePolicy(rows[0].policy ?? {}, patch);
      await tx.query(`UPDATE ${POLICIES} SET policy = $2 WHERE test_id = $1`, [
        testId,
        JSON.stringify(merged)
      ]);
      return merged;
    });
  }

  async getAssignment(
    testId: string,
    idHash: string
  ): Promise<AssignmentRecord | null> {
    const { rows } = await this.db.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_COLUMNS} FROM ${ASSIGNMENTS}
       WHERE test_id = $1 AND id_hash = $2`,
      [testId, idHash]
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async putAssignmentIfAbsent(
    testId: string,
    idHash: string,
    rec: AssignmentRecord
  ): Promise<{ rec: AssignmentRecord; created: boolean }> {
    // One statement, because this is the unrepairable one: a visitor who
    // gets two variants poisons the test in a way no recompute can undo.
    // The DO UPDATE is a no-op whose only job is to make RETURNING fire on
    // the conflict path, so the loser of a race reads back the winner
    // without a second query. `xmax = 0` is only true for a row this
    // statement actually inserted.
    const { rows } = await this.db.query<AssignmentRow & { created: boolean }>(
      `INSERT INTO ${ASSIGNMENTS}
         (test_id, id_hash, cell, slot_sizes, dim, feat_idx, ctx_key,
          reward_total, sdk, first_seen, src_hash, signals)
       VALUES ($1, $2, $3, $4::int[], $5, $6::int[], $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (test_id, id_hash) DO UPDATE SET test_id = ${ASSIGNMENTS}.test_id
       RETURNING ${ASSIGNMENT_COLUMNS}, (xmax = 0) AS created`,
      [
        testId,
        idHash,
        rec.cell,
        rec.slotSizes,
        rec.dim,
        rec.featIdx,
        rec.ctxKey,
        rec.rewardTotal,
        rec.sdk ?? null,
        rec.firstSeen,
        rec.srcHash ?? null,
        rec.signals === undefined || rec.signals === null
          ? null
          : JSON.stringify(rec.signals)
      ]
    );
    return { rec: toRecord(rows[0]), created: rows[0].created };
  }

  async addReward(
    testId: string,
    idHash: string,
    amount: number,
    sdk?: string
  ): Promise<{ rec: AssignmentRecord; first: boolean } | null> {
    // Also one statement, and also permanent when it goes wrong: two
    // read-modify-write callers collapse two conversions into one.
    // RETURNING sees the post-value, so subtracting the delta recovers the
    // previous total, which is what makes `first` fire exactly once.
    // COALESCE backfills the SDK version without ever overwriting it.
    const { rows } = await this.db.query<AssignmentRow & { first: boolean }>(
      `UPDATE ${ASSIGNMENTS}
       SET reward_total = reward_total + $3, sdk = COALESCE(sdk, $4)
       WHERE test_id = $1 AND id_hash = $2
       RETURNING ${ASSIGNMENT_COLUMNS}, (reward_total - $3) = 0 AS first`,
      [testId, idHash, amount, sdk ?? null]
    );
    return rows[0] ? { rec: toRecord(rows[0]), first: rows[0].first } : null;
  }

  async *scanAssignments(testId: string): AsyncIterable<AssignmentRecord> {
    // Keyset pagination on the primary key: an OFFSET walk would re-read
    // the whole prefix on every page and drift under concurrent writes.
    let cursor = "";
    for (;;) {
      const { rows } = await this.db.query<AssignmentRow & { id_hash: string }>(
        `SELECT id_hash, ${ASSIGNMENT_COLUMNS} FROM ${ASSIGNMENTS}
         WHERE test_id = $1 AND id_hash > $2
         ORDER BY id_hash
         LIMIT ${SCAN_PAGE}`,
        [testId, cursor]
      );
      for (const row of rows) {
        yield toRecord(row);
      }
      if (rows.length < SCAN_PAGE) {
        return;
      }
      cursor = rows[rows.length - 1].id_hash;
    }
  }

  // ----------------------------------------------------- derived cache

  async incrCounters(key: string, deltas: number[]): Promise<void> {
    const { testId, scope } = parseCounterKey(key);
    // The hot path's deltas (pullDelta, successDelta) are full-length
    // arrays holding a single 1, so dropping zeros turns a serve into a
    // one-row upsert instead of a 1024-row one.
    const idx: number[] = [];
    const value: number[] = [];
    for (let i = 0; i < deltas.length; i++) {
      if (deltas[i] !== 0) {
        idx.push(i);
        value.push(deltas[i]);
      }
    }
    if (idx.length === 0) {
      return;
    }
    await this.db.query(
      `INSERT INTO ${COUNTERS} (test_id, scope, idx, value)
       SELECT $1, $2, d.idx, d.value
       FROM unnest($3::int[], $4::double precision[]) AS d(idx, value)
       ON CONFLICT (test_id, scope, idx)
       DO UPDATE SET value = ${COUNTERS}.value + EXCLUDED.value`,
      [testId, scope, idx, value]
    );
  }

  async getCounters(key: string, length: number): Promise<number[]> {
    const { testId, scope } = parseCounterKey(key);
    const { rows } = await this.db.query<{ idx: number; value: number }>(
      `SELECT idx, value FROM ${COUNTERS}
       WHERE test_id = $1 AND scope = $2 AND idx < $3`,
      [testId, scope, length]
    );
    const counters = new Array<number>(length).fill(0);
    for (const row of rows) {
      counters[row.idx] = row.value;
    }
    return counters;
  }

  async getBlob(
    key: string
  ): Promise<{ data: string; version: number } | null> {
    const { rows } = await this.db.query<{
      data: string | null;
      version: number;
    }>(`SELECT data, version FROM ${BLOBS} WHERE test_id = $1`, [
      parseModelKey(key)
    ]);
    const row = rows[0];
    // A row with no data means "no blob" while its version keeps
    // advancing, so a stale compare-and-set writer still loses.
    return row && row.data !== null
      ? { data: row.data, version: row.version }
      : null;
  }

  async putBlob(
    key: string,
    data: string,
    expectedVersion: number
  ): Promise<boolean> {
    // Compare-and-set, as two mutually exclusive arms of one statement.
    //
    // The UPDATE is the CAS: Postgres takes the row lock and re-evaluates
    // `version = $3` against the committed row, so of N writers holding
    // the same version exactly one updates and the rest match nothing.
    //
    // The INSERT is the first-write arm, and it is guarded on an expected
    // version of ZERO. Creating the row for a caller who believed some
    // other version was already there would let a stale writer win: it
    // asked to replace something, and there is nothing to replace.
    // ON CONFLICT DO NOTHING covers the race where another writer created
    // the row first, which is a lost CAS like any other.
    //
    // The two arms cannot both produce a row (a version is either 0 or it
    // is not), so a returned row means this call won.
    const { rowCount } = await this.db.query(
      `WITH updated AS (
         UPDATE ${BLOBS}
         SET data = $2, version = version + 1
         WHERE test_id = $1 AND version = $3::int
         RETURNING version
       ), created AS (
         INSERT INTO ${BLOBS} (test_id, data, version)
         SELECT $1, $2, 1 WHERE $3::int = 0
         ON CONFLICT (test_id) DO NOTHING
         RETURNING version
       )
       SELECT version FROM updated
       UNION ALL
       SELECT version FROM created`,
      [parseModelKey(key), data, expectedVersion]
    );
    return rowCount > 0;
  }

  async replaceDerived(testId: string, state: DerivedState): Promise<void> {
    const { counters, blob } = derivedToArtifacts(testId, state);
    await this.db.transaction(async tx => {
      // Wholesale, including scopes the snapshot no longer has: recompute
      // is the repair path for every derived-cache failure, so leaving an
      // old bucket behind would make healing impossible.
      await tx.query(`DELETE FROM ${COUNTERS} WHERE test_id = $1`, [testId]);
      for (const [key, values] of counters) {
        const { scope } = parseCounterKey(key);
        const idx: number[] = [];
        const value: number[] = [];
        for (let i = 0; i < values.length; i++) {
          if (values[i] !== 0) {
            idx.push(i);
            value.push(values[i]);
          }
        }
        if (idx.length === 0) {
          continue;
        }
        // Upsert, not a plain insert: serving traffic keeps incrementing
        // while this rebuilds, so a concurrent incrCounters can recreate a
        // row between the DELETE above and this write. A plain insert
        // would hit the primary key and abort the whole repair, which is
        // the one path that must not fail. The snapshot is authoritative,
        // so it overwrites; anything that lands after it is a real event
        // and survives on top.
        await tx.query(
          `INSERT INTO ${COUNTERS} (test_id, scope, idx, value)
           SELECT $1, $2, d.idx, d.value
           FROM unnest($3::int[], $4::double precision[]) AS d(idx, value)
           ON CONFLICT (test_id, scope, idx)
           DO UPDATE SET value = EXCLUDED.value`,
          [testId, scope, idx, value]
        );
      }
      await tx.query(
        `INSERT INTO ${BLOBS} (test_id, data, version)
         VALUES ($1, $2, 1)
         ON CONFLICT (test_id) DO UPDATE
           SET data = EXCLUDED.data, version = ${BLOBS}.version + 1`,
        [testId, blob]
      );
    });
  }
}
