import {
  base64UrlToUtf8,
  bucketKey,
  buildTestUrls,
  canonicalJson,
  computeTestId,
  effectiveBucketPriors,
  externalIdHash,
  featureIndices,
  normalizeCtx,
  splitAutoDims,
  utf8ToBase64Url,
  FEATURE_DIM,
  type TestConfig,
  type TestUrls
} from "@livevariant/core";
import { resolveExternalId } from "./identity.js";
import { DEFAULT_REWARD_EVENTS, watchDataLayer, type GaWatcher } from "./ga.js";
import { captureHandoff, getHandoff } from "./handoff.js";

export { gaClientId, resolveExternalId } from "./identity.js";
export {
  DEFAULT_REWARD_EVENTS,
  eventNameOf,
  resetDataLayerInterception,
  watchDataLayer,
  type GaWatcher
} from "./ga.js";
export {
  captureHandoff,
  getHandoff,
  listHandoffs,
  type StoredHandoff
} from "./handoff.js";
export {
  autoTrack,
  type AutoTrackOptions,
  type AutoTracker
} from "./auto-track.js";

/**
 * LiveVariant browser SDK. Privacy contract: the raw external id and raw
 * context values are hashed on this side of the wire; the server receives
 * only the testId, hashes, indices, and tuning numbers, and never any
 * variant content (arms live in the config the page already has).
 */

export interface CreateTestOptions {
  /** Serving origin, e.g. "https://livevariant.link" or your self-host. */
  serverUrl: string;
  /** Overrides the id resolution chain (GA cookie, ?id=, generated). */
  externalId?: string;
  /** Raw context values; hashed locally, never sent raw. */
  context?: Record<string, string>;
  /** Override config.rewardEvents; false disables GA interception. */
  rewardEvents?: string[] | false;
  /** Defaults to window.localStorage; pass null to disable caching. */
  storage?: Storage | null;
  /**
   * How long to wait for the assignment before rendering the first arm.
   * An A/B tool must never hold up a page, so a slow or unreachable
   * server degrades to the control variant rather than blocking.
   */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  window?: Window;
}

export interface Variant {
  index: number;
  name: string;
  url?: string;
  image?: string;
  html?: string;
  md?: string;
  text?: string;
}

export interface LiveTest {
  testId: string;
  variant: Variant;
  /**
   * True when the server could not be reached (or answered with
   * something unusable) and the first arm was rendered as a fallback.
   * Nothing was recorded, so these views are not in the test's numbers.
   */
  fallback: boolean;
  /** Reports a conversion for this visitor (server accumulates amounts). */
  trackConversion(amount?: number): Promise<void>;
  /** Serve/click/pixel URLs for this test on the configured server. */
  urls: TestUrls;
  /** Stops the GA dataLayer watcher. */
  dispose(): void;
}

/** Assignment requests give up after this long and render control. */
const DEFAULT_TIMEOUT_MS = 2_000;

interface CachedAssignment {
  armIndex: number;
  idHash: string;
}

export async function createTest(
  config: TestConfig | string,
  options: CreateTestOptions
): Promise<LiveTest> {
  const win = options.window ?? window;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const storage =
    options.storage === undefined ? win.localStorage : options.storage;

  const resolved: TestConfig =
    typeof config === "string"
      ? (JSON.parse(base64UrlToUtf8(config)) as TestConfig)
      : config;
  const testId = await computeTestId(resolved);

  // Redirect handoff first: if this visitor arrived through /s or /c,
  // the server-side assignment (and its idHash) is authoritative. A
  // tampered armIndex beyond this config's arms is treated as no handoff
  // rather than silently rendering the wrong variant.
  captureHandoff(win, storage);
  const storedHandoff = getHandoff(storage, testId);
  const handoff =
    storedHandoff && storedHandoff.armIndex < resolved.arms.length
      ? storedHandoff
      : null;

  const idHash = handoff
    ? handoff.idHash
    : await externalIdHash(
        testId,
        resolveExternalId({
          explicit: options.externalId,
          cookieString: win.document.cookie,
          locationSearch: win.location.search,
          storage
        })
      );

  const ctx = normalizeCtx(resolved, options.context ?? null);
  // Dimensions the config marks `from` are filled and hashed server-side,
  // so they stay out of the key hashed here. Sending any value the page
  // does know for them raw is the point: the server has to compose
  // supplied and derived values identically or the same context would sit
  // in a different bucket depending on whether it arrived via the SDK or
  // via an email redirect.
  const autoDims = resolved.ctx?.dims.filter(d => d.from);
  const callerCtx = splitAutoDims(autoDims, ctx);
  const autoCtx = Object.fromEntries(
    (autoDims ?? [])
      .map(d => [d.key, ctx?.[d.key]] as const)
      .filter((entry): entry is readonly [string, string] => !!entry[1])
  );
  const ctxKey = callerCtx ? await bucketKey(testId, callerCtx) : null;
  const featIdx = featureIndices(callerCtx);
  // Bucket priors must be resolved to bucket keys the same way the
  // redirect path does, or a bucketed test would silently lose its
  // warm-start priors when served through the SDK.
  const bucketPriors = resolved.priors?.buckets
    ? await effectiveBucketPriors(resolved, testId)
    : undefined;

  const { armIndex, fallback } = await resolveAssignment();
  const arm = resolved.arms[armIndex] ?? resolved.arms[0];

  async function resolveAssignment(): Promise<{
    armIndex: number;
    fallback: boolean;
  }> {
    if (handoff) {
      // The server already assigned this visitor during the redirect.
      return { armIndex: handoff.armIndex, fallback: false };
    }
    const cacheKey = `lv:a:${testId}`;
    if (storage) {
      const raw = storage.getItem(cacheKey);
      if (raw) {
        try {
          const cached = JSON.parse(raw) as CachedAssignment;
          // The cache is per-id: a login that changes the external id must
          // fall through to the server, which owns the sticky record.
          if (cached.idHash === idHash) {
            return { armIndex: cached.armIndex, fallback: false };
          }
        } catch {
          storage.removeItem(cacheKey);
        }
      }
    }
    try {
      return await chooseFromServer(cacheKey);
    } catch {
      // Unreachable, too slow, or an unusable answer: render the first
      // arm. A failed experiment must never become a broken page. The
      // result is deliberately NOT cached, so a transient outage cannot
      // pin this visitor to the control variant for good.
      return { armIndex: 0, fallback: true };
    }
  }

  async function chooseFromServer(cacheKey: string): Promise<{
    armIndex: number;
    fallback: boolean;
  }> {
    const response = await fetchImpl(`${options.serverUrl}/choose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: JSON.stringify({
        testId,
        armCount: resolved.arms.length,
        alg: resolved.alg ?? "ts",
        dim: FEATURE_DIM,
        minBucketPulls: resolved.minBucketPulls,
        priorStrengthCap: resolved.priorStrengthCap,
        armPriors: resolved.priors?.arms,
        bucketPriors,
        linearPriors: resolved.priors?.linear,
        idHash,
        ctxKey: ctxKey ?? undefined,
        featIdx,
        autoDims,
        autoCtx: Object.keys(autoCtx).length > 0 ? autoCtx : undefined
      })
    });
    if (!response.ok) {
      return { armIndex: 0, fallback: true };
    }
    const { armIndex: chosen } = (await response.json()) as {
      armIndex: number;
    };
    // A nonsense index (a proxy rewriting the body, a future server
    // version) must not index past the arms and render nothing.
    if (
      !Number.isInteger(chosen) ||
      chosen < 0 ||
      chosen >= resolved.arms.length
    ) {
      return { armIndex: 0, fallback: true };
    }
    storage?.setItem(
      cacheKey,
      JSON.stringify({ armIndex: chosen, idHash } satisfies CachedAssignment)
    );
    return { armIndex: chosen, fallback: false };
  }

  /**
   * Minimal by design: the server's assignment record carries its own
   * serving snapshot. Never rejects, because a customer's page may await
   * this inside its own checkout flow and a lost conversion must not
   * become a lost sale.
   */
  async function trackConversion(amount = 1): Promise<void> {
    try {
      await fetchImpl(`${options.serverUrl}/reward`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        body: JSON.stringify({ testId, idHash, amount })
      });
    } catch {
      // Dropped: the bandit tolerates missing rewards, pages don't
      // tolerate exceptions.
    }
  }

  let watcher: GaWatcher | null = null;
  const rewardEvents =
    options.rewardEvents === false
      ? null
      : (options.rewardEvents ??
        resolved.rewardEvents ??
        DEFAULT_REWARD_EVENTS);
  if (rewardEvents && rewardEvents.length > 0) {
    watcher = watchDataLayer(win, rewardEvents, () => {
      // Fire-and-forget: a lost reward must never break the host page.
      void trackConversion().catch(() => undefined);
    });
  }

  return {
    testId,
    fallback,
    variant: {
      index: armIndex,
      name: arm.name,
      url: arm.formats.url,
      image: arm.formats.image,
      html: arm.formats.html,
      md: arm.formats.md,
      text: arm.formats.text
    },
    trackConversion,
    // A string input IS the encoded config; objects go through the same
    // canonical serialization the encoder uses (validation happened when
    // the config was built).
    urls: buildTestUrls(
      options.serverUrl,
      typeof config === "string"
        ? config
        : utf8ToBase64Url(canonicalJson(resolved))
    ),
    dispose() {
      watcher?.stop();
    }
  };
}
