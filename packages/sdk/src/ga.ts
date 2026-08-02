/**
 * Zero-setup conversion tracking: both gtag.js and Google Tag Manager
 * funnel every event through window.dataLayer.push, so wrapping it makes
 * the site's existing GA events available as reward signals with no extra
 * wiring. The original push is always called untouched.
 *
 * The interception is a per-window singleton with a listener registry:
 * multiple watchers (several tests on one page, plus autoTrack) share one
 * wrapper/property-trap instead of overwriting each other's.
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
  /** Unregisters this watcher's listener; the shared wrapper stays. */
  stop(): void;
}

interface InterceptorState {
  listeners: Set<(name: string) => void>;
  analyticsDenied: boolean;
  /** Names already seen, replayed to late-registering watchers. */
  pastEvents: string[];
}

const PAST_EVENTS_CAP = 50;
const interceptors = new WeakMap<Window, InterceptorState>();

function ensureInterceptor(w: Window & DataLayerWindow): InterceptorState {
  const existing = interceptors.get(w);
  if (existing) {
    return existing;
  }
  const state: InterceptorState = {
    listeners: new Set(),
    analyticsDenied: false,
    pastEvents: []
  };
  interceptors.set(w, state);

  function inspect(entry: unknown): void {
    const denied = consentDeniedOf(entry);
    if (denied !== null) {
      state.analyticsDenied = denied;
      return;
    }
    if (state.analyticsDenied) {
      return;
    }
    const name = eventNameOf(entry);
    if (!name) {
      return;
    }
    if (state.pastEvents.length < PAST_EVENTS_CAP) {
      state.pastEvents.push(name);
    }
    for (const listener of state.listeners) {
      listener(name);
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

  if (Array.isArray(w.dataLayer)) {
    wrap(w.dataLayer);
  } else {
    // SDK loaded before gtag: trap the assignment gtag will make.
    let inner: unknown[] | undefined = undefined;
    Object.defineProperty(w, "dataLayer", {
      configurable: true,
      get: () => inner,
      set: value => {
        inner = Array.isArray(value) ? wrap(value) : value;
      }
    });
  }
  return state;
}

/**
 * Registers a watcher on the shared dataLayer interception for `target`.
 * Events that arrived before registration are replayed to the new
 * listener, so a purchase already queued in the dataLayer still counts.
 */
export function watchDataLayer(
  target: Window,
  rewardEvents: string[],
  onReward: (eventName: string) => void
): GaWatcher {
  const wanted = new Set(rewardEvents);
  const listener = (name: string): void => {
    if (wanted.has(name)) {
      onReward(name);
    }
  };
  const state = ensureInterceptor(target as Window & DataLayerWindow);
  for (const name of state.pastEvents) {
    listener(name);
  }
  state.listeners.add(listener);
  return {
    stop() {
      state.listeners.delete(listener);
    }
  };
}

/** Test hook: forgets a window's interception state entirely. */
export function resetDataLayerInterception(target: Window): void {
  interceptors.delete(target);
}
