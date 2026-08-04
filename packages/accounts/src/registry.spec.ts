import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { createDb, type Db } from "./auth.js";
import {
  addDomain,
  claimKey,
  createPublishableKey,
  listKeys,
  listTests,
  markDomainVerified,
  registerTest,
  setLockReads
} from "./registry.js";
import { member, organization, user } from "./schema.js";
import { RegistryProvider } from "./provider.js";

/**
 * The registry contract against REAL D1 (wrangler's local simulator),
 * because the cases that matter here are exactly the ones a sequential
 * in-memory test cannot see: concurrent claims must yield one winner,
 * and cascades must run in the actual engine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

let proxy: Awaited<ReturnType<typeof getPlatformProxy>>;
let db: Db;

async function applyMigrations(d1: D1Database) {
  const dir = join(root, "packages", "accounts", "migrations");
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) {
        await d1.prepare(trimmed).run();
      }
    }
  }
}

beforeAll(async () => {
  proxy = await getPlatformProxy({
    configPath: join(root, "wrangler.jsonc"),
    environment: "production",
    persist: false
  });
  const d1 = (proxy.env as { LV_ACCOUNTS_DB: D1Database }).LV_ACCOUNTS_DB;
  await applyMigrations(d1);
  db = createDb(d1);
});

afterAll(async () => {
  await proxy.dispose();
});

let seq = 0;

async function makeOrg(): Promise<{ orgId: string; userId: string }> {
  const orgId = `org-${++seq}`;
  const userId = `user-${seq}`;
  await db.insert(user).values({
    id: userId,
    name: `User ${seq}`,
    email: `user-${seq}@example.com`
  });
  await db.insert(organization).values({
    id: orgId,
    name: `Org ${seq}`,
    slug: `org-${seq}`,
    createdAt: new Date()
  });
  await db.insert(member).values({
    id: `member-${seq}`,
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date()
  });
  return { orgId, userId };
}

function freshKh(): string {
  return `${seq}${Date.now()}`.padEnd(64, "a").slice(0, 64);
}

describe("claiming", () => {
  let orgA: { orgId: string; userId: string };
  let orgB: { orgId: string; userId: string };

  beforeEach(async () => {
    orgA = await makeOrg();
    orgB = await makeOrg();
  });

  it("claims, is idempotent for the same org, conflicts for another", async () => {
    const kh = freshKh();
    const first = await claimKey(db, { kh, ...orgA, label: "newsletter" });
    expect(first.status).toBe("claimed");
    const again = await claimKey(db, { kh, ...orgA });
    expect(again.status).toBe("already-yours");
    expect(again.key?.label).toBe("newsletter");
    const stranger = await claimKey(db, { kh, ...orgB });
    expect(stranger.status).toBe("conflict");
  });

  it("yields exactly one winner under concurrency", async () => {
    const kh = freshKh();
    const results = await Promise.all([
      claimKey(db, { kh, ...orgA }),
      claimKey(db, { kh, ...orgB }),
      claimKey(db, { kh, ...orgA }),
      claimKey(db, { kh, ...orgB })
    ]);
    const winners = results.filter(r => r.status !== "conflict");
    const owners = new Set(
      results.filter(r => r.status !== "conflict").map(r => r.key?.kh)
    );
    expect(winners.length).toBeGreaterThan(0);
    expect(owners.size).toBe(1);
    // Every non-conflict result agrees on one org: read back and check
    // both orgs' key lists disagree about who holds it.
    const aKeys = await listKeys(db, orgA.orgId);
    const bKeys = await listKeys(db, orgB.orgId);
    expect(aKeys.some(k => k.kh === kh) !== bKeys.some(k => k.kh === kh)).toBe(
      true
    );
  });

  it("locks and unlocks only for the owning org", async () => {
    const kh = freshKh();
    await claimKey(db, { kh, ...orgA });
    expect(await setLockReads(db, orgB.orgId, kh, true)).toBe(false);
    expect(await setLockReads(db, orgA.orgId, kh, true)).toBe(true);
    const provider = new RegistryProvider(db, () => {
      throw new Error("auth not needed");
    });
    expect(await provider.keyPolicy(kh)).toEqual({
      orgId: orgA.orgId,
      lockReads: true
    });
  });
});

describe("test listing", () => {
  it("paginates by keyset and filters by name", async () => {
    const org = await makeOrg();
    const kh = freshKh();
    await claimKey(db, { kh, ...org });
    for (let i = 0; i < 7; i++) {
      await registerTest(db, {
        testId: `t${i}`.padEnd(64, "0"),
        orgId: org.orgId,
        kh,
        name: i % 2 === 0 ? `newsletter ${i}` : `homepage ${i}`,
        encoded: `enc-${i}`
      });
    }
    const page1 = await listTests(db, org.orgId, { limit: 3 });
    expect(page1.tests).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listTests(db, org.orgId, {
      limit: 3,
      cursor: page1.nextCursor!
    });
    expect(page2.tests).toHaveLength(3);
    const ids = new Set(
      [...page1.tests, ...page2.tests].map(test => test.testId)
    );
    expect(ids.size).toBe(6);
    const filtered = await listTests(db, org.orgId, { q: "newsletter" });
    expect(filtered.tests.length).toBe(4);
    expect(
      filtered.tests.every(test => test.name?.includes("newsletter"))
    ).toBe(true);
  });

  it("registering the same test twice is a no-op", async () => {
    const org = await makeOrg();
    const kh = freshKh();
    await claimKey(db, { kh, ...org });
    const testId = "dup".padEnd(64, "d");
    await registerTest(db, {
      testId,
      orgId: org.orgId,
      kh,
      encoded: "enc"
    });
    await registerTest(db, {
      testId,
      orgId: org.orgId,
      kh,
      encoded: "enc-other"
    });
    const page = await listTests(db, org.orgId);
    const rows = page.tests.filter(test => test.testId === testId);
    expect(rows).toHaveLength(1);
    expect(rows[0].encoded).toBe("enc");
  });
});

describe("domains", () => {
  it("one domain, one org, conflict shape matches keys", async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const domain = `site-${seq}.example`;
    expect(
      await addDomain(db, {
        domain,
        orgId: orgA.orgId,
        token: "tok-1",
        method: "dns-txt"
      })
    ).toBe("added");
    expect(
      await addDomain(db, {
        domain,
        orgId: orgA.orgId,
        token: "tok-2",
        method: "dns-txt"
      })
    ).toBe("exists");
    expect(
      await addDomain(db, {
        domain,
        orgId: orgB.orgId,
        token: "tok-3",
        method: "dns-txt"
      })
    ).toBe("conflict");
  });
});

describe("SDK first-sight registration", () => {
  async function providerWithVerifiedDomain() {
    const org = await makeOrg();
    const domain = `sdk-${seq}.example`;
    await addDomain(db, {
      domain,
      orgId: org.orgId,
      token: "tok",
      method: "dns-txt"
    });
    await markDomainVerified(db, org.orgId, domain, "dns-txt", true);
    const pk = await createPublishableKey(db, org.orgId, "site");
    const provider = new RegistryProvider(db, () => {
      throw new Error("auth not needed");
    });
    return { org, domain, pk, provider };
  }

  it("registers for a publishable key on a verified origin, once", async () => {
    const { org, domain, pk, provider } = await providerWithVerifiedDomain();
    const testId = `sdk-t-${seq}`.padEnd(64, "e");
    await provider.registerFromSdk({
      testId,
      encoded: "enc-sdk",
      publishableKey: pk.key,
      origin: `https://shop.${domain}`
    });
    const page = await listTests(db, org.orgId);
    const row = page.tests.find(t => t.testId === testId);
    expect(row?.encoded).toBe("enc-sdk");
    // Registered rows stay put; a second sight changes nothing.
    await provider.registerFromSdk({
      testId,
      encoded: "enc-other",
      publishableKey: pk.key,
      origin: `https://${domain}`
    });
    const again = await listTests(db, org.orgId);
    expect(
      again.tests.filter(t => t.testId === testId).map(t => t.encoded)
    ).toEqual(["enc-sdk"]);
  });

  it("refuses unverified origins and unknown keys", async () => {
    const { org, pk, provider } = await providerWithVerifiedDomain();
    const testId = `sdk-x-${seq}`.padEnd(64, "f");
    await provider.registerFromSdk({
      testId,
      encoded: "enc",
      publishableKey: pk.key,
      origin: "https://stranger.example"
    });
    await provider.registerFromSdk({
      testId,
      encoded: "enc",
      publishableKey: "pk_000000000000000000000000",
      origin: "https://stranger.example"
    });
    const page = await listTests(db, org.orgId);
    expect(page.tests.some(t => t.testId === testId)).toBe(false);
  });

  it("makes the redirect verdict true for a verified destination", async () => {
    const { domain, pk, provider } = await providerWithVerifiedDomain();
    const testId = `sdk-v-${seq}`.padEnd(64, "a");
    await provider.registerFromSdk({
      testId,
      encoded: "enc",
      publishableKey: pk.key,
      origin: `https://${domain}`
    });
    provider.invalidateTest(testId);
    const ctx = { testId, requestUrl: "https://serve.test/s/x" };
    expect(
      await provider.isDomainAllowedForRedirect(`shop.${domain}`, ctx)
    ).toBe(true);
    expect(
      await provider.isDomainAllowedForRedirect("elsewhere.example", ctx)
    ).toBe("interstitial");
  });
});
