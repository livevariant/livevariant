/**
 * External-id resolution, in order of preference:
 *   1. explicit `externalId` from the integrator
 *   2. with the `autoIdentify` opt-in: the GA client id from the _ga
 *      cookie (aligns our identity with the site's existing analytics).
 *      OFF by default, because reading a cookie is itself access to
 *      stored information under the consent rules: the default install
 *      must touch NOTHING in the browser's storage, read or write.
 *   3. an `id` URL parameter (the redirect-flow landing-page case)
 *   4. a generated id kept in storage (the page store by default, so it
 *      lives exactly as long as the page; localStorage when the
 *      deployment opted into persistence)
 * Whatever wins is hashed with the testId before it ever leaves the page.
 */

const STORAGE_ID_KEY = "lv:id";

/** _ga cookie format: GA1.1.1234567890.1699999999 -> "1234567890.1699999999" */
export function gaClientId(cookieString: string): string | null {
  const match = cookieString.match(/(?:^|;\s*)_ga=([^;]+)/);
  if (!match) {
    return null;
  }
  const parts = match[1].split(".");
  if (parts.length < 4) {
    return null;
  }
  return parts.slice(-2).join(".");
}

export function resolveExternalId(options: {
  explicit?: string;
  cookieString: string;
  locationSearch: string;
  storage: Storage | null;
  /** Opt-in to reading the _ga cookie for identity. Default: no reads. */
  autoIdentify?: boolean;
}): string {
  if (options.explicit) {
    return options.explicit;
  }
  if (options.autoIdentify) {
    const fromGa = gaClientId(options.cookieString);
    if (fromGa) {
      return `ga:${fromGa}`;
    }
  }
  const fromUrl = new URLSearchParams(options.locationSearch).get("id");
  // Bounded: the param is attacker-influenceable (anyone can craft a
  // link), so an oversized value must not flow into hashing or storage.
  if (fromUrl && fromUrl.length <= 512) {
    return fromUrl;
  }
  const existing = options.storage?.getItem(STORAGE_ID_KEY);
  if (existing) {
    return existing;
  }
  const generated = crypto.randomUUID();
  options.storage?.setItem(STORAGE_ID_KEY, generated);
  return generated;
}
