# @livevariant/postgres

PostgreSQL state store for [LiveVariant](https://livevariant.com): the
event log and derived cache in Postgres, behind the same `StateStore`
contract the Durable Object deployment implements.

```bash
npm install @livevariant/postgres
```

## Use it

```ts
import { createApp } from "@livevariant/server";
import { PostgresStore, poolQueryable } from "@livevariant/postgres";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp({ store: new PostgresStore(poolQueryable(pool)) });
```

`poolQueryable` covers node-postgres. Anything else that can run a
parameterized statement and open a transaction can implement `Queryable`
directly: it is two methods, and the store needs nothing else.

The driver must support transactions (`replaceDerived` and `updatePolicy`
use them), which rules out HTTP-only drivers such as
`drizzle-orm/neon-http`. Use a wire-protocol connection.

## The tables

Five: `livevariant_assignments` (the event log), plus
`livevariant_counters`, `livevariant_blobs`, `livevariant_shapes` and
`livevariant_policies`. There are two ways to create them, and which one
you want depends on whether you already run migrations.

**If you use drizzle**, re-export the schema and let your own
`drizzle-kit generate` own these tables alongside your app's:

```ts
// src/db/schema.ts
export * from "@livevariant/postgres/schema";
```

drizzle-kit picks up re-exported tables, so they land in your migration
chain, get reviewed in your pull requests, and a column added by a future
version of this package shows up as a pending migration rather than as
drift. `drizzle-orm` is an optional peer dependency; only this entry point
needs it.

**Otherwise**, run the SQL:

```ts
import { LIVEVARIANT_SCHEMA_SQL } from "@livevariant/postgres";
await pool.query(LIVEVARIANT_SCHEMA_SQL);
```

It is idempotent, so running it on every boot is fine.

## Why the SQL is written out

Every method the store contract calls atomic is one statement, and the
shape of each one is load-bearing:

- `putAssignmentIfAbsent` upserts with a no-op `DO UPDATE`, so `RETURNING`
  fires on the conflict path and the loser of a race reads back the winner
  in the same round trip. `xmax = 0` distinguishes the insert.
- `addReward` returns the post-update row, so subtracting the delta
  recovers the previous total; that is what makes `first` fire exactly
  once per assignment.
- `putBlob` is a compare-and-set: the `WHERE` on the `DO UPDATE` is
  re-evaluated under the row lock, so of N writers holding the same
  version exactly one wins.
- `incrCounters` drops zero deltas, so a serve upserts one row rather than
  rewriting a thousand-element array.

The Durable Object deployment gets serialization for free and can use
plain read-modify-write. Postgres does not, and an adapter written that
way passes every sequential test and then loses conversions under real
traffic.

That claim is tested rather than asserted: the package runs LiveVariant's
`storeContract` twice, once against [PGlite](https://pglite.dev) (real
Postgres in WASM, no server needed) and once against a real server when
`LV_TEST_POSTGRES_URL` is set. Only the second one proves the concurrency
cases, because PGlite is a single connection and the races serialize; CI
runs both.

## License

AGPL-3.0
