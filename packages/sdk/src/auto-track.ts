import { captureHandoff, listHandoffs } from "./handoff.js";
import { SDK_VERSION } from "./version.js";
import { pageStorage } from "./page-store.js";
import { DEFAULT_REWARD_EVENTS, watchDataLayer, type GaWatcher } from "./ga.js";

/**
 * The page-wide reward tracker. One per window, whichever bundle asks
 * first: the served tag and an npm-bundled SDK are separate module
 * instances, so the claim lives on the window itself, and the loser's
 * autoTrack simply runs no watcher. That single claim is what makes
 * double-recording structurally impossible whatever combination of
 * installs a page ends up with, in either load order.
 *
 * On a GA conversion event it rewards EVERY participation this visitor
 * is known to be in:
 *
 *   1. stored redirect handoffs (_lvt/_lvid/_lvvar), captured on every
 *      pageview and URL-cleaned, for tests this page never rendered;
 *   2. cached inline assignments (lv:a:*), which is how tests created
 *      by page code (createTest) are rewarded WITHOUT their own GA
 *      watcher: the window-shared store is the coordination channel
 *      (the page store by default, localStorage when opted in), so no
 *      cross-bundle API exists to version.
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
  /** Rewards every known participation (also used by the GA watcher). */
  trackConversion(amount?: number): Promise<void>;
  dispose(): void;
}

const ASSIGNMENT_PREFIX = "lv:a:";

/** One reward target: a test this visitor is in, and as whom. */
export interface Participation {
  testId: string;
  idHash: string;
  region?: string;
}

/**
 * Every reward target in storage: handoffs plus cached assignments,
 * deduplicated (a redirect-then-inline visit knows the same test both
 * ways). Assignments cached with noAuto (createTest's rewardEvents:
 * false) asked to stay out of automatic rewarding.
 */
export function listParticipations(storage: Storage | null): Participation[] {
  const seen = new Set<string>();
  const out: Participation[] = [];
  const add = (p: Participation): void => {
    const key = `${p.testId}:${p.idHash}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  };
  for (const handoff of listHandoffs(storage)) {
    add({
      testId: handoff.testId,
      idHash: handoff.idHash,
      ...(handoff.region ? { region: handoff.region } : {})
    });
  }
  if (storage) {
    // Collect keys BEFORE reading (see listHandoffs for why).
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(ASSIGNMENT_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      try {
        const cached = JSON.parse(storage.getItem(key) ?? "") as {
          idHash?: unknown;
          region?: unknown;
          noAuto?: unknown;
        };
        if (typeof cached.idHash === "string" && cached.noAuto !== true) {
          add({
            testId: key.slice(ASSIGNMENT_PREFIX.length),
            idHash: cached.idHash,
            ...(typeof cached.region === "string"
              ? { region: cached.region }
              : {})
          });
        }
      } catch {
        // Not ours to clean: createTest owns the assignment cache.
      }
    }
  }
  return out;
}

/** The cross-bundle claim: on window because bundles don't share modules. */
interface AutoTrackClaim {
  __lvAutoTrack?: boolean;
}

export function autoTrack(options: AutoTrackOptions): AutoTracker {
  const win = options.window ?? window;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage =
    options.storage === undefined ? pageStorage(win) : options.storage;

  captureHandoff(win, storage);

  async function trackConversion(amount = 1): Promise<void> {
    await Promise.all(
      listParticipations(storage).map(
        participation =>
          fetchImpl(`${options.serverUrl}/reward`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              testId: participation.testId,
              idHash: participation.idHash,
              amount,
              sdk: SDK_VERSION,
              // Carried so an "eu" test's reward reaches its
              // jurisdictional home without this page ever holding the
              // config.
              ...(participation.region ? { region: participation.region } : {})
            })
          }).catch(() => undefined) // never break the host page
      )
    );
  }

  // First claimant runs the page's one GA watcher; later callers (the
  // other bundle, later createTests) still get a working manual
  // trackConversion but add no watcher. The first claimant's
  // rewardEvents list is the page's list.
  const claimant = win as Window & AutoTrackClaim;
  let watcher: GaWatcher | null = null;
  if (!claimant.__lvAutoTrack) {
    claimant.__lvAutoTrack = true;
    watcher = watchDataLayer(
      win,
      options.rewardEvents ?? DEFAULT_REWARD_EVENTS,
      () => {
        void trackConversion();
      }
    );
  }

  return {
    trackConversion,
    dispose() {
      if (watcher) {
        watcher.stop();
        watcher = null;
        delete claimant.__lvAutoTrack;
      }
    }
  };
}

/** Test hook: releases a window's watcher claim. */
export function resetAutoTrack(win: Window): void {
  delete (win as Window & AutoTrackClaim).__lvAutoTrack;
}
