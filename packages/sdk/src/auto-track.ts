import { captureHandoff, listHandoffs } from "./handoff.js";
import { DEFAULT_REWARD_EVENTS, watchDataLayer, type GaWatcher } from "./ga.js";

/**
 * The one-tag deployment mode (e.g. a Google Tag Manager Custom HTML tag
 * firing on All Pages). It needs no test configs at all:
 *
 *   1. captures redirect handoffs (_lvt/_lvid/_lvvar) on every pageview
 *      and cleans the URL;
 *   2. watches the GA dataLayer, and on conversion events rewards EVERY
 *      stored handoff: the visitor may be in redirect-served tests this
 *      page never rendered.
 *
 * Sites that also render inline tests use createTest on top of this;
 * conversions there are attributed through the same stored identities.
 */
export interface AutoTrackOptions {
  serverUrl: string;
  /** GA4 event names to treat as conversions; GA4 defaults if omitted. */
  rewardEvents?: string[];
  storage?: Storage | null;
  fetch?: typeof globalThis.fetch;
  window?: Window;
}

export interface AutoTracker {
  /** Rewards every stored handoff (also used by the GA watcher). */
  trackConversion(amount?: number): Promise<void>;
  dispose(): void;
}

export function autoTrack(options: AutoTrackOptions): AutoTracker {
  const win = options.window ?? window;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage =
    options.storage === undefined ? win.localStorage : options.storage;

  captureHandoff(win, storage);

  async function trackConversion(amount = 1): Promise<void> {
    await Promise.all(
      listHandoffs(storage).map(
        handoff =>
          fetchImpl(`${options.serverUrl}/reward`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              testId: handoff.testId,
              idHash: handoff.idHash,
              amount,
              // Carried by the redirect's handoff so an "eu" test's
              // reward reaches its jurisdictional home without this
              // page ever holding the config.
              ...(handoff.region ? { region: handoff.region } : {})
            })
          }).catch(() => undefined) // never break the host page
      )
    );
  }

  const watcher: GaWatcher = watchDataLayer(
    win,
    options.rewardEvents ?? DEFAULT_REWARD_EVENTS,
    () => {
      void trackConversion();
    }
  );

  return {
    trackConversion,
    dispose() {
      watcher.stop();
    }
  };
}
