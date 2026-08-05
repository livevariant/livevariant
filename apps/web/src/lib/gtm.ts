import { useEffect } from "react";

/**
 * Loads Google Tag Manager once the deployment's /config names a
 * container (LV_GOOGLE_TAG_MANAGER). Dynamic injection instead of a
 * baked <head> snippet because the dashboard is one static build
 * serving every deployment: which container (if any) is the server's
 * runtime answer, not a compile-time constant. The classic <noscript>
 * iframe is deliberately absent: a visitor without JavaScript never
 * renders this app in the first place.
 */
export function useGoogleTagManager(gtmId: string | null): void {
  useEffect(() => {
    if (!gtmId || document.getElementById("lv-gtm")) {
      return;
    }
    type DataLayerWindow = Window & { dataLayer?: unknown[] };
    const win = window as DataLayerWindow;
    win.dataLayer = win.dataLayer ?? [];
    win.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    const script = document.createElement("script");
    script.id = "lv-gtm";
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(gtmId)}`;
    document.head.appendChild(script);
  }, [gtmId]);
}
