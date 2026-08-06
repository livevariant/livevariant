/**
 * The AccountsProvider and TrustPolicy implementations for the hosted
 * deployment: the serving side's read-only view of the registry,
 * fronted by per-isolate TTL caches because these answers sit near (and
 * in Phase 4, on) hot paths.
 *
 * Failure bias is OPEN everywhere: a D1 outage degrades friction (more
 * interstitials, bearer secrets keep working), never availability.
 */
import { eq } from "drizzle-orm";
import { decodeConfig, verifyStatsSecret } from "@livevariant/core";
import {
  claimKey,
  listTests,
  publishableKeyOrg,
  registerTest
} from "./registry.js";
import type {
  AccountsProvider,
  KeyPolicy,
  RedirectVerdict,
  TrustPolicy
} from "@livevariant/server";
import { domains, keys, organization, tests } from "./schema.js";
import type { Auth, Db } from "./auth.js";

/** Positive entries live this long before a re-read. */
const TTL_MS = 60_000;
/**
 * Negative entries are shorter: "unclaimed" and "unregistered" are the
 * overwhelmingly common answers and must cost nothing, but a fresh
 * claim or verification has to surface promptly.
 */
const NEGATIVE_TTL_MS = 10_000;
/** Bounded per cache; eviction is oldest-inserted, which is enough. */
const MAX_ENTRIES = 500;

class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expires: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export class RegistryProvider implements AccountsProvider, TrustPolicy {
  private keyPolicies = new TtlCache<KeyPolicy | null>();
  private testOrgs = new TtlCache<string | null>();
  /** domain -> verifying orgId, or null when nobody has verified it. */
  private verifiedDomains = new TtlCache<string | null>();

  constructor(
    private db: Db,
    private auth: () => Auth
  ) {}

  async keyPolicy(kh: string): Promise<KeyPolicy | null> {
    const cached = this.keyPolicies.get(kh);
    if (cached !== undefined) {
      return cached;
    }
    let policy: KeyPolicy | null;
    try {
      const row = await this.db.query.keys.findFirst({
        where: eq(keys.kh, kh)
      });
      policy = row ? { orgId: row.orgId, lockReads: row.lockReads } : null;
    } catch {
      // Fail open: an unreadable registry must not lock anyone out of
      // the classic bearer path, only out of the extras it would grant.
      return null;
    }
    this.keyPolicies.set(kh, policy, policy ? TTL_MS : NEGATIVE_TTL_MS);
    return policy;
  }

  async testOrg(testId: string): Promise<string | null> {
    const cached = this.testOrgs.get(testId);
    if (cached !== undefined) {
      return cached;
    }
    let orgId: string | null;
    try {
      const row = await this.db.query.tests.findFirst({
        where: eq(tests.testId, testId)
      });
      orgId = row?.orgId ?? null;
    } catch {
      return null;
    }
    this.testOrgs.set(testId, orgId, orgId ? TTL_MS : NEGATIVE_TTL_MS);
    return orgId;
  }

  async sessionOrgIds(req: Request): Promise<string[]> {
    // The dominant caller is a manage page sending a bearer header and
    // no cookie at all: that case must pay exactly nothing.
    if (!req.headers.get("cookie")) {
      return [];
    }
    try {
      const session = await this.auth().api.getSession({
        headers: req.headers
      });
      const userId = session?.user.id;
      if (!userId) {
        return [];
      }
      const rows = await this.db.query.member.findMany({
        where: (member, { eq: whereEq }) => whereEq(member.userId, userId)
      });
      return rows.map(row => row.organizationId);
    } catch {
      return [];
    }
  }

  /**
   * Trust policy over the registry: a destination is quietly allowed
   * when its domain (or a parent) is verified by ANY org, because the
   * continue screen protects visitors from disguised destinations, and
   * a verified domain leads to the genuine site whoever authored the
   * test. Deliberately not scoped to the test's owner: scoping would
   * add no security (an attacker can claim their own test's key), and
   * it would keep the screen on every test built before the domain was
   * verified. Everything else external gets the screen; never `false`,
   * so verification removes friction and never adds denial.
   */
  async isDomainAllowedForRedirect(domain: string): Promise<RedirectVerdict> {
    for (const candidate of parentDomains(domain.toLowerCase())) {
      if ((await this.domainOwner(candidate)) !== null) {
        return true;
      }
    }
    return "interstitial";
  }

  /**
   * SDK origins stay open on the hosted deployment: locking belongs to
   * a per-key opt-in (a later phase), and until then any page may drive
   * a test exactly as before.
   */
  isOriginAllowedForSDK(): Promise<boolean> {
    return Promise.resolve(true);
  }

  listTests(
    orgIds: string[],
    options: { q?: string; cursor?: string; limit?: number }
  ) {
    return listTests(this.db, orgIds, options);
  }

  /**
   * SDK first-sight registration. The pair that earns it: a publishable
   * key resolving to an org AND a page origin whose domain that same
   * org has verified. Not a security boundary (both ride in public page
   * source); it grants registration and nothing else, and the verified
   * origin is what stops a copied key registering strangers' tests to
   * your account. Never throws: this runs in waitUntil where an error
   * helps nobody.
   */
  async registerFromSdk(input: {
    testId: string;
    encoded?: string;
    name?: string;
    region?: string;
    publishableKey: string;
    origin: string | null;
  }): Promise<void> {
    try {
      if (!input.origin) {
        return;
      }
      const known = await this.testOrg(input.testId);
      if (known) {
        return;
      }
      const orgId = await publishableKeyOrg(this.db, input.publishableKey);
      if (!orgId) {
        return;
      }
      let host: string;
      try {
        host = new URL(input.origin).hostname.toLowerCase();
      } catch {
        return;
      }
      for (const candidate of parentDomains(host)) {
        if ((await this.domainOwner(candidate)) === orgId) {
          await registerTest(this.db, {
            testId: input.testId,
            orgId,
            name: input.name,
            encoded: input.encoded || undefined,
            region: input.region
          });
          this.invalidateTest(input.testId);
          return;
        }
      }
    } catch {
      // Registration is best-effort by design.
    }
  }

  /**
   * Agent-path registration: the stats secret proves authority over the
   * test (its hash is inside the config's identity), the publishable
   * key only NAMES the org. Neither alone moves ownership: the pk is
   * public, and a config (with its kh) is a public artifact, so
   * kh-without-secret must never grant an org read access.
   */
  async registerWithSecret(input: {
    encoded: string;
    statsSecret: string;
    publishableKey: string;
  }): Promise<
    | { ok: true; org: string; testId: string }
    | {
        ok: false;
        reason:
          "bad-config" | "bad-secret" | "unknown-key" | "claimed-elsewhere";
      }
  > {
    let decoded;
    try {
      decoded = await decodeConfig(input.encoded);
    } catch {
      return { ok: false, reason: "bad-config" };
    }
    const kh = decoded.config.statsKeyHash;
    if (!kh) {
      // Keyless tests have no secret to prove with; they register
      // through the verified-domain tag path instead.
      return { ok: false, reason: "bad-config" };
    }
    if (!(await verifyStatsSecret(input.statsSecret, kh))) {
      // Indistinguishable from any other wrong-secret failure.
      return { ok: false, reason: "bad-secret" };
    }
    const orgId = await publishableKeyOrg(this.db, input.publishableKey);
    if (!orgId) {
      return { ok: false, reason: "unknown-key" };
    }
    const existing = await this.keyPolicy(kh);
    if (existing && existing.orgId !== orgId) {
      return { ok: false, reason: "claimed-elsewhere" };
    }
    if (!existing) {
      // Audit trail names the key that performed the claim; claimedBy
      // is deliberately not a user FK.
      await claimKey(this.db, {
        kh,
        orgId,
        userId: `pk:${input.publishableKey}`,
        label: decoded.config.name
      });
      this.invalidateKey(kh);
    }
    await registerTest(this.db, {
      testId: decoded.testId,
      orgId,
      kh,
      name: decoded.config.name,
      encoded: input.encoded,
      region: decoded.config.region
    });
    this.invalidateTest(decoded.testId);
    const org = await this.db.query.organization.findFirst({
      where: eq(organization.id, orgId)
    });
    return {
      ok: true,
      org: org?.name ?? "your organization",
      testId: decoded.testId
    };
  }

  /** Invalidate after a claim/verify so the acting isolate sees it now. */
  invalidateKey(kh: string): void {
    this.keyPolicies.delete(kh);
  }

  invalidateTest(testId: string): void {
    this.testOrgs.delete(testId);
  }

  invalidateDomain(domain: string): void {
    for (const candidate of parentDomains(domain.toLowerCase())) {
      this.verifiedDomains.delete(candidate);
    }
  }

  /** The org that VERIFIED a domain, or null. One cached read serves
   * both the global redirect verdict and org-scoped registration. */
  private async domainOwner(domain: string): Promise<string | null> {
    const cached = this.verifiedDomains.get(domain);
    if (cached !== undefined) {
      return cached;
    }
    let owner: string | null;
    try {
      const row = await this.db.query.domains.findFirst({
        where: eq(domains.domain, domain)
      });
      owner = row !== undefined && row.verifiedAt !== null ? row.orgId : null;
    } catch {
      return null;
    }
    this.verifiedDomains.set(domain, owner, owner ? TTL_MS : NEGATIVE_TTL_MS);
    return owner;
  }
}

/**
 * "shop.example.com" is covered by a verification of "example.com":
 * proving control of a registrable domain proves its subdomains. The
 * walk is bounded and never yields a bare TLD because domains.ts
 * refuses to store one.
 */
export function parentDomains(host: string): string[] {
  const parts = host.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out.length > 0 ? out : [host];
}
