/**
 * The trust boundary as two questions, answerable by anyone.
 *
 * Serving is deliberately open: anyone can author a config, so the
 * config's own contents are never a trust boundary. What a deployment
 * CAN decide is who it talks to (which page origins may drive tests
 * through the SDK) and where it is willing to send visitors (redirect
 * destinations). Both decisions live behind this interface so a
 * self-hoster can answer them with env vars, their own logic, or, on
 * the hosted deployment, a registry of verified domains.
 *
 * `envTrustPolicy` is the built-in implementation over
 * LV_ALLOWED_ORIGINS / LV_ALLOWED_DESTINATIONS / LV_UNLISTED_DESTINATIONS.
 */

/**
 * What to do with a redirect destination: allow it, refuse it, or send
 * the visitor through an explicit "Redirecting you to…" page first.
 * The interstitial is the middle ground that keeps serving open without
 * making the deployment a one-hop open redirector: the destination is
 * named, the visitor clicks, phishing loses its disguise.
 */
export type RedirectVerdict = true | false | "interstitial";

export interface TrustContext {
  testId: string;
  /** Present when the test has a stats key; the hosted registry keys ownership on it. */
  statsKeyHash?: string;
  /** The full URL of the request being served. */
  requestUrl: string;
}

export interface TrustPolicy {
  /**
   * May a page on this origin drive tests through /choose and /reward?
   * Only consulted when the request carries an Origin header: browsers
   * always send one on SDK POSTs, while server-to-server callers have
   * no origin to check. This is a hygiene control against strangers
   * embedding your deployment, not authentication: a non-browser client
   * can claim any origin it likes.
   */
  isOriginAllowedForSDK(origin: string, ctx: TrustContext): Promise<boolean>;
  /**
   * May a redirect send a visitor to this hostname? The deployment's own
   * hosted assets never reach this question (they never leave the
   * deployment); everything else does, on /s and /c alike.
   */
  isDomainAllowedForRedirect(
    domain: string,
    ctx: TrustContext
  ): Promise<RedirectVerdict>;
}

/** What happens to a destination the allowlist does not name. */
export type UnlistedDestinationMode = "allow" | "block" | "interstitial";

export interface EnvTrustOptions {
  /**
   * Page origins allowed to drive tests via the SDK. Unset or empty
   * means any origin, which is right for a deployment serving strangers;
   * a self-hoster running their own sites sets it to lock /choose and
   * /reward to those sites. Entries are origins ("https://example.com")
   * or bare hostnames; a hostname also admits its subdomains.
   */
  allowedOrigins?: string[];
  /**
   * Hostnames redirects may send visitors to; a hostname admits its
   * subdomains. Unset means no list exists and every destination is
   * "unlisted".
   */
  allowedDestinations?: string[];
  /**
   * What to do with unlisted destinations. Defaults preserve the
   * classic semantics: with no list every destination is allowed, with
   * a list everything off it is blocked. "interstitial" softens either
   * into the explicit continue screen, which is how the hosted
   * deployment stays open without being an open redirector.
   */
  unlistedDestinations?: UnlistedDestinationMode;
}

function normalizeHost(entry: string): string {
  return entry.toLowerCase().replace(/^\./, "");
}

/** host === entry, or host is a subdomain of entry. */
function hostMatches(host: string, entries: string[]): boolean {
  return entries.some(entry => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Origin entries may be full origins or bare hostnames. An origin entry
 * must match exactly (scheme included); a hostname entry admits the
 * host and its subdomains on any scheme, because "my site, http or
 * https, www or not" is what a self-hoster means when they write
 * "example.com".
 */
export function originMatches(origin: string, entries: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.includes("://")) {
      if (origin.toLowerCase() === entry.toLowerCase().replace(/\/+$/, "")) {
        return true;
      }
    } else if (hostMatches(host, [normalizeHost(entry)])) {
      return true;
    }
  }
  return false;
}

export function envTrustPolicy(options: EnvTrustOptions = {}): TrustPolicy {
  const origins = (options.allowedOrigins ?? []).filter(Boolean);
  const destinations = (options.allowedDestinations ?? [])
    .filter(Boolean)
    .map(normalizeHost);
  const unlisted: UnlistedDestinationMode =
    options.unlistedDestinations ??
    (destinations.length > 0 ? "block" : "allow");
  const unlistedVerdict: RedirectVerdict =
    unlisted === "allow" ? true : unlisted === "block" ? false : "interstitial";
  return {
    isOriginAllowedForSDK(origin) {
      if (origins.length === 0) {
        return Promise.resolve(true);
      }
      return Promise.resolve(originMatches(origin, origins));
    },
    isDomainAllowedForRedirect(domain) {
      const host = normalizeHost(domain);
      if (destinations.length > 0 && hostMatches(host, destinations)) {
        return Promise.resolve(true);
      }
      return Promise.resolve(unlistedVerdict);
    }
  };
}

/** Parses the LV_UNLISTED_DESTINATIONS env value; unknown means unset. */
export function unlistedDestinationMode(
  value: string | undefined
): UnlistedDestinationMode | undefined {
  const mode = value?.trim().toLowerCase();
  return mode === "allow" || mode === "block" || mode === "interstitial"
    ? mode
    : undefined;
}
