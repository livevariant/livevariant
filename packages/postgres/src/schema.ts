import type { RequestSignals } from "@livevariant/core";
import type { TestPolicy } from "@livevariant/server";
import {
  bigint,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text
} from "drizzle-orm/pg-core";

/**
 * The drizzle schema for the Postgres store, exported as its own entry
 * point so an embedding application can re-export it from its own schema
 * module and let its own `drizzle-kit generate` own these tables:
 *
 *   export * from "@livevariant/postgres/schema";
 *
 * That is the point of shipping it. An application that keeps its
 * migrations under review in its own repository should not also have to
 * mirror these table definitions by hand, because a mirror is a second
 * source of truth and drifts. A column added here shows up in the
 * application as a pending migration instead.
 *
 * `drizzle-orm` is an optional PEER dependency: the store itself runs on
 * plain SQL and needs none of this. Importing this module is what pulls
 * drizzle in, so a self-hoster who only wants the store never pays for it
 * (they can apply the package's own `drizzle/` migrations instead).
 *
 * Nothing here is imported by the store. The tables are the contract
 * between the two, and `store.spec.ts` builds its fixture database from
 * these definitions so a change in one that the other does not expect
 * fails the suite.
 */

/**
 * The event log: one row per (test, visitor), and the source of truth for
 * everything else. `feat_idx`, `slot_sizes` and `dim` are stored as served
 * so replay never re-derives hashing and a record survives the config's
 * context definition changing under it.
 */
export const livevariantAssignments = pgTable(
  "livevariant_assignments",
  {
    testId: text("test_id").notNull(),
    idHash: text("id_hash").notNull(),
    cell: integer("cell").notNull(),
    slotSizes: integer("slot_sizes").array().notNull(),
    dim: integer("dim").notNull(),
    featIdx: integer("feat_idx").array().notNull(),
    ctxKey: text("ctx_key"),
    rewardTotal: doublePrecision("reward_total").notNull().default(0),
    sdk: text("sdk"),
    /** ms epoch, and the replay order for recompute. */
    firstSeen: bigint("first_seen", { mode: "number" }).notNull(),
    srcHash: text("src_hash"),
    signals: jsonb("signals").$type<RequestSignals>()
  },
  table => [
    // Also the scan index: keyset pagination reads
    // `WHERE test_id = $1 AND id_hash > $2 ORDER BY id_hash`.
    primaryKey({ columns: [table.testId, table.idHash] })
  ]
);

/**
 * Derived cache: per-cell pulls and successes, ONE ROW PER INDEX into the
 * flat `[pulls0, successes0, pulls1, ...]` array the store contract talks
 * in.
 *
 * A single array column would look tidier and be worse. The deltas the hot
 * path writes (`pullDelta`, `successDelta`) are full-length arrays with a
 * single 1 in them, so a row-per-index layout turns a serve into a
 * one-row upsert, where an array column would rewrite up to 1024 elements
 * on every request. It also keeps the increment a plain
 * `ON CONFLICT DO UPDATE SET value = value + EXCLUDED.value`, with no
 * custom SQL function to install.
 */
export const livevariantCounters = pgTable(
  "livevariant_counters",
  {
    testId: text("test_id").notNull(),
    /** "global", or an opaque per-test context bucket key. */
    scope: text("scope").notNull(),
    idx: integer("idx").notNull(),
    value: doublePrecision("value").notNull().default(0)
  },
  table => [primaryKey({ columns: [table.testId, table.scope, table.idx] })]
);

/**
 * The joint model, as one versioned JSON blob. `data` is nullable on
 * purpose: a snapshot may store no model while the version still
 * advances, so a compare-and-set writer holding the old version still
 * loses its race.
 */
export const livevariantBlobs = pgTable("livevariant_blobs", {
  testId: text("test_id").primaryKey(),
  data: text("data"),
  version: integer("version").notNull().default(0)
});

/** The serving shape a test was first seen with, pinned against tampering. */
export const livevariantShapes = pgTable("livevariant_shapes", {
  testId: text("test_id").primaryKey(),
  slotSizes: integer("slot_sizes").array().notNull(),
  dim: integer("dim").notNull()
});

/** Per-test creator policy: quarantined sources and time windows. */
export const livevariantPolicies = pgTable("livevariant_policies", {
  testId: text("test_id").primaryKey(),
  policy: jsonb("policy").$type<TestPolicy>().notNull().default({})
});
