/**
 * Request signals the server can derive by itself, so a test can use
 * context the caller never had to pass. This is what makes contextual
 * tests work in email redirects, where there is no JavaScript to supply
 * `c_country=nl` and the sender may not know it either.
 *
 * Caller-supplied context still wins on conflict: you know your own
 * users better than an IP database does.
 */

/** Signals a context dimension may be filled from. */
export const AUTO_SIGNALS = [
  "country",
  "continent",
  "region",
  "city",
  "timezone",
  "device",
  "language",
  "organization"
] as const;

export type AutoSignal = (typeof AUTO_SIGNALS)[number];

/** Raw values pulled off a request, before any dimension mapping. */
export type RequestSignals = Partial<Record<AutoSignal, string>>;

/**
 * Cardinality is what decides whether a signal suits a bucketed test or
 * needs the linear model, so it travels with the signal rather than
 * living in someone's head. Approximate on purpose.
 */
export const SIGNAL_CARDINALITY: Record<AutoSignal, number> = {
  continent: 7,
  device: 3,
  country: 200,
  language: 50,
  region: 3000,
  timezone: 400,
  city: 10000,
  organization: 50000
};

/** Values Cloudflare uses for "we don't know" or "not a normal client". */
const UNKNOWN_GEO = new Set(["", "xx", "t1", "unknown"]);

function cleanGeo(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && !UNKNOWN_GEO.has(trimmed) ? trimmed : undefined;
}

/**
 * Coarse device class from a user agent. Deliberately three buckets: the
 * point is a usable context dimension, not device analytics, and a
 * long-tail of parsed browser names would just fragment a test.
 */
export function deviceClass(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }
  const ua = userAgent.toLowerCase();
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini/.test(ua)) {
    return "mobile";
  }
  return "desktop";
}

/** Primary language subtag from an Accept-Language header. */
export function primaryLanguage(
  header: string | undefined
): string | undefined {
  const first = header?.split(",")[0]?.split(";")[0]?.trim().toLowerCase();
  if (!first) {
    return undefined;
  }
  const base = first.split("-")[0];
  return /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

export interface CloudflareGeo {
  country?: string;
  continent?: string;
  regionCode?: string;
  city?: string;
  timezone?: string;
  asOrganization?: string;
}

/** Everything derivable about one request, normalized. */
export function requestSignals(input: {
  geo?: CloudflareGeo | null;
  userAgent?: string;
  acceptLanguage?: string;
}): RequestSignals {
  const geo = input.geo ?? {};
  const signals: RequestSignals = {
    country: cleanGeo(geo.country),
    continent: cleanGeo(geo.continent),
    region: cleanGeo(geo.regionCode),
    city: cleanGeo(geo.city),
    timezone: geo.timezone?.trim() || undefined,
    organization: geo.asOrganization?.trim().toLowerCase() || undefined,
    device: deviceClass(input.userAgent),
    language: primaryLanguage(input.acceptLanguage)
  };
  for (const key of Object.keys(signals) as AutoSignal[]) {
    if (signals[key] === undefined) {
      delete signals[key];
    }
  }
  return signals;
}

/**
 * True when a request is likely a proxied asset fetch rather than a
 * person. Mail providers fetch email images from their own
 * infrastructure, so deriving geo from those would record Google's
 * datacenter instead of the reader's country.
 *
 * Only a page navigation is treated as a person; an image request, a
 * wildcard Accept, and a request with no headers at all are all treated
 * as proxies. The asymmetry is deliberate: a mail proxy sending a bare
 * wildcard Accept would otherwise pass as a reader and silently poison a
 * contextual test with datacenter geo, whereas guessing "proxy" for a
 * real visitor costs only their context. No context beats confidently
 * wrong context.
 *
 * This is for the redirect paths, where mail proxies actually land. A
 * /choose call is page JavaScript, so a person is already established
 * and this question does not arise.
 */
export function isAssetFetch(headers: {
  accept?: string;
  secFetchDest?: string;
}): boolean {
  if (headers.secFetchDest) {
    return headers.secFetchDest !== "document";
  }
  return !(headers.accept?.toLowerCase().includes("text/html") ?? false);
}
