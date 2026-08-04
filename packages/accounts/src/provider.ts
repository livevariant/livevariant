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
import { listTests, publishableKeyOrg, registerTest } from "./registry.js";
import type {
  AccountsProvider,
  KeyPolicy,
  RedirectVerdict,
  TrustPolicy
} from "@livevariant/server";
import { domains, keys, tests } from "./schema.js";
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
  private verifiedDomains = new TtlCache<boolean>();

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
   * only when its domain (or a parent) is verified by the org owning
   * the test; everything else external gets the continue screen. Never
   * `false`: verification removes friction, it never adds denial.
   */
  async isDomainAllowedForRedirect(
    domain: string,
    ctx: { testId: string; statsKeyHash?: string }
  ): Promise<RedirectVerdict> {
    const owner = await this.ownerOrg(ctx);
    if (!owner) {
      return "interstitial";
    }
    const host = domain.toLowerCase();
    const candidates = parentDomains(host);
    for (const candidate of candidates) {
      if (await this.domainVerifiedBy(candidate, owner)) {
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
        if (await this.domainVerifiedBy(candidate, orgId)) {
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

  /** Invalidate after a claim/verify so the acting isolate sees it now. */
  invalidateKey(kh: string): void {
    this.keyPolicies.delete(kh);
  }

  invalidateTest(testId: string): void {
    this.testOrgs.delete(testId);
  }

  invalidateDomain(orgId: string, domain: string): void {
    // Entries are keyed "orgId|domain" (domainVerifiedBy); a bare-domain
    // delete would silently never match.
    for (const candidate of parentDomains(domain.toLowerCase())) {
      this.verifiedDomains.delete(`${orgId}|${candidate}`);
    }
  }

  private async ownerOrg(ctx: {
    testId: string;
    statsKeyHash?: string;
  }): Promise<string | null> {
    if (ctx.statsKeyHash) {
      const policy = await this.keyPolicy(ctx.statsKeyHash);
      if (policy) {
        return policy.orgId;
      }
    }
    return this.testOrg(ctx.testId);
  }

  private async domainVerifiedBy(
    domain: string,
    orgId: string
  ): Promise<boolean> {
    const cacheKey = `${orgId}|${domain}`;
    const cached = this.verifiedDomains.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    let verified: boolean;
    try {
      const row = await this.db.query.domains.findFirst({
        where: eq(domains.domain, domain)
      });
      verified =
        row !== undefined && row.orgId === orgId && row.verifiedAt !== null;
    } catch {
      return false;
    }
    this.verifiedDomains.set(
      cacheKey,
      verified,
      verified ? TTL_MS : NEGATIVE_TTL_MS
    );
    return verified;
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
