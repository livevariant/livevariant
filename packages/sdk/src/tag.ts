/**
 * The LiveVariant tag: the <head> script install. One line on a page
 * (or a tag manager) and two things are true:
 *
 *   1. Reward tracking runs with no further code: redirect handoffs are
 *      captured and GA conversions reward every test this visitor is
 *      in, so a site that only ever serves email/redirect tests needs
 *      nothing else on the page.
 *   2. The page carries a global config (window.livevariant), so any
 *      later `createTest({ slots: ... })` needs no options.
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
import { createTest, type LiveVariantGlobal } from "./index.js";
import { autoTrack, type AutoTracker } from "./auto-track.js";

export interface LiveVariantTag extends LiveVariantGlobal {
  createTest: typeof createTest;
  /** Rewards every test this visitor is known to be in. */
  trackConversion(amount?: number): Promise<void>;
  /** Stops the GA watcher (mostly for tests and SPAs tearing down). */
  dispose(): void;
}

export function bootTag(
  win: Window = window,
  script: HTMLScriptElement | null = document.currentScript as HTMLScriptElement | null
): LiveVariantTag | null {
  const holder = win as Window & { livevariant?: LiveVariantGlobal };
  const preset = holder.livevariant ?? {};
  const data = script?.dataset ?? {};
  // Precedence: an explicit window.livevariant set before the tag wins,
  // then the tag's own attributes, then the tag's own origin.
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
  const tracker: AutoTracker = autoTrack({
    serverUrl,
    rewardEvents,
    window: win
  });
  const tag: LiveVariantTag = {
    ...preset,
    serverUrl,
    publishableKey: preset.publishableKey ?? data.publishableKey,
    rewardEvents,
    createTest,
    trackConversion: amount => tracker.trackConversion(amount),
    dispose: () => tracker.dispose()
  };
  holder.livevariant = tag;
  return tag;
}
