/**
 * The ownership registry over Drizzle/D1: claimed keys, registered
 * tests, verified domains. Every write here is shaped for D1's
 * no-cross-request-transactions reality: claims are single-statement
 * upserts with a read-back, so concurrency yields exactly one winner
 * instead of a double claim.
 */
import { and, desc, eq, like, lt, or, sql } from "drizzle-orm";
import { domains, keys, tests } from "./schema.js";
import type { Db } from "./auth.js";

export interface ClaimResult {
  status: "claimed" | "already-yours" | "conflict";
  key?: {
    kh: string;
    label: string | null;
    lockReads: boolean;
    claimedAt: number;
  };
}

export async function claimKey(
  db: Db,
  input: {
    kh: string;
    orgId: string;
    userId: string;
    label?: string;
  }
): Promise<ClaimResult> {
  // One statement, no read-first: the primary key decides the race.
  const inserted = await db
    .insert(keys)
    .values({
      kh: input.kh,
      orgId: input.orgId,
      label: input.label ?? null,
      lockReads: false,
      claimedAt: new Date(),
      claimedBy: input.userId
    })
    .onConflictDoNothing();
  const row = await db.query.keys.findFirst({
    where: eq(keys.kh, input.kh)
  });
  // The insert either won or hit an existing row; either way it exists.
  if (!row) {
    throw new Error("claim read-back found no row");
  }
  if (row.orgId !== input.orgId) {
    return { status: "conflict" };
  }
  return {
    status: inserted.meta.changes > 0 ? "claimed" : "already-yours",
    key: {
      kh: row.kh,
      label: row.label,
      lockReads: row.lockReads,
      claimedAt: row.claimedAt.getTime()
    }
  };
}

export async function releaseKey(
  db: Db,
  orgId: string,
  kh: string
): Promise<boolean> {
  const result = await db
    .delete(keys)
    .where(and(eq(keys.kh, kh), eq(keys.orgId, orgId)));
  return result.meta.changes > 0;
}

export async function setLockReads(
  db: Db,
  orgId: string,
  kh: string,
  lockReads: boolean
): Promise<boolean> {
  const result = await db
    .update(keys)
    .set({ lockReads })
    .where(and(eq(keys.kh, kh), eq(keys.orgId, orgId)));
  return result.meta.changes > 0;
}

export async function listKeys(db: Db, orgId: string) {
  const rows = await db
    .select({
      kh: keys.kh,
      label: keys.label,
      lockReads: keys.lockReads,
      claimedAt: keys.claimedAt,
      testCount: sql<number>`(
        select count(*) from ${tests} where ${tests.kh} = ${keys.kh}
      )`
    })
    .from(keys)
    .where(eq(keys.orgId, orgId))
    .orderBy(desc(keys.claimedAt));
  return rows.map(row => ({ ...row, claimedAt: row.claimedAt.getTime() }));
}

/**
 * Registers a test under an org (and optionally under a claimed key).
 * Idempotent: a testId is content-addressed, so re-registering the same
 * test is a no-op rather than an error.
 */
export async function registerTest(
  db: Db,
  input: {
    testId: string;
    orgId: string;
    kh?: string;
    name?: string;
    encoded: string;
    region?: string;
  }
): Promise<void> {
  await db
    .insert(tests)
    .values({
      testId: input.testId,
      orgId: input.orgId,
      kh: input.kh ?? null,
      name: input.name ?? null,
      encoded: input.encoded,
      region: input.region ?? null,
      addedAt: new Date()
    })
    .onConflictDoNothing();
}

export interface TestPage {
  tests: Array<{
    testId: string;
    kh: string | null;
    name: string | null;
    encoded: string;
    region: string | null;
    addedAt: number;
  }>;
  nextCursor: string | null;
}

/**
 * Keyset pagination on (addedAt DESC, testId), never OFFSET, so a test
 * created mid-scroll cannot shift a page. `q` is a substring filter on
 * the name, a convenience over one org's own tests, not a search engine.
 */
export async function listTests(
  db: Db,
  orgId: string,
  options: { q?: string; cursor?: string; limit?: number } = {}
): Promise<TestPage> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const conditions = [eq(tests.orgId, orgId)];
  if (options.q) {
    // Escape LIKE wildcards so a literal % in a name stays literal.
    const escaped = options.q.replace(/[\\%_]/g, ch => `\\${ch}`);
    conditions.push(like(tests.name, `%${escaped}%`));
  }
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    const at = new Date(cursor.addedAt);
    conditions.push(
      or(
        lt(tests.addedAt, at),
        and(eq(tests.addedAt, at), lt(tests.testId, cursor.testId))
      )!
    );
  }
  const rows = await db
    .select()
    .from(tests)
    .where(and(...conditions))
    .orderBy(desc(tests.addedAt), desc(tests.testId))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map(row => ({
    testId: row.testId,
    kh: row.kh,
    name: row.name,
    encoded: row.encoded,
    region: row.region,
    addedAt: row.addedAt.getTime()
  }));
  const last = page[page.length - 1];
  return {
    tests: page,
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(last.addedAt, last.testId)
        : null
  };
}

function encodeCursor(addedAt: number, testId: string): string {
  return btoa(`${addedAt}:${testId}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(
  cursor: string | undefined
): { addedAt: number; testId: string } | null {
  if (!cursor) {
    return null;
  }
  try {
    const raw = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const idx = raw.indexOf(":");
    const addedAt = Number(raw.slice(0, idx));
    const testId = raw.slice(idx + 1);
    if (!Number.isFinite(addedAt) || !testId) {
      return null;
    }
    return { addedAt, testId };
  } catch {
    return null;
  }
}

export async function addDomain(
  db: Db,
  input: { domain: string; orgId: string; token: string; method: string }
): Promise<"added" | "exists" | "conflict"> {
  await db
    .insert(domains)
    .values({
      domain: input.domain,
      orgId: input.orgId,
      token: input.token,
      method: input.method,
      createdAt: new Date()
    })
    .onConflictDoNothing();
  const row = await db.query.domains.findFirst({
    where: eq(domains.domain, input.domain)
  });
  if (!row) {
    throw new Error("domain read-back found no row");
  }
  if (row.orgId !== input.orgId) {
    return "conflict";
  }
  return row.token === input.token ? "added" : "exists";
}

export async function listDomains(db: Db, orgId: string) {
  const rows = await db.query.domains.findMany({
    where: eq(domains.orgId, orgId)
  });
  return rows.map(row => ({
    domain: row.domain,
    method: row.method,
    token: row.token,
    verifiedAt: row.verifiedAt?.getTime() ?? null,
    checkedAt: row.checkedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime()
  }));
}

export async function removeDomain(
  db: Db,
  orgId: string,
  domain: string
): Promise<boolean> {
  const result = await db
    .delete(domains)
    .where(and(eq(domains.domain, domain), eq(domains.orgId, orgId)));
  return result.meta.changes > 0;
}

export async function markDomainVerified(
  db: Db,
  orgId: string,
  domain: string,
  method: string,
  verified: boolean
): Promise<void> {
  await db
    .update(domains)
    .set({
      method,
      checkedAt: new Date(),
      ...(verified ? { verifiedAt: new Date() } : {})
    })
    .where(and(eq(domains.domain, domain), eq(domains.orgId, orgId)));
}
