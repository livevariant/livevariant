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
export interface DeploymentConfig {
  serveUrl: string;
  /** The creator's own region, as the deployment saw this request. */
  region: string | null;
  /** GTM container id when the deployment enables it; null otherwise. */
  gtmId: string | null;
}

export async function fetchDeploymentConfig(
  fetchImpl: typeof fetch = fetch
): Promise<DeploymentConfig> {
  const fallback = {
    serveUrl: window.location.origin,
    region: null,
    gtmId: null
  };
  try {
    const res = await fetchImpl("/config");
    if (!res.ok) {
      return fallback;
    }
    const body: unknown = await res.json();
    const serveUrl = (body as { serveUrl?: unknown }).serveUrl;
    const region = (body as { region?: unknown }).region;
    const gtmId = (body as { gtmId?: unknown }).gtmId;
    return {
      serveUrl:
        typeof serveUrl === "string" && serveUrl.length > 0
          ? serveUrl.replace(/\/+$/, "")
          : fallback.serveUrl,
      region: typeof region === "string" ? region : null,
      // Shape-checked here so a compromised or garbled /config can only
      // ever name a container, never a script URL.
      gtmId:
        typeof gtmId === "string" && /^GTM-[A-Z0-9]+$/i.test(gtmId)
          ? gtmId
          : null
    };
  } catch {
    // An older deployment, or offline. Serving from where we are loaded is
    // right far more often than any constant would be.
    return fallback;
  }
}

export async function fetchServeUrl(
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  return (await fetchDeploymentConfig(fetchImpl)).serveUrl;
}

export function useServeUrl(): string {
  return useDeploymentConfig().serveUrl;
}

export function useDeploymentConfig(): DeploymentConfig {
  const [config, setConfig] = useState<DeploymentConfig>(() => ({
    serveUrl: window.location.origin,
    region: null,
    gtmId: null
  }));
  useEffect(() => {
    let live = true;
    void fetchDeploymentConfig().then(fetched => {
      if (live) {
        setConfig(fetched);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}
