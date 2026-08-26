import {
  assetIdFromUrl,
  base64UrlToUtf8,
  bucketKey,
  buildTestUrls,
  canonicalJson,
  computeTestId,
  decodeCell,
  dimForShape,
  effectivePriors,
  externalIdHash,
  featureIndices,
  normalizeCtx,
  slotEntries,
  slotSizes,
  splitAutoDims,
  parseTestConfig,
  utf8ToBase64Url,
  validCell,
  variantName,
  withQuery,
  type TestConfig,
  type TestConfigInput,
  type TestUrls
} from "@livevariant/core";
import { resolveExternalId } from "./identity.js";
import { DEFAULT_REWARD_EVENTS, watchDataLayer, type GaWatcher } from "./ga.js";
import { captureHandoff, getHandoff } from "./handoff.js";
import { autoTrack } from "./auto-track.js";
import { resolveStorage, type StorageMode } from "./page-store.js";
import { SDK_VERSION } from "./version.js";

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
export { SDK_VERSION } from "./version.js";
export { decorateMedia } from "./media.js";
export { pageStorage, resolveStorage, type StorageMode } from "./page-store.js";

/**
 * LiveVariant browser SDK. Privacy contract: the raw external id and raw
 * context values are hashed on this side of the wire; the server receives
 * only the testId, hashes, indices, and shape numbers, and never any
 * variant content (variants live in the config the page already has).
 *
 * Configs are written to be READ. `createTest` takes the same input the
 * schema does, so the whole test can sit legibly in page source:
 *
 *   createTest({ variants: ["Ship faster", "Ship safer"] }, { serverUrl })
 *
 * or, testing two elements at once (the model optimizes the combination):
 *
 *   createTest(
 *     { slots: { headline: ["A", "B"], cta: ["Buy", "Try"] } },
 *     { serverUrl }
 *   )
 */

/**
 * Deployment-wide configuration a page carries once, usually set by the
 * LiveVariant tag in <head>. createTest reads it as the fallback for
 * its options, so page code can call `createTest({ slots: ... })` with
 * nothing else. A page may also preset it BEFORE the tag loads
 * (`window.livevariant = { config: {...} }`); the tag keeps it.
 */
export interface LiveVariantConfig {
  serverUrl?: string;
  publishableKey?: string;
  /** GA4 event names treated as conversions by automatic tracking. */
  rewardEvents?: string[];
  /**
   * Where client state (identity, cached assignments, handoffs) lives.
   * Default "page": a window-shared store that dies with the page, so
   * the SDK needs no storage consent anywhere. "local" opts into
   * localStorage for cross-page identity and pages-later conversions;
   * "none" disables caching. A string, not a Storage object, because
   * this global is the plain-data cross-version contract.
   */
  storage?: StorageMode;
}

/** The tag's callable surface, for pages without an npm install. */
export interface LiveVariantSdk {
  createTest: typeof createTest;
  /** Rewards every test this visitor is known to be in. */
  trackConversion(amount?: number): Promise<void>;
  /** Stops the tag's GA watcher (mostly SPAs tearing down). */
  dispose(): void;
}

/**
 * window.livevariant: plain-data `config` (the only cross-version
 * contract, so its fields never change meaning) and, once the tag has
 * booted, the callable `sdk`.
 */
export interface LiveVariantGlobal {
  config?: LiveVariantConfig;
  sdk?: LiveVariantSdk;
}

/**
 * Resolves with the page's global config (window.livevariant) as soon
 * as it exists, or null once timeoutMs passes without it. For SPAs
 * whose LiveVariant tag arrives late through a tag manager: wait a
 * moment for the tag instead of racing it, then render the control
 * rather than hold the page.
 */
export function whenTagReady(
  options: { win?: Window; timeoutMs?: number; pollMs?: number } = {}
): Promise<LiveVariantGlobal | null> {
  const win = options.win ?? window;
  const timeoutMs = options.timeoutMs ?? 3000;
  const pollMs = options.pollMs ?? 50;
  const read = () =>
    (win as Window & { livevariant?: LiveVariantGlobal }).livevariant ?? null;
  const first = read();
  if (first) {
    return Promise.resolve(first);
  }
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const tag = read();
      if (tag || Date.now() >= deadline) {
        clearInterval(timer);
        resolve(tag);
      }
    }, pollMs);
  });
}

export interface CreateTestOptions {
  /**
   * Serving origin, e.g. "https://livevariant.link" or your self-host.
   * Optional when the page carries a global config (the tag sets one);
   * required otherwise.
   */
  serverUrl?: string;
  /** Overrides the id resolution chain (GA cookie, ?id=, generated). */
  externalId?: string;
  /** Raw context values; hashed locally, never sent raw. */
  context?: Record<string, string>;
  /** Override config.rewardEvents; false disables GA interception. */
  rewardEvents?: string[] | false;
  /**
   * Defaults to the page store: shared by every LiveVariant bundle on
   * the window, gone on navigation, so assignments are sticky and
   * rewardable for the page's lifetime with no storage consent needed.
   * Pass window.localStorage for cross-page identity and pages-later
   * conversions (your consent story), or null to disable caching.
   */
  storage?: Storage | null;
  /**
   * How long to wait for a tag-manager-loaded tag's global config when
   * no serverUrl is otherwise known. Tag managers inject the tag late,
   * so a page script racing it would throw where waiting a moment
   * succeeds; a page that provides serverUrl itself never waits. False
   * disables waiting. Default 3000.
   */
  tagWaitMs?: number | false;
  /**
   * How long to wait for the assignment before rendering the control
   * combination. An A/B tool must never hold up a page, so a slow or
   * unreachable server degrades to the first variants rather than block.
   */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  window?: Window;
  /**
   * Hosted accounts only: a public pk_ key from your account settings.
   * Paired with a page origin whose domain your account has verified,
   * it registers this test under "My tests" on first serve, and shares
   * the config with the deployment so the dashboard can read it (the
   * explicit opt-in a JS-mode config otherwise never gets). Grants
   * nothing else; safe in page source.
   */
  publishableKey?: string;
}

export interface Variant {
  /** Index within its slot. */
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
  /** The served combination, encoded (an index over all slots). */
  cell: number;
  /** The chosen variant per slot, e.g. test.slots.headline.text. */
  slots: Record<string, Variant>;
  /**
   * The chosen variant of the first slot: the whole answer for the
   * common single-slot test, sugar for `slots.main`.
   */
  variant: Variant;
  /**
   * True when the server could not be reached (or answered with
   * something unusable) and the control combination was rendered as a
   * fallback. Nothing was recorded, so these views are not in the
   * test's numbers.
   */
  fallback: boolean;
  /** Reports a conversion for this visitor (server accumulates amounts). */
  trackConversion(amount?: number): Promise<void>;
  /** Serve/click/pixel URLs for this test on the configured server. */
  urls: TestUrls;
  /**
   * Stops this test's own direct GA watcher (the storage:null mode).
   * The PAGE-WIDE tracker deliberately survives: a conversion usually
   * happens pages after the component that rendered the test is gone,
   * and attribution through the storage cache must keep working, the
   * same way the tag's tracker outlives any one view.
   */
  dispose(): void;
}

/** Assignment requests give up after this long and render control. */
const DEFAULT_TIMEOUT_MS = 2_000;

interface CachedAssignment {
  cell: number;
  idHash: string;
  /** Signatures for the combination's hosted assets, and when they die. */
  assetSignatures?: Record<string, string>;
  assetsExpireAt?: number;
  /** Reward routing for the page-wide tracker (regional tests). */
  region?: string;
  /** rewardEvents:false at create time: skip automatic rewarding. */
  noAuto?: boolean;
}

/** Refresh signatures this long before they expire, not after. */
const ASSET_REFRESH_MARGIN_MS = 60_000;

export async function createTest(
  config: TestConfig | TestConfigInput | string,
  options: CreateTestOptions = {}
): Promise<LiveTest> {
  const win = options.window ?? window;
  // Explicit options win; the page-wide global (set by the tag) fills
  // the gaps, which is what lets page code pass no options at all.
  let pageGlobal = (win as Window & { livevariant?: LiveVariantGlobal })
    .livevariant;
  if (!options.serverUrl && !pageGlobal && options.tagWaitMs !== false) {
    // No way to reach a server yet: the tag may simply not have loaded
    // (tag managers inject it late). Waiting here, not in page code,
    // is what lets every SDK user stay oblivious to that race.
    pageGlobal =
      (await whenTagReady({
        win,
        timeoutMs:
          typeof options.tagWaitMs === "number" ? options.tagWaitMs : 3000
      })) ?? undefined;
  }
  const serverUrl = options.serverUrl ?? pageGlobal?.config?.serverUrl;
  if (!serverUrl) {
    throw new Error(
      "createTest needs a serverUrl: pass it in options, or install the " +
        "LiveVariant tag so the page carries a global config"
    );
  }
  /**
   * The prefix the deployment is mounted under, if any: a serverUrl of
   * "https://host/lv" means its hosted assets live at /lv/a/<hash>, and
   * recognizing them is what triggers asking /choose for signatures. Read
   * off the serverUrl rather than configured separately, because the two
   * can never legitimately disagree.
   */
  const basePath = (() => {
    try {
      return new URL(serverUrl).pathname.replace(/\/+$/, "");
    } catch {
      return "";
    }
  })();
  const publishableKey =
    options.publishableKey ?? pageGlobal?.config?.publishableKey;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  // Explicit Storage object first, then the mode the page's global
  // config declared (so a tag-configured "local" governs npm createTest
  // calls too), then the shared page store.
  const storage =
    options.storage === undefined
      ? resolveStorage(win, pageGlobal?.config?.storage)
      : options.storage;

  // Parsing rather than trusting normalizes the readable shorthands
  // (bare-string variants, `variants` for a single slot) into the
  // canonical form every hash below depends on.
  const input = (
    typeof config === "string" ? JSON.parse(base64UrlToUtf8(config)) : config
  ) as Record<string, unknown>;
  // Keyless inline configs get scoped to the page's hostname: two sites
  // inlining the same trivial test ("Book" vs "Book now") must not hash
  // to the SAME test and pollute each other. Configs with a stats key
  // are already unique (the key hash is random and identity-included),
  // and pre-encoded strings must keep the identity their URLs were
  // printed with, so neither is touched.
  const scoped =
    typeof config !== "string" &&
    input.scope === undefined &&
    input.statsKeyHash === undefined
      ? { ...input, scope: win.location.hostname }
      : input;
  const resolved: TestConfig = parseTestConfig(scoped) as TestConfig;
  const testId = await computeTestId(resolved);

  const entries = slotEntries(resolved);
  const sizes = slotSizes(resolved);
  const dim = dimForShape(sizes, resolved.ctx?.dims.length ?? 0);

  // Redirect handoff first: if this visitor arrived through /s or /c,
  // the server-side assignment (and its idHash) is authoritative. A
  // tampered cell beyond this config's combinations is treated as no
  // handoff rather than silently rendering the wrong variants.
  captureHandoff(win, storage);
  const storedHandoff = getHandoff(storage, testId);
  const handoff =
    storedHandoff && validCell(sizes, storedHandoff.cell)
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
  const featIdx = featureIndices(callerCtx, dim);
  const priors = effectivePriors(resolved);

  // Hosted assets need the server: their canonical URLs 403 on their own,
  // and only /choose can mint working signatures for the winning
  // combination. The hashes are content-free, so sending them keeps the
  // privacy claim. Keys are "slot:variant".
  const slotAssets: Record<string, string[]> = {};
  entries.forEach(([, variants], slot) => {
    variants.forEach((variant, i) => {
      const hashes = [variant.url, variant.image]
        .map(u => (u ? assetIdFromUrl(u, basePath) : null))
        .filter((h): h is string => h !== null);
      if (hashes.length > 0) {
        slotAssets[`${slot}:${i}`] = hashes;
      }
    });
  });

  /** True when the combination uses hosted assets (needs signatures). */
  function usesHostedAssets(cell: number): boolean {
    return decodeCell(sizes, cell).some(
      (variant, slot) => slotAssets[`${slot}:${variant}`] !== undefined
    );
  }

  const { cell, fallback, assetSignatures = {} } = await resolveAssignment();
  const choice = decodeCell(sizes, cell);

  /** Splice a minted signature into a hosted-asset URL. */
  function signed(url: string | undefined): string | undefined {
    if (!url) {
      return url;
    }
    const hash = assetIdFromUrl(url, basePath);
    const sig = hash ? assetSignatures[hash] : undefined;
    return sig ? withQuery(url, sig) : url;
  }

  async function resolveAssignment(): Promise<{
    cell: number;
    fallback: boolean;
    assetSignatures?: Record<string, string>;
  }> {
    if (handoff) {
      // The server already assigned this visitor during the redirect.
      return { cell: handoff.cell, fallback: false };
    }
    const cacheKey = `lv:a:${testId}`;
    if (storage) {
      const raw = storage.getItem(cacheKey);
      if (raw) {
        try {
          const cached = JSON.parse(raw) as CachedAssignment;
          // The cache is per-id: a login that changes the external id must
          // fall through to the server, which owns the sticky record.
          if (cached.idHash === idHash && validCell(sizes, cached.cell)) {
            const needsFreshSignatures =
              usesHostedAssets(cached.cell) &&
              (cached.assetsExpireAt ?? 0) - ASSET_REFRESH_MARGIN_MS <
                Date.now();
            if (!needsFreshSignatures) {
              return {
                cell: cached.cell,
                fallback: false,
                assetSignatures: cached.assetSignatures
              };
            }
            // Stale signatures: re-ask the server. /choose is sticky, so
            // this returns the same combination with fresh signatures; if
            // it is unreachable, the cached combination still renders
            // (its hosted images may 403 until the next successful
            // refresh, which beats flipping the visitor's variants).
            try {
              return await chooseFromServer(cacheKey);
            } catch {
              return { cell: cached.cell, fallback: false };
            }
          }
        } catch {
          storage.removeItem(cacheKey);
        }
      }
    }
    try {
      return await chooseFromServer(cacheKey);
    } catch {
      // Unreachable, too slow, or an unusable answer: render the control
      // combination. A failed experiment must never become a broken page.
      // The result is deliberately NOT cached, so a transient outage
      // cannot pin this visitor to the control for good.
      return { cell: 0, fallback: true };
    }
  }

  async function chooseFromServer(cacheKey: string): Promise<{
    cell: number;
    fallback: boolean;
    assetSignatures?: Record<string, string>;
  }> {
    const response = await fetchImpl(`${serverUrl}/choose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: JSON.stringify({
        sdk: SDK_VERSION,
        testId,
        slotSizes: sizes,
        dim,
        ...(publishableKey
          ? {
              publishableKey,
              encoded:
                typeof config === "string"
                  ? config
                  : utf8ToBase64Url(canonicalJson(resolved))
            }
          : {}),
        region: resolved.region,
        priorStrengthCap: resolved.priorStrengthCap,
        priors: priors.length > 0 ? priors : undefined,
        idHash,
        ctxKey: ctxKey ?? undefined,
        featIdx,
        autoDims,
        autoCtx: Object.keys(autoCtx).length > 0 ? autoCtx : undefined,
        assets: Object.keys(slotAssets).length > 0 ? slotAssets : undefined
      })
    });
    if (!response.ok) {
      if (response.status === 403) {
        // Origin gate: silent-degrade would make this undiagnosable, so
        // name the cause. Serving still falls back to control below.
        console.warn(
          `[livevariant] ${serverUrl} refused this origin ` +
            `(${win.location.origin}); add it to the deployment's ` +
            `LV_ALLOWED_ORIGINS to run tests from this site. Serving control.`
        );
      }
      return { cell: 0, fallback: true };
    }
    const {
      cell: chosen,
      assetSignatures: sigs,
      assetsExpireAt
    } = (await response.json()) as {
      cell: number;
      assetSignatures?: Record<string, string>;
      assetsExpireAt?: number;
    };
    // A nonsense cell (a proxy rewriting the body, a future server
    // version) must not index past the combinations and render nothing.
    if (!validCell(sizes, chosen)) {
      return { cell: 0, fallback: true };
    }
    storage?.setItem(
      cacheKey,
      JSON.stringify({
        cell: chosen,
        idHash,
        assetSignatures: sigs,
        assetsExpireAt,
        // For the page-wide auto-tracker (auto-track.ts), which rewards
        // this assignment from storage: the test's region routes the
        // reward, and noAuto keeps rewardEvents:false tests out.
        ...(resolved.region ? { region: resolved.region } : {}),
        ...(options.rewardEvents === false ? { noAuto: true } : {})
      } satisfies CachedAssignment)
    );
    return { cell: chosen, fallback: false, assetSignatures: sigs };
  }

  /**
   * Minimal by design: the server's assignment record carries its own
   * serving snapshot. Never rejects, because a customer's page may await
   * this inside its own checkout flow and a lost conversion must not
   * become a lost sale.
   */
  async function trackConversion(amount = 1): Promise<void> {
    try {
      await fetchImpl(`${serverUrl}/reward`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        body: JSON.stringify({
          testId,
          idHash,
          amount,
          sdk: SDK_VERSION,
          ...(resolved.region ? { region: resolved.region } : {})
        })
      });
    } catch {
      // Dropped: the model tolerates missing rewards, pages don't
      // tolerate exceptions.
    }
  }

  let watcher: GaWatcher | null = null;
  const rewardEvents =
    options.rewardEvents === false
      ? null
      : (options.rewardEvents ??
        resolved.rewardEvents ??
        pageGlobal?.config?.rewardEvents ??
        DEFAULT_REWARD_EVENTS);
  if (rewardEvents && rewardEvents.length > 0) {
    if (storage) {
      // The cached assignment above makes this test visible to the
      // page-wide tracker, so ensure one exists rather than adding a
      // second watcher: autoTrack's window-level claim makes this a
      // no-op when the tag (or an earlier createTest) already runs one,
      // in either load order.
      autoTrack({
        serverUrl,
        rewardEvents,
        storage,
        fetch: fetchImpl,
        window: win
      });
    } else {
      // No storage means no cache entry for the tracker to find: this
      // test rewards itself the direct way.
      watcher = watchDataLayer(win, rewardEvents, () => {
        // Fire-and-forget: a lost reward must never break the host page.
        void trackConversion().catch(() => undefined);
      });
    }
  }

  const chosenSlots: Record<string, Variant> = {};
  entries.forEach(([key, variants], slot) => {
    const variant = variants[choice[slot]] ?? variants[0];
    chosenSlots[key] = {
      index: choice[slot],
      name: variantName(variant, choice[slot]),
      url: signed(variant.url),
      image: signed(variant.image),
      html: variant.html,
      md: variant.md,
      text: variant.text
    };
  });

  return {
    testId,
    cell,
    slots: chosenSlots,
    variant: chosenSlots[entries[0][0]],
    fallback,
    trackConversion,
    // A string input IS the encoded config; objects go through the same
    // canonical serialization the encoder uses.
    urls: buildTestUrls(
      serverUrl,
      typeof config === "string"
        ? config
        : utf8ToBase64Url(canonicalJson(resolved))
    ),
    dispose() {
      watcher?.stop();
    }
  };
}
