import { useEffect, useState } from "react";

/**
 * Where the links a test hands out should point.
 *
 * Nothing is baked into this build. The dashboard is static, so it asks
 * the deployment that served it: the hosted service answers with its
 * serving domain, and a self-hoster's answers with their own origin. A
 * hardcoded default would have been wrong for one of them whichever way
 * it was written.
 */
export async function fetchServeUrl(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const fallback = window.location.origin;
  try {
    const res = await fetchImpl("/config");
    if (!res.ok) {
      return fallback;
    }
    const body: unknown = await res.json();
    const serveUrl = (body as { serveUrl?: unknown }).serveUrl;
    return typeof serveUrl === "string" && serveUrl.length > 0
      ? serveUrl.replace(/\/+$/, "")
      : fallback;
  } catch {
    // An older deployment, or offline. Serving from where we are loaded is
    // right far more often than any constant would be.
    return fallback;
  }
}

export function useServeUrl(): string {
  const [serveUrl, setServeUrl] = useState(() => window.location.origin);
  useEffect(() => {
    let live = true;
    void fetchServeUrl().then(url => {
      if (live) {
        setServeUrl(url);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return serveUrl;
}
