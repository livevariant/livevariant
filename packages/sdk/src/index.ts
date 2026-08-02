import {
  base64UrlToUtf8,
  bucketKey,
  buildTestUrls,
  canonicalJson,
  computeTestId,
  externalIdHash,
  featureIndices,
  normalizeCtx,
  utf8ToBase64Url,
  FEATURE_DIM,
  type TestConfig,
  type TestUrls
} from "@livevariant/core";
import { resolveExternalId } from "./identity.js";
import { DEFAULT_REWARD_EVENTS, watchDataLayer, type GaWatcher } from "./ga.js";

export { gaClientId, resolveExternalId } from "./identity.js";
export {
  DEFAULT_REWARD_EVENTS,
  eventNameOf,
  watchDataLayer,
  type GaWatcher
} from "./ga.js";

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
  /** Reports a conversion for this visitor (server accumulates amounts). */
  trackConversion(amount?: number): Promise<void>;
  /** Serve/click/pixel URLs for this test on the configured server. */
  urls: TestUrls;
  /** Stops the GA dataLayer watcher. */
  dispose(): void;
}

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

  const externalId = resolveExternalId({
    explicit: options.externalId,
    cookieString: win.document.cookie,
    locationSearch: win.location.search,
    storage
  });
  const idHash = await externalIdHash(testId, externalId);

  const ctx = normalizeCtx(resolved, options.context ?? null);
  const ctxKey = ctx ? await bucketKey(testId, ctx) : null;
  const featIdx = featureIndices(ctx);

  const armIndex = await resolveAssignment();
  const arm = resolved.arms[armIndex] ?? resolved.arms[0];

  async function resolveAssignment(): Promise<number> {
    const cacheKey = `lv:a:${testId}`;
    if (storage) {
      const raw = storage.getItem(cacheKey);
      if (raw) {
        try {
          const cached = JSON.parse(raw) as CachedAssignment;
          // The cache is per-id: a login that changes the external id must
          // fall through to the server, which owns the sticky record.
          if (cached.idHash === idHash) {
            return cached.armIndex;
          }
        } catch {
          storage.removeItem(cacheKey);
        }
      }
    }
    const response = await fetchImpl(`${options.serverUrl}/choose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        testId,
        armCount: resolved.arms.length,
        alg: resolved.alg ?? "ts",
        dim: FEATURE_DIM,
        minBucketPulls: resolved.minBucketPulls,
        priorStrengthCap: resolved.priorStrengthCap,
        armPriors: resolved.priors?.arms,
        linearPriors: resolved.priors?.linear,
        idHash,
        ctxKey: ctxKey ?? undefined,
        featIdx
      })
    });
    if (!response.ok) {
      throw new Error(`choose failed: ${response.status}`);
    }
    const { armIndex: chosen } = (await response.json()) as {
      armIndex: number;
    };
    storage?.setItem(
      cacheKey,
      JSON.stringify({ armIndex: chosen, idHash } satisfies CachedAssignment)
    );
    return chosen;
  }

  async function trackConversion(amount = 1): Promise<void> {
    const response = await fetchImpl(`${options.serverUrl}/reward`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        testId,
        armCount: resolved.arms.length,
        alg: resolved.alg ?? "ts",
        dim: FEATURE_DIM,
        idHash,
        amount
      })
    });
    if (!response.ok) {
      throw new Error(`reward failed: ${response.status}`);
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
