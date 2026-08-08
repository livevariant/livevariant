import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import { counterKey, GLOBAL_SCOPE, modelKey } from "@livevariant/server";
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
 * Two cases the shared contract does not reach, both found in review, both
 * about what happens when this adapter is used the way a real deployment
 * uses it rather than the way a sequential test does.
 */
function extraCases(name: string, make: () => PostgresStore): void {
  describe(name, () => {
    function freshTestId(): string {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    }

    it("refuses to create a blob for a caller expecting a version", async () => {
      // A nonzero expected version means the caller believed a row was
      // already there. There is nothing to compare and set against, so
      // creating it would let a stale writer win by arriving late.
      const store = make();
      const key = modelKey(freshTestId());
      expect(await store.putBlob(key, "stale", 5)).toBe(false);
      expect(await store.getBlob(key)).toBeNull();
    });

    it("still lets a current writer set a later version", async () => {
      // The obvious fix for the case above (gating the whole statement on
      // version zero) breaks this one, which is the normal path: the model
      // update loop reads, computes and compare-and-sets forever after.
      const store = make();
      const key = modelKey(freshTestId());
      expect(await store.putBlob(key, "v1", 0)).toBe(true);
      const first = await store.getBlob(key);
      expect(await store.putBlob(key, "v2", first!.version)).toBe(true);
      const second = await store.getBlob(key);
      expect(second!.data).toBe("v2");
      expect(second!.version).toBe(first!.version + 1);
      expect(await store.putBlob(key, "late", first!.version)).toBe(false);
    });

    it("rebuilds derived state while traffic keeps incrementing", async () => {
      // recompute is the repair path for every derived-cache failure, so
      // it is the one thing that must not abort. Serving does not stop
      // while it runs, and a counter row recreated between the wipe and
      // the rewrite used to collide with the snapshot's insert.
      const store = make();
      const testId = freshTestId();
      const key = counterKey(testId, GLOBAL_SCOPE);
      await store.incrCounters(key, [5, 1, 5, 1]);
      await Promise.all([
        store.replaceDerived(testId, {
          slotSizes: [2],
          dim: 16,
          cells: [
            { pulls: 3, successes: 1 },
            { pulls: 4, successes: 2 }
          ],
          model: {
            aInv: Array.from({ length: 16 }, (_, i) =>
              Array.from({ length: 16 }, (_, j) => (i === j ? 1 : 0))
            ),
            b: new Array<number>(16).fill(0)
          }
        }),
        ...Array.from({ length: 20 }, () =>
          store.incrCounters(key, [1, 0, 0, 0])
        )
      ]);
      // The snapshot landed; the exact totals depend on interleaving, which
      // is the point: a recompute racing traffic must survive, not be exact.
      const counters = await store.getCounters(key, 4);
      expect(counters[1]).toBe(1);
      expect(counters[3]).toBe(2);
      expect(counters[0]).toBeGreaterThanOrEqual(3);
    });
  });
}

extraCases(
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
  extraCases(
    "PostgresStore (server)",
    () => new PostgresStore(poolQueryable(pool))
  );
}
