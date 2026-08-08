/**
 * URL construction for a test, shared by the SDK and the web app (and the
 * planned MCP builder) so every surface produces identical links. `base` is the serving
 * origin (hosted: https://livevariant.link; self-host: wherever the server
 * runs). The manage URL carries the stats secret in the FRAGMENT: it never
 * leaves the browser, so it stays out of server and proxy logs.
 */
export interface TestUrls {
  serve: string;
  click: string;
  pixel: string;
  manage: string;
  /**
   * The same links with server-derived context switched off. Use these in
   * email. Nothing that touches an inbox is reliably the reader: mail
   * providers fetch images from their own infrastructure, and corporate
   * link scanners follow links from datacenters while presenting browser
   * headers, so derived geo there is a guess about a machine.
   *
   * It matters more than "some rows are wrong" because assignment is
   * sticky: whichever request lands first fixes a recipient's bucket for
   * good, and in an email with both an image and a link that is the
   * image open. Opting out makes the behaviour declared instead of
   * order-dependent.
   */
  noAuto: {
    serve: string;
    click: string;
  };
}

/** Query flag that suppresses server-derived context on a serve link. */
export const NO_AUTO_PARAM = "auto=0";

/**
 * `base` is where visitors are sent; `manageBase` is where the creator
 * reads results, and defaults to the same place. They differ only when a
 * deployment puts serving on its own domain to keep bulk email traffic
 * away from the dashboard's reputation.
 */
export function buildTestUrls(
  base: string,
  encoded: string,
  statsSecret?: string,
  manageBase?: string
): TestUrls {
  const origin = base.replace(/\/+$/, "");
  const manageOrigin = (manageBase ?? base).replace(/\/+$/, "");
  return {
    serve: `${origin}/s/${encoded}`,
    click: `${origin}/c/${encoded}`,
    pixel: `${origin}/px/${encoded}`,
    manage: `${manageOrigin}/manage/${encoded}${statsSecret ? `#${statsSecret}` : ""}`,
    noAuto: {
      serve: `${origin}/s/${encoded}?${NO_AUTO_PARAM}`,
      click: `${origin}/c/${encoded}?${NO_AUTO_PARAM}`
    }
  };
}

/**
 * Whether a request asked for derived context to be left alone. Lenient
 * about spelling because these links are pasted into ESP templates by
 * hand, where a silent misread would look exactly like working code.
 */
export function autoContextDisabled(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off" || flag === "no";
}

/**
 * Hosted-asset addresses. An asset's canonical URL is /a/<sha256-of-bytes>
 * on a deployment's serving origin, and it deliberately does not work on
 * its own: the server only answers it with a valid short-lived signature,
 * which the serve endpoints (and /choose, for the SDK) mint per request.
 * These helpers are shared by the server (which signs) and the SDK (which
 * recognizes asset URLs in a config and splices signatures in).
 */
const ASSET_URL_PATH = /^(.*)\/a\/([0-9a-f]{64})$/;

/**
 * The content hash when a URL is a hosted-asset address, else null.
 *
 * `basePath` is the prefix the deployment is mounted under, and it is
 * checked rather than ignored: this answer decides whether a redirect
 * target counts as OURS and may skip the trust policy, so a loose match
 * would hand that bypass to any `/…/a/<64 hex>` path on the same host.
 */
export function assetIdFromUrl(target: string, basePath = ""): string | null {
  try {
    const match = ASSET_URL_PATH.exec(new URL(target).pathname);
    if (!match) {
      return null;
    }
    return match[1] === basePath.replace(/\/+$/, "") ? match[2] : null;
  } catch {
    return null;
  }
}

/** Appends a pre-built query fragment ("e=...&s=...") to a URL. */
export function withQuery(target: string, query: string): string {
  return `${target}${target.includes("?") ? "&" : "?"}${query}`;
}
