/**
 * The LiveVariant tag: the <head> script install. One line on a page
 * (or a tag manager) and two things are true:
 *
 *   1. Reward tracking runs with no further code: redirect handoffs are
 *      captured and GA conversions reward every test this visitor is
 *      in, so a site that only ever serves email/redirect tests needs
 *      nothing else on the page.
 *   2. The page carries a global (window.livevariant = { config, sdk }):
 *      any later `createTest({ slots: ... })` needs no options, and
 *      tag-only pages can call window.livevariant.sdk.createTest.
 *
 * Configuration comes from data attributes on the script element, with
 * serverUrl defaulting to wherever the script itself was loaded from:
 *
 *   <script defer src="https://your-deployment/sdk.js"
 *           data-publishable-key="pk_..."></script>
 *
 * The bundled IIFE (served as /sdk.js by every deployment) just calls
 * bootTag(); it is exported separately so tests can drive it.
 */
import {
  createTest,
  type LiveVariantConfig,
  type LiveVariantGlobal
} from "./index.js";
import { autoTrack, type AutoTracker } from "./auto-track.js";
import { decorateMedia } from "./media.js";

/** The booted global: resolved config plus the callable sdk. */
export interface LiveVariantTag extends LiveVariantGlobal {
  config: LiveVariantConfig;
  sdk: {
    createTest: typeof createTest;
    /** Rewards every test this visitor is known to be in. */
    trackConversion(amount?: number): Promise<void>;
    /**
     * Re-scans the page for serve images and click links to upgrade
     * with the visitor's identity. Boot runs it once; SPAs call it
     * again after injecting content. Resolves to the upgrade count.
     */
    decorate(): Promise<number>;
    /** Stops the GA watcher (mostly for tests and SPAs tearing down). */
    dispose(): void;
  };
}

export function bootTag(
  win: Window = window,
  script: HTMLScriptElement | null = document.currentScript as HTMLScriptElement | null
): LiveVariantTag | null {
  const holder = win as Window & { livevariant?: LiveVariantGlobal };
  // Precedence: an explicit window.livevariant = { config } set before
  // the tag wins, then the tag's own attributes, then the tag's origin.
  const preset = holder.livevariant?.config ?? {};
  const data = script?.dataset ?? {};
  const serverUrl =
    preset.serverUrl ??
    data.serverUrl ??
    (script?.src ? new URL(script.src, win.location.href).origin : undefined);
  if (!serverUrl) {
    console.warn(
      "[livevariant] tag loaded without a server: set data-server-url or " +
        "load the script from your deployment"
    );
    return null;
  }
  const rewardEvents =
    preset.rewardEvents ??
    (data.rewardEvents
      ? data.rewardEvents
          .split(",")
          .map(name => name.trim())
          .filter(Boolean)
      : undefined);
  // Claims the page-wide watcher unless an earlier bundle (an npm SDK
  // that ran first) already did; either way exactly one exists.
  const tracker: AutoTracker = autoTrack({
    serverUrl,
    rewardEvents,
    window: win
  });
  const decorate = () => decorateMedia(win, serverUrl, win.localStorage);
  // Upgrade any serve images / click links already in the page. The
  // preload scanner beat us to bare src images (their id-less fetch
  // recorded nothing); data-lv-src images get their one identified
  // fetch here.
  void decorate();
  const tag: LiveVariantTag = {
    config: {
      serverUrl,
      publishableKey: preset.publishableKey ?? data.publishableKey,
      rewardEvents
    },
    sdk: {
      createTest,
      trackConversion: amount => tracker.trackConversion(amount),
      decorate,
      dispose: () => tracker.dispose()
    }
  };
  holder.livevariant = tag;
  return tag;
}
