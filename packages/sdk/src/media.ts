import {
  base64UrlToUtf8,
  computeTestId,
  parseTestConfig,
  type TestConfig
} from "@livevariant/core";
import { getHandoff } from "./handoff.js";
import { resolveExternalId } from "./identity.js";

/**
 * Upgrades bare serve/click URLs on the page with the strongest
 * identity available, which is what makes "paste the email snippet on
 * your site too" work: an <img src=".../s/..."> is a cross-site
 * subresource, so no cookie ever reaches it, but the page's OWN tag
 * knows who the visitor is first-party and can say so on the URL.
 *
 * Identity, strongest first, per URL:
 *   1. a stored redirect handoff for the SAME testId (?_lvid=, already
 *      hashed): the visitor who clicked here from the email keeps the
 *      exact variant the email showed them;
 *   2. the SDK's first-party id (?id=): sticky for site-native traffic.
 *
 * Two markup forms:
 *   - <img data-lv-src="...">: the tag fills src, so the browser makes
 *     ONE fetch, already identified. The recommended form.
 *   - <img src="...">: the preload scanner fetched it id-less before
 *     any script ran (anonymous serves record nothing), and the rewrite
 *     triggers an identified refetch. Works, costs one extra download.
 *
 * Click links (<a href=".../c/...">) fetch nothing until clicked, so
 * rewriting them is always race-free.
 */
export async function decorateMedia(
  win: Window,
  serverUrl: string,
  storage: Storage | null,
  /** Opt-in to _ga-based identity for the decorated URLs. Default: off. */
  autoIdentify = false
): Promise<number> {
  const origin = serverUrl.replace(/\/+$/, "");
  let upgraded = 0;

  const identified = async (raw: string): Promise<string | null> => {
    let url: URL;
    try {
      url = new URL(raw, win.location.href);
    } catch {
      return null;
    }
    if (url.searchParams.has("id") || url.searchParams.has("_lvid")) {
      return null;
    }
    const testId = await testIdOf(url.pathname);
    const handoff = testId ? getHandoff(storage, testId) : null;
    if (handoff) {
      url.searchParams.set("_lvid", handoff.idHash);
    } else {
      url.searchParams.set(
        "id",
        resolveExternalId({
          cookieString: win.document.cookie,
          locationSearch: win.location.search,
          storage,
          autoIdentify
        })
      );
    }
    return url.toString();
  };

  const targets: {
    element: Element;
    raw: string;
    apply: (value: string) => void;
  }[] = [];
  for (const img of win.document.querySelectorAll<HTMLImageElement>(
    "img[data-lv-src]"
  )) {
    const raw = img.getAttribute("data-lv-src");
    if (raw && new URL(raw, win.location.href).href.startsWith(`${origin}/s`)) {
      targets.push({ element: img, raw, apply: value => (img.src = value) });
    }
  }
  for (const img of win.document.querySelectorAll<HTMLImageElement>(
    `img[src^="${origin}/s"]`
  )) {
    targets.push({
      element: img,
      raw: img.src,
      apply: value => (img.src = value)
    });
  }
  for (const link of win.document.querySelectorAll<HTMLAnchorElement>(
    `a[href^="${origin}/c"]`
  )) {
    targets.push({
      element: link,
      raw: link.href,
      apply: value => (link.href = value)
    });
  }

  for (const target of targets) {
    const value = await identified(target.raw);
    if (value) {
      target.apply(value);
      upgraded++;
    } else if (target.element.hasAttribute("data-lv-src")) {
      // Already identified (or unparseable): still promote to src so
      // the recommended form always renders.
      (target.element as HTMLImageElement).src = target.raw;
    }
  }
  return upgraded;
}

/**
 * The testId of a /s/<cfg> or /c/<cfg> path, null for the param form.
 * Unanchored at the start: a self-hosted server may live under a path
 * prefix (https://host/lv/s/...), and the caller has already verified
 * the URL belongs to this tag's server.
 */
async function testIdOf(pathname: string): Promise<string | null> {
  const encoded = pathname.match(/\/[sc]\/([^/]+)$/)?.[1];
  if (!encoded) {
    return null;
  }
  try {
    const parsed = parseTestConfig(
      JSON.parse(base64UrlToUtf8(encoded))
    ) as TestConfig;
    return await computeTestId(parsed);
  } catch {
    return null;
  }
}
