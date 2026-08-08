/**
 * Plain SQL for the store's tables, for deployments that do not use
 * drizzle. Idempotent, so it is safe to run on every boot.
 *
 * An application embedding this package should NOT use this: re-export
 * ./schema.ts from its own drizzle schema instead and let its own
 * migration chain own these tables, which is the whole reason that module
 * is a separate entry point.
 *
 * This and ./schema.ts describe the same tables and must not drift.
 * `store.spec.ts` builds its fixture database from this SQL and then
 * compares the result against the drizzle definitions column by column,
 * so a change to one without the other fails the suite.
 */
export const LIVEVARIANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS livevariant_assignments (
  test_id text NOT NULL,
  id_hash text NOT NULL,
  cell integer NOT NULL,
  slot_sizes integer[] NOT NULL,
  dim integer NOT NULL,
  feat_idx integer[] NOT NULL,
  ctx_key text,
  reward_total double precision NOT NULL DEFAULT 0,
  sdk text,
  first_seen bigint NOT NULL,
  src_hash text,
  signals jsonb,
  CONSTRAINT livevariant_assignments_pkey PRIMARY KEY (test_id, id_hash)
);

CREATE TABLE IF NOT EXISTS livevariant_counters (
  test_id text NOT NULL,
  scope text NOT NULL,
  idx integer NOT NULL,
  value double precision NOT NULL DEFAULT 0,
  CONSTRAINT livevariant_counters_pkey PRIMARY KEY (test_id, scope, idx)
);

CREATE TABLE IF NOT EXISTS livevariant_blobs (
  test_id text PRIMARY KEY,
  data text,
  version integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS livevariant_shapes (
  test_id text PRIMARY KEY,
  slot_sizes integer[] NOT NULL,
  dim integer NOT NULL
);

CREATE TABLE IF NOT EXISTS livevariant_policies (
  test_id text PRIMARY KEY,
  policy jsonb NOT NULL DEFAULT '{}'::jsonb
);
`;
