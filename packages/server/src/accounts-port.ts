/**
 * The accounts port: everything the serving side ever needs to know
 * about accounts, as three questions. Deliberately dependency-free and
 * cookie-agnostic, so the hosted implementation (Better Auth over D1 in
 * @livevariant/accounts) and a self-hoster's own auth (a JWT header, a
 * reverse proxy, anything) are interchangeable. This package never
 * imports an auth framework.
 *
 * Cost accounting, because the next reader will assume otherwise:
 * these methods are consulted from the creator-only endpoints (/stats,
 * /recompute, /exclude), never from the serving hot path. When no
 * provider is configured, behavior is byte-for-byte the classic
 * bearer-secret check.
 */

/** What the registry says about a claimed stats key. */
export interface KeyPolicy {
  orgId: string;
  /**
   * When true, the bare stats secret stops authorizing the creator-only
   * endpoints and a session in the owning org is required. "Reads" is
   * shorthand: /recompute and /exclude share the same gate.
   */
  lockReads: boolean;
}

export interface AccountsProvider {
  /**
   * Org ids the request's session belongs to; [] when there is none.
   * Implementations must short-circuit cheaply when the request carries
   * no credential at all (the dominant case is a bearer-only call).
   */
  sessionOrgIds(req: Request): Promise<string[]>;
  /** What the registry knows about a claimed key. null = unclaimed. */
  keyPolicy(kh: string): Promise<KeyPolicy | null>;
  /** Owning org of a registered test (keyless SDK tests). null = none. */
  testOrg(testId: string): Promise<string | null>;
  /** The account test list, across every org the caller belongs to. */
  listTests(
    orgIds: string[],
    options: { q?: string; cursor?: string; limit?: number }
  ): Promise<{
    tests: Array<{
      testId: string;
      name: string | null;
      encoded: string | null;
      region: string | null;
      addedAt: number;
    }>;
    nextCursor: string | null;
  }>;
  /**
   * SDK first-sight registration, called off the response path
   * (waitUntil) when /choose carries a publishable key. The
   * implementation decides whether the pair (key, page origin) earns a
   * registration; a no-op is a valid answer. Optional: providers that
   * never register from serving simply omit it.
   */
  registerFromSdk?(input: {
    testId: string;
    encoded?: string;
    name?: string;
    region?: string;
    publishableKey: string;
    origin: string | null;
  }): Promise<void>;
  /**
   * Agent-path registration: the stats secret proves authority over
   * the test, the publishable key names the org. See the provider
   * implementation for why neither suffices alone.
   */
  registerWithSecret?(input: {
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
  >;
}
