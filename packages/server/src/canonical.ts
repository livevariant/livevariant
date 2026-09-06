/**
 * The dashboard's one address, for a deployment that answers on more
 * than one hostname. The hosted service is reachable on livevariant.com
 * and on livevariant.link, and the second exists for experiment links
 * only; but the Worker behind both serves the same app shell, so a
 * crawler that follows a serve link home finds a second copy of the
 * product's pages under a name that was never meant to carry them.
 * Search engines then pick one, and they picked .link.
 *
 * `appUrl` (LV_APP_URL) says which copy is the real one. When it is set,
 * every page of the shell carries `<link rel="canonical">` pointing at
 * the same path on that origin, and the crawl documents (robots.txt's
 * Sitemap line, sitemap.xml's entries) name it too. A one-domain
 * deployment leaves it unset and nothing here happens.
 */

/** Origin only, no trailing slash; null when unset or unparseable. */
export function canonicalOriginOf(appUrl: string | undefined): string | null {
  if (!appUrl) {
    return null;
  }
  try {
    return new URL(appUrl).origin;
  } catch {
    return null;
  }
}

/**
 * The canonical URL of a request: its path on the canonical origin,
 * query dropped (the shell's routes are paths; a query never names a
 * different page). The path stays percent-encoded as the URL parser
 * left it, and it already carries any base path the app is mounted
 * under, since that is how the request reached the app at all; the
 * origin is the only part that changes.
 */
export function canonicalUrlFor(origin: string, requestUrl: string): string {
  return `${origin}${new URL(requestUrl).pathname}`;
}

/**
 * The shell with a canonical link in its head. Reads the body as text:
 * the shell is a few kilobytes and this runs only for navigations, not
 * for the assets a page then loads. A shell without a `</head>` (a test
 * stub, a stranger's index) passes through untouched rather than
 * gaining a tag in the wrong place.
 */
export async function withCanonical(
  shell: Response,
  canonical: string
): Promise<Response> {
  const html = await shell.text();
  const head = html.indexOf("</head>");
  const headers = new Headers(shell.headers);
  // The body is about to change length, and text() has already undone
  // any encoding the asset store applied; let the runtime redo both.
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (head === -1) {
    return new Response(html, { status: shell.status, headers });
  }
  const tag = `<link rel="canonical" href="${escapeAttribute(canonical)}" />`;
  return new Response(html.slice(0, head) + tag + html.slice(head), {
    status: shell.status,
    headers
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}
