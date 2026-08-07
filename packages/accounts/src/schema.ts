/**
 * The one schema module: Better Auth's tables (generated into
 * auth-schema.ts by `npx @better-auth/cli generate`, never hand-edited)
 * plus the ownership registry. drizzle-kit turns diffs of this file into
 * committed SQL under migrations/.
 *
 * Ownership model, in one paragraph: an org claims a KEY (`kh`, the
 * sha256 of a stats secret), never a test, because one secret spans
 * every campaign built from it, past and future. The `tests` table is a
 * convenience index so "My tests" can list and paginate; ownership is
 * entirely the key's, except for keyless SDK tests, which are owned by
 * the org that registered them (kh NULL).
 */
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text
} from "drizzle-orm/sqlite-core";
import { organization } from "./auth-schema.js";

export * from "./auth-schema.js";

export const keys = sqliteTable("keys", {
  /**
   * The public statsKeyHash (64 hex). As primary key it makes claiming
   * race-free on D1, which has no cross-request transactions: the claim
   * is one INSERT .. ON CONFLICT DO NOTHING plus a read-back, so
   * concurrent claims yield exactly one winner.
   */
  kh: text("kh").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  label: text("label"),
  /**
   * Off: the stats secret keeps working as a bearer capability. On:
   * creator-only endpoints additionally require a session in the owning
   * org. The containment story for a leaked secret; rotation is
   * impossible by construction (kh is inside the identity hash).
   */
  lockReads: integer("lock_reads", { mode: "boolean" })
    .default(false)
    .notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }).notNull(),
  /** Audit only, deliberately not a foreign key: users may come and go. */
  claimedBy: text("claimed_by").notNull()
});

export const tests = sqliteTable(
  "tests",
  {
    testId: text("test_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** NULL for keyless SDK tests registered via a publishable key. */
    kh: text("kh").references(() => keys.kh, { onDelete: "cascade" }),
    name: text("name"),
    /**
     * The base64url config, so the dashboard can render and read the
     * test. NULL only if registration ever happens without one; every
     * current path supplies it.
     */
    encoded: text("encoded"),
    region: text("region"),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull()
  },
  table => [
    // Keyset pagination for GET /account/tests: (org, addedAt DESC, id).
    index("tests_org_added_idx").on(table.orgId, table.addedAt, table.testId),
    index("tests_kh_idx").on(table.kh)
  ]
);

/**
 * Which registered tests reference which uploaded assets. Written when
 * a test is REGISTERED (the one chokepoint every ownership path runs
 * through), because that is the moment a config becomes attributable:
 * anonymous tests never store their config, so their assets stay as
 * anonymous as their tests, by design. Rows cascade with the listing,
 * so removal keeps this honest.
 */
export const assetRefs = sqliteTable(
  "asset_refs",
  {
    /** sha256 content hash: the /a/<id> asset id. */
    assetId: text("asset_id").notNull(),
    testId: text("test_id")
      .notNull()
      .references(() => tests.testId, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  table => [
    primaryKey({ columns: [table.assetId, table.testId] }),
    index("asset_refs_org").on(table.orgId),
    index("asset_refs_asset").on(table.assetId)
  ]
);

export const publishableKeys = sqliteTable(
  "publishable_keys",
  {
    /**
     * A PUBLIC identifier (pk_ prefix), safe in page source: paired
     * with a verified page origin it lets the SDK register tests to the
     * org, and grants nothing else. Not authentication: reading stats
     * still needs a session or a stats secret, and a forged pair cannot
     * move a model further than an anonymous /choose already could.
     */
    key: text("key").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    label: text("label"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  table => [index("publishable_keys_org_idx").on(table.orgId)]
);

export const domains = sqliteTable(
  "domains",
  {
    /**
     * Lowercased hostname, no scheme, no port. A GLOBAL primary key on
     * purpose: verification proves control of a domain, and one domain
     * cannot be controlled by two orgs, which gives conflicting claims
     * the same 409 shape as keys.
     */
    domain: text("domain").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** The value the owner publishes (DNS TXT or /.well-known). */
    token: text("token").notNull(),
    /** "dns-txt" | "well-known"; how it was (or will be) verified. */
    method: text("method").notNull(),
    /** NULL until a verification check succeeds. */
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
  },
  table => [index("domains_org_idx").on(table.orgId)]
);
