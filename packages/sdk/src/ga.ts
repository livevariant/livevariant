/**
 * Zero-setup conversion tracking: both gtag.js and Google Tag Manager
 * funnel every event through window.dataLayer.push, so wrapping it makes
 * the site's existing GA events available as reward signals with no extra
 * wiring. The original push is always called untouched.
 */

/** GA4 event names treated as conversions when the config names none. */
export const DEFAULT_REWARD_EVENTS = [
  "purchase",
  "sign_up",
  "generate_lead",
  "conversion"
];

interface DataLayerWindow {
  dataLayer?: unknown[];
}

/** gtag pushes Arguments objects; GTM pushes plain {event} records. */
export function eventNameOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown> & { length?: number };
  if (typeof record["event"] === "string") {
    return record["event"];
  }
  if (record.length !== undefined && record[0] === "event") {
    const name = record[1 as unknown as keyof typeof record];
    return typeof name === "string" ? name : null;
  }
  return null;
}

/** gtag('consent', 'default'|'update', {analytics_storage: ...}) */
function consentDeniedOf(entry: unknown): boolean | null {
  if (entry === null || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<number, unknown> & { length?: number };
  if (record.length === undefined || record[0] !== "consent") {
    return null;
  }
  const params = record[2];
  if (params === null || typeof params !== "object") {
    return null;
  }
  const storage = (params as Record<string, unknown>)["analytics_storage"];
  return storage === undefined ? null : storage === "denied";
}

export interface GaWatcher {
  /** Stops intercepting (restores nothing; the wrapper becomes inert). */
  stop(): void;
}

/**
 * Watches the dataLayer for reward events, handling both load orders: an
 * existing dataLayer is wrapped immediately, a later-created one is caught
 * by a property trap on window. Consent denial (Google consent mode)
 * disables callbacks until consent is granted again.
 */
export function watchDataLayer(
  target: Window,
  rewardEvents: string[],
  onReward: (eventName: string) => void
): GaWatcher {
  const wanted = new Set(rewardEvents);
  let stopped = false;
  let analyticsDenied = false;

  function inspect(entry: unknown): void {
    const denied = consentDeniedOf(entry);
    if (denied !== null) {
      analyticsDenied = denied;
      return;
    }
    if (stopped || analyticsDenied) {
      return;
    }
    const name = eventNameOf(entry);
    if (name && wanted.has(name)) {
      onReward(name);
    }
  }

  function wrap(layer: unknown[]): unknown[] {
    // Process what's already queued (consent state may be in there too).
    for (const entry of layer) {
      inspect(entry);
    }
    const originalPush = layer.push.bind(layer);
    layer.push = (...entries: unknown[]): number => {
      const result = originalPush(...entries);
      for (const entry of entries) {
        inspect(entry);
      }
      return result;
    };
    return layer;
  }

  const w = target as Window & DataLayerWindow;
  if (Array.isArray(w.dataLayer)) {
    wrap(w.dataLayer);
  } else {
    // SDK loaded before gtag: trap the assignment gtag will make.
    let inner: unknown[] | undefined = undefined;
    Object.defineProperty(w, "dataLayer", {
      configurable: true,
      get: () => inner,
      set: value => {
        inner = Array.isArray(value) && !stopped ? wrap(value) : value;
      }
    });
  }

  return {
    stop() {
      stopped = true;
    }
  };
}
