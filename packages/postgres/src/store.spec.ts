import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import { storeContract } from "@livevariant/server/testing";
import { LIVEVARIANT_SCHEMA_SQL } from "./ddl.js";
import { poolQueryable, type Queryable } from "./queryable.js";
import {
  livevariantAssignments,
  livevariantBlobs,
  livevariantCounters,
  livevariantPolicies,
  livevariantShapes
} from "./schema.js";
import { PostgresStore } from "./store.js";

/**
 * The conformance suite, run twice over, and the difference between the
 * two runs is the whole point.
 *
 * PGlite is real Postgres compiled to WASM, so it proves the SQL: ON
 * CONFLICT ... DO UPDATE ... WHERE, xmax, RETURNING on the conflict path,
 * array parameters, transactions. It runs everywhere with nothing
 * installed, so it is the default.
 *
 * What it cannot prove is the reason the contract has concurrency cases at
 * all. PGlite is a single in-process connection, so the 20-way and 50-way
 * races serialize and never interleave, and a read-modify-write adapter
 * would sail through them exactly as contract.ts warns it does against
 * MemoryStore. Only a real server with real connections tests that, which
 * is what LV_TEST_POSTGRES_URL is for and what CI runs alongside this.
 */

/** PGlite's own transaction API, rather than hand-rolled BEGIN/COMMIT. */
function pgliteQueryable(db: PGlite): Queryable {
  const wrap = (
    run: (text: string, params?: readonly unknown[]) => Promise<unknown>
  ): Queryable["query"] => {
    return async <R>(text: string, params?: readonly unknown[]) => {
      const raw = (await run(text, params)) as {
        rows: unknown[];
        affectedRows?: number;
      };
      // A statement with RETURNING reports its effect as rows; one without
      // reports affectedRows. Taking the larger covers both without
      // caring which kind this was.
      return {
        rows: raw.rows as R[],
        rowCount: Math.max(raw.rows.length, raw.affectedRows ?? 0)
      };
    };
  };
  return {
    query: wrap((text, params) => db.query(text, params as unknown[])),
    transaction(fn) {
      return db.transaction(async tx =>
        fn({
          query: wrap((text, params) => tx.query(text, params as unknown[])),
          transaction: inner =>
            inner({
              query: wrap((text, params) =>
                tx.query(text, params as unknown[])
              ),
              transaction: deepest => deepest(this)
            })
        })
      ) as Promise<ReturnType<typeof fn> extends Promise<infer T> ? T : never>;
    }
  } as Queryable;
}

const pglite = await PGlite.create();
await pglite.exec(LIVEVARIANT_SCHEMA_SQL);

storeContract(
  "PostgresStore (PGlite)",
  () => new PostgresStore(pgliteQueryable(pglite))
);

/**
 * The drift guard between ./ddl.ts (what a plain self-hoster runs) and
 * ./schema.ts (what an embedding application generates its migrations
 * from). They describe the same tables, and nothing else would notice if
 * they stopped agreeing: the contract above only exercises the DDL.
 */
describe("schema.ts agrees with ddl.ts", () => {
  let actual: Map<string, Map<string, { nullable: boolean; type: string }>>;

  beforeAll(async () => {
    const { rows } = await pglite.query<{
      table_name: string;
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, is_nullable, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name LIKE 'livevariant_%'`
    );
    actual = new Map();
    for (const row of rows) {
      let table = actual.get(row.table_name);
      if (!table) {
        table = new Map();
        actual.set(row.table_name, table);
      }
      table.set(row.column_name, {
        nullable: row.is_nullable === "YES",
        type: row.data_type
      });
    }
  });

  const tables = [
    livevariantAssignments,
    livevariantCounters,
    livevariantBlobs,
    livevariantShapes,
    livevariantPolicies
  ];

  for (const table of tables) {
    const config = getTableConfig(table);
    it(`${config.name} has the same columns in both`, () => {
      const built = actual.get(config.name);
      expect(built, `${config.name} missing from ddl.ts`).toBeDefined();
      const declared = config.columns.map(column => column.name).sort();
      expect(declared).toEqual([...built!.keys()].sort());
      for (const column of config.columns) {
        expect(
          built!.get(column.name)!.nullable,
          `${config.name}.${column.name} nullability`
        ).toBe(!column.notNull && !column.primary);
      }
    });
  }
});

/**
 * The run that earns the atomicity claims. Skipped unless a real server is
 * pointed at, and CI points at one.
 */
const postgresUrl = process.env.LV_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)("PostgresStore (server)", () => {
  it("ran against a real Postgres", () => {
    expect(postgresUrl).toBeTruthy();
  });
});

if (postgresUrl) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: postgresUrl, max: 20 });
  await pool.query(LIVEVARIANT_SCHEMA_SQL);
  storeContract(
    "PostgresStore (server)",
    () => new PostgresStore(poolQueryable(pool))
  );
}
