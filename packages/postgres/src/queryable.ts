/**
 * The whole database surface the store needs: parameterized SQL and a
 * transaction. Deliberately two methods and no query builder.
 *
 * The store's correctness lives in single statements whose exact shape
 * matters (`ON CONFLICT ... DO UPDATE ... WHERE`, `xmax = 0`, `RETURNING`
 * on the conflict path). Expressing those through an ORM would couple the
 * adapter to that ORM's version, so the SQL is written out and this port
 * is all that varies: node-postgres, a pooled client, PGlite in tests, or
 * anything else that can run a parameterized statement.
 *
 * The drizzle schema in ./schema.ts is a separate concern: it exists so an
 * embedding application can generate and own the migrations for these
 * tables. Nothing here depends on it.
 */

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<QueryResult<R>>;
  /**
   * Runs `fn` inside one transaction. Implementations must give `fn` a
   * Queryable bound to the SAME connection, or the statements inside land
   * outside the transaction and `replaceDerived` stops being atomic.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Structurally typed so the package needs no dependency on `pg` or its
 * types; any client with this shape works.
 */
export interface PgResultLike {
  rows: unknown[];
  rowCount: number | null;
}

export interface PgClientLike {
  query(text: string, params?: readonly unknown[]): Promise<PgResultLike>;
  release(): void;
}

export interface PgPoolLike {
  query(text: string, params?: readonly unknown[]): Promise<PgResultLike>;
  connect(): Promise<PgClientLike>;
}

function resultOf<R>(raw: PgResultLike): QueryResult<R> {
  return { rows: raw.rows as R[], rowCount: raw.rowCount ?? raw.rows.length };
}

/**
 * A Queryable over one already-checked-out connection. Nested
 * `transaction` calls run inline rather than opening a second one: the
 * store never nests, and a savepoint here would only hide it if it did.
 */
function clientQueryable(client: PgClientLike): Queryable {
  const self: Queryable = {
    async query(text, params) {
      return resultOf(await client.query(text, params));
    },
    transaction(fn) {
      return fn(self);
    }
  };
  return self;
}

/** A Queryable over a node-postgres style pool. */
export function poolQueryable(pool: PgPoolLike): Queryable {
  return {
    async query(text, params) {
      return resultOf(await pool.query(text, params));
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(clientQueryable(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // A failed ROLLBACK must not mask the error that caused it.
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    }
  };
}
