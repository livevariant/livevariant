import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import {
  assetIdFromUrl,
  autoContextDisabled,
  cellNames,
  configFromParams,
  decodeCell,
  decorateDestination,
  fallbackTarget,
  passthroughParams,
  composeBucketKey,
  decodeConfig,
  decorateUrl,
  deriveAutoCtx,
  externalIdHash,
  isAssetFetch,
  mergeFeatureIndices,
  requestSignals,
  mulberry32,
  slotEntries,
  sourceHash,
  randomSeed,
  verifyStatsSecret,
  type CloudflareGeo,
  type DecodedConfig,
  type Rng,
  type Variant
} from "@livevariant/core";
import {
  chooseRequestSchema,
  excludeRequestSchema,
  rewardRequestSchema,
  MAX_REWARD_AMOUNT
} from "./api-schemas.js";
import { createApi } from "./api.js";
import { signAsset } from "./assets/sign.js";
import {
  createAssetRoutes,
  signAssetUrl,
  DEFAULT_ASSET_TTL_SECONDS,
  type AssetOptions
} from "./assets/routes.js";
import { renderInterstitialPage } from "./interstitial-page.js";
import { renderManagePage } from "./manage-page.js";
import {
  envTrustPolicy,
  originMatches,
  type RedirectVerdict,
  type TrustContext,
  type TrustPolicy,
  type UnlistedDestinationMode
} from "./trust.js";
import {
  labelsFromConfig,
  paramsFromConfig,
  resolveIdentity,
  TestService,
  type RequestContext,
  type ServingParams,
  type TestBackend
} from "./service.js";
import type { StateStore } from "./store/types.js";

export interface AppOptions {
  /** In-process backend over a StateStore (Node, tests). */
  store?: StateStore;
  /** Pre-built backend; the Workers deployment passes a DO-backed one. */
  backend?: TestBackend;
  /** Injectable for deterministic tests; defaults to a random seed. */
  rng?: Rng;
  /**
   * Hostnames redirects may send visitors to; a hostname admits its
   * subdomains. Unset means no list, and what happens then is decided
   * by `unlistedDestinations` (anyone can author a config, so the
   * config's own origins are not a trust boundary).
   */
  allowedDestinations?: string[];
  /**
   * Page origins allowed to drive tests through /choose and /reward.
   * Unset means any origin. A hygiene control for self-hosters running
   * their own sites, not authentication: only requests that carry an
   * Origin header are checked, because server-to-server callers have
   * none, and a non-browser client can claim any origin anyway.
   */
  allowedOrigins?: string[];
  /**
   * What redirects do with a destination the allowlist does not name:
   * "allow" it, "block" it, or show the visitor an explicit
   * "Redirecting you to…" page ("interstitial"). Defaults keep the
   * classic semantics: allow-all with no list, block-unlisted with one.
   * The hosted deployment runs "interstitial" with no list, which is
   * what keeps it open without being an open redirector.
   */
  unlistedDestinations?: UnlistedDestinationMode;
  /**
   * Full custom trust policy; overrides the three options above. This
   * is the hook for deployments with their own notion of which origins
   * and destinations to trust (the hosted registry of verified domains
   * is one implementation).
   */
  trust?: TrustPolicy;
  /**
   * Optional image hosting: uploads at /assets, signed serving at /a.
   * Unset disables both routes entirely, and configs referencing hosted
   * assets simply 403 at fetch time.
   */
  assets?: Omit<AssetOptions, "serveUrl">;
  /**
   * Origin to put in the links visitors follow. Unset means every URL is
   * built from the origin the request arrived on, so a one-domain deploy
   * needs no configuration; set it when serving has its own domain, to
   * keep bulk email traffic off the dashboard's reputation.
   */
  serveUrl?: string;
}

/** 1x1 transparent GIF for the no-JS conversion pixel. */
const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  c => c.charCodeAt(0)
);

/** Server ceiling on prior strength, regardless of caller-supplied caps. */
const MAX_PRIOR_STRENGTH = 50;

/** Redirects and pixels must never be cached: they are per-visitor. */
const NO_STORE = "no-store, private";

export function createApp(options: AppOptions): Hono {
  const service: TestBackend =
    options.backend ??
    new TestService(
      options.store as StateStore,
      options.rng ?? mulberry32(randomSeed())
    );
  const app = new Hono();

  // Browser-called endpoints must be CORS-open: the SDK runs on customer
  // sites (/choose, /reward) and the dashboard is a different origin than
  // the serving domain (/stats, /recompute). Wildcard is safe here: no
  // cookies are involved anywhere, and /stats authorizes via the bearer
  // secret, not the origin.
  const openCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "authorization"]
  });
  // The SDK endpoints narrow to the origin allowlist when one is set: a
  // preflight can only be answered from the env list (no body to derive
  // a test from), and the handlers re-check through the trust policy
  // before writing anything.
  const sdkOrigins = (options.allowedOrigins ?? []).filter(Boolean);
  const sdkCors =
    sdkOrigins.length === 0
      ? openCors
      : cors({
          origin: origin => (originMatches(origin, sdkOrigins) ? origin : ""),
          allowMethods: ["POST", "OPTIONS"],
          allowHeaders: ["content-type"]
        });
  app.use("/choose", sdkCors);
  app.use("/reward", sdkCors);
  app.use("/stats/*", openCors);
  app.use("/recompute/*", openCors);
  app.use("/exclude/*", openCors);

  /**
   * The handler-side origin gate for /choose and /reward: 403 before
   * anything is recorded. Only requests carrying an Origin header are
   * checked; server-to-server callers have none, and against a client
   * that can forge one this is hygiene, not authentication.
   */
  async function originDenied(
    c: Context,
    testId: string
  ): Promise<Response | null> {
    const origin = c.req.header("origin");
    if (!origin) {
      return null;
    }
    const allowed = await trust.isOriginAllowedForSDK(origin, {
      testId,
      requestUrl: c.req.url
    });
    return allowed
      ? null
      : c.json({ error: "origin not allowed by this server" }, 403);
  }

  /**
   * Everything the platform tells us about a request. On Workers the geo
   * arrives on `request.cf`; elsewhere it is simply absent and only the
   * header-derived signals (device, language) are available.
   */
  function requestContext(c: {
    req: { raw: Request; header(name: string): string | undefined };
  }): RequestContext {
    const cf = (c.req.raw as Request & { cf?: CloudflareGeo }).cf ?? null;
    return {
      geo: cf,
      userAgent: c.req.header("user-agent"),
      acceptLanguage: c.req.header("accept-language"),
      assetFetch: isAssetFetch({
        accept: c.req.header("accept"),
        secFetchDest: c.req.header("sec-fetch-dest")
      })
    };
  }

  /** Client address, as Cloudflare (or a proxy) reports it. */
  function clientIp(c: {
    req: { header(name: string): string | undefined };
  }): string | null {
    return (
      c.req.header("cf-connecting-ip") ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      null
    );
  }

  /** Query params prefixed c_ carry context: ?c_device=mobile&c_country=nl */
  function ctxFromQuery(query: Record<string, string>): Record<string, string> {
    const ctx: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (key.startsWith("c_") && key.length > 2) {
        ctx[key.slice(2)] = value;
      }
    }
    return ctx;
  }

  async function decodeOr404(
    encoded: string
  ): Promise<{ decoded: DecodedConfig } | { error: Response }> {
    try {
      return { decoded: await decodeConfig(encoded) };
    } catch (err) {
      return {
        error: Response.json(
          { error: err instanceof Error ? err.message : "invalid config" },
          { status: 404 }
        )
      };
    }
  }

  /**
   * The query-parameter spelling of a config. Failure is handled very
   * differently from the base64 path: these URLs are assembled by hand in
   * an ESP template, so a wrong one is a broken image in front of the
   * whole recipient list. If anything looks like a variant we serve the
   * first one and run no test at all, because a campaign should degrade
   * to "not measured", never to a hole in the layout.
   */
  async function paramsOr404(
    query: URLSearchParams,
    requestUrl: string,
    navigation: boolean
  ): Promise<{ decoded: DecodedConfig } | { error: Response }> {
    try {
      return { decoded: await configFromParams(query) };
    } catch (err) {
      const target = fallbackTarget(query);
      const verdict = target
        ? await destinationVerdict(target, { testId: "", requestUrl })
        : false;
      if (target && verdict !== false) {
        // Same shape as the main serve path: unverified destinations
        // show the continue screen to navigations and 302 otherwise
        // (an ESP's broken template is usually an image fetch).
        if (verdict === "interstitial" && navigation) {
          return { error: interstitialResponse(target) };
        }
        return {
          error: new Response(null, {
            status: 302,
            headers: { location: target, "cache-control": NO_STORE }
          })
        };
      }
      return {
        error: Response.json(
          { error: err instanceof Error ? err.message : "invalid config" },
          { status: 404 }
        )
      };
    }
  }

  /**
   * The operator's trust policy is the only real anti-phishing control
   * here, because anyone can author a config, so a config's own origins
   * prove nothing. Env-driven by default; a custom policy (the hosted
   * verified-domain registry) plugs in through options.trust.
   */
  const trust =
    options.trust ??
    envTrustPolicy({
      allowedOrigins: options.allowedOrigins,
      allowedDestinations: options.allowedDestinations,
      unlistedDestinations: options.unlistedDestinations
    });
  /**
   * A target is OUR hosted asset only when both the path shape AND the
   * host say so. The path alone is spoofable: evil.com/a/<64hex> matches
   * the shape, and treating it as ours would hand out an allowlist
   * bypass on exactly the control meant to stop hostile redirects.
   * "Ours" is the host the request arrived on, plus the configured
   * serving host (a .com dashboard serves configs whose assets live on
   * the .link serving domain).
   */
  function ownAssetId(target: string, requestUrl: string): string | null {
    const id = assetIdFromUrl(target);
    if (!id) {
      return null;
    }
    try {
      const host = new URL(target).host;
      const own = new Set([new URL(requestUrl).host]);
      if (options.serveUrl) {
        own.add(new URL(options.serveUrl).host);
      }
      return own.has(host) ? id : null;
    } catch {
      return null;
    }
  }

  async function destinationVerdict(
    target: string,
    ctx: TrustContext
  ): Promise<RedirectVerdict> {
    // OUR hosted assets never leave this deployment, so the trust policy
    // (an anti-phishing control on outbound redirects) does not apply to
    // them. Foreign URLs that merely look like asset paths get no such
    // pass.
    if (ownAssetId(target, ctx.requestUrl)) {
      return true;
    }
    let host: string;
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      return false;
    }
    return trust.isDomainAllowedForRedirect(host, ctx);
  }

  function trustContext(
    decoded: DecodedConfig,
    requestUrl: string
  ): TrustContext {
    return {
      testId: decoded.testId,
      statsKeyHash: decoded.config.statsKeyHash,
      requestUrl
    };
  }

  /**
   * The strictest verdict across a test's candidate destinations, so a
   * decision is made once per test, never per variant: a test mixing a
   * verified and an unverified domain must give every variant the same
   * friction, or the model would be measuring our interstitial instead
   * of the creative.
   */
  async function destinationsVerdict(
    targets: string[],
    ctx: TrustContext
  ): Promise<RedirectVerdict> {
    let verdict: RedirectVerdict = true;
    for (const target of targets) {
      const v = await destinationVerdict(target, ctx);
      if (v === false) {
        return false;
      }
      if (v === "interstitial") {
        verdict = "interstitial";
      }
    }
    return verdict;
  }

  /**
   * Whether this request is a human navigation, which is what decides
   * interstitial eligibility: HTML handed to an email client's image
   * fetch would break the flagship use case, so anything not clearly a
   * navigation gets the plain 302 it gets today.
   */
  function isNavigation(c: {
    req: { header(name: string): string | undefined };
  }): boolean {
    const dest = c.req.header("sec-fetch-dest");
    if (dest) {
      return dest === "document";
    }
    return c.req.header("accept")?.includes("text/html") ?? false;
  }

  /** The interstitial response for an approved-but-unverified target. */
  function interstitialResponse(continueUrl: string): Response {
    let host: string;
    try {
      host = new URL(continueUrl).hostname;
    } catch {
      host = continueUrl;
    }
    return new Response(
      renderInterstitialPage({ continueUrl, destinationHost: host }),
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": NO_STORE
        }
      }
    );
  }

  /**
   * Click ?to= must additionally land on an origin the config itself
   * names, which stops a legitimate campaign's link from being re-pointed
   * by appending ?to=. It is not a phishing control on its own (see
   * destinationAllowed).
   */
  function isAllowedRedirect(
    config: DecodedConfig["config"],
    to: string
  ): boolean {
    let origin: string;
    try {
      origin = new URL(to).origin;
    } catch {
      return false;
    }
    const candidates: Array<string | undefined> = [config.redirectUrl];
    for (const variants of Object.values(config.slots)) {
      for (const variant of variants) {
        candidates.push(variant.url, variant.image, variant.redirectUrl);
      }
    }
    return candidates.some(url => {
      try {
        return url !== undefined && new URL(url).origin === origin;
      } catch {
        return false;
      }
    });
  }

  /** Shared preamble for the two redirect handlers. */
  async function serveContext(c: {
    req: {
      raw: Request;
      param(name: string): string;
      query(): Record<string, string>;
      query(name: string): string | undefined;
      header(name: string): string | undefined;
    };
  }): Promise<
    | { error: Response }
    | {
        decoded: DecodedConfig;
        params: ServingParams;
        identity: Awaited<ReturnType<typeof resolveIdentity>>;
        query: URLSearchParams;
      }
  > {
    const query = new URL(c.req.raw.url).searchParams;
    // Two spellings of one test: a base64 config in the path, or plain
    // parameters. Both parse to a TestConfig and hash to the same testId,
    // so nothing downstream needs to know which arrived.
    const encoded = c.req.param("cfg");
    const result = encoded
      ? await decodeOr404(encoded)
      : await paramsOr404(query, c.req.raw.url, isNavigation(c));
    if ("error" in result) {
      return result;
    }
    const { decoded } = result;
    const params = paramsFromConfig(decoded);
    // The config is authoritative: it defines the test's real shape, so
    // it overwrites anything a JS-mode caller pinned earlier.
    await service.checkShape(params, true);
    const externalId = c.req.query("id") ?? null;
    const identity = await resolveIdentity(
      decoded,
      params.dim,
      externalId ? await externalIdHash(decoded.testId, externalId) : null,
      ctxFromQuery(c.req.query()),
      await sourceHash(decoded.testId, clientIp(c), Date.now()),
      {
        ...requestContext(c),
        noAuto: autoContextDisabled(c.req.query("auto")),
        query
      }
    );
    return { decoded, params, identity, query };
  }

  /**
   * Everything that rides along to the destination: our own handoff
   * token, whatever attribution the link already carried, and optionally
   * the served variant stamped into a parameter of the customer's
   * choosing so the test shows up in their analytics unaided.
   */
  function maybeDecorate(
    decoded: DecodedConfig,
    identity: { idHash: string | null },
    cell: number,
    choice: number[],
    target: string,
    query?: URLSearchParams
  ): string {
    const { config } = decoded;
    const withHandoff =
      config.decorateRedirects && identity.idHash
        ? decorateUrl(target, {
            testId: decoded.testId,
            idHash: identity.idHash,
            cell,
            // Rides along so config-free reward paths (GTM one-tag mode)
            // can still route to the test's real home.
            ...(config.region ? { region: config.region } : {})
          })
        : target;
    // The stamp is the served combination: one name for a single slot,
    // "heroB+ctaA" for several, so it stays legible in analytics tools.
    const names = Object.values(cellNames(config, choice));
    return decorateDestination(withHandoff, {
      passthrough:
        config.forwardParams && query ? passthroughParams(query) : [],
      variantParam: config.variantParam,
      variantValue: names.join("+")
    });
  }

  /**
   * Stats secret via Authorization: Bearer only. Query parameters would
   * land in access/proxy logs; the shareable manage URL instead carries
   * the secret in its #fragment, which never leaves the browser, and the
   * manage page's script converts it into this Bearer header.
   */
  async function authorized(
    c: { req: { header(name: string): string | undefined } },
    decoded: DecodedConfig
  ): Promise<boolean> {
    const header = c.req.header("authorization");
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    const secret = match?.[1];
    const { statsKeyHash } = decoded.config;
    // A config without a stats key has no owner: nothing can match, so
    // every creator-only endpoint stays shut rather than open.
    if (!secret || !statsKeyHash) {
      return false;
    }
    return verifyStatsSecret(secret, statsKeyHash);
  }

  app.get("/health", c => c.json({ ok: true }));

  if (options.assets) {
    app.route(
      "/",
      createAssetRoutes({ ...options.assets, serveUrl: options.serveUrl })
    );
  }

  /**
   * Redirect targets that are hosted assets get a fresh signature here,
   * which is the only place working asset URLs come from: the canonical
   * address in the config answers 403 on its own. When this deployment
   * has no asset store the URL passes through untouched and fails at
   * fetch time, which is honest about the misconfiguration.
   */
  async function maybeSignAsset(
    target: string,
    requestUrl: string
  ): Promise<string> {
    const assetId = ownAssetId(target, requestUrl);
    if (!assetId || !options.assets) {
      return target;
    }
    return signAssetUrl(target, assetId, options.assets);
  }

  // The tool API, OpenAPI document, Swagger page and MCP endpoint, all
  // generated from the shared registry. Always mounted: one domain doing
  // everything is the default shape, and a deployment that wants serving
  // on its own domain sets serveUrl rather than turning anything off.
  //
  // The injected fetch routes back into this same app rather than over the
  // network, which is what lets get_stats read /stats: a Worker cannot
  // fetch its own hostname.
  app.route(
    "/",
    createApi({
      serveUrl: options.serveUrl,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        app.fetch(new Request(input as RequestInfo, init))) as typeof fetch
    })
  );

  /**
   * Which slot a redirect request is serving. A single-slot test needs
   * no parameter; a multi-slot test must say ?slot=, because a redirect
   * can only carry one slot's content and guessing would silently serve
   * the wrong element.
   */
  function resolveSlot(
    decoded: DecodedConfig,
    requested: string | undefined
  ): { key: string; index: number; variants: Variant[] } | { error: Response } {
    const entries = slotEntries(decoded.config);
    if (requested === undefined && entries.length === 1) {
      return { key: entries[0][0], index: 0, variants: entries[0][1] };
    }
    const index = entries.findIndex(([key]) => key === requested);
    if (index === -1) {
      return {
        error: Response.json(
          {
            error:
              entries.length === 1
                ? `unknown slot "${requested}"`
                : `multi-slot test: pass ?slot= (one of: ${entries
                    .map(([key]) => key)
                    .join(", ")})`
          },
          { status: 400 }
        )
      };
    }
    return { key: entries[index][0], index, variants: entries[index][1] };
  }

  // Redirect-mode serve: 302 to the assigned combination's content for
  // one slot. Registered twice: /s/:cfg carries a base64 config, bare /s
  // spells the same test out in query parameters (the ESP-template form).
  const serveHandler = async (c: Context): Promise<Response> => {
    const ctx = await serveContext(c);
    if ("error" in ctx) {
      return ctx.error;
    }
    const { decoded, params, identity, query } = ctx;
    // A redirect serves ONE slot's content per request; a multi-slot
    // email carries one /s link per slot (?slot=hero, ?slot=cta), all of
    // which share one sticky whole-combination assignment.
    const slot = resolveSlot(decoded, c.req.query("slot"));
    if ("error" in slot) {
      return slot.error;
    }
    // EVERY variant of the served slot must be servable and allowed
    // before we record anything. Checking only the chosen variant
    // afterwards would sticky-assign a visitor to a combination they can
    // never be served, so every later visit returns the same assignment
    // and the same error.
    const unservable = slot.variants.find(v => !(v.url ?? v.image));
    if (unservable) {
      return c.json(
        {
          error: `slot "${slot.key}" has a variant with no url/image for redirect serving`
        },
        400
      );
    }
    const verdict = await destinationsVerdict(
      slot.variants.map(v => (v.url ?? v.image) as string),
      trustContext(decoded, c.req.url)
    );
    if (verdict === false) {
      return c.json({ error: "destination not allowed by this server" }, 403);
    }
    const { cell } = await service.assign(params, identity);
    const choice = decodeCell(params.slotSizes, cell);
    const variant = slot.variants[choice[slot.index]];
    const target = (variant.url ?? variant.image) as string;
    // Handoff decoration applies to pages, not image assets.
    const decorated = variant.url
      ? maybeDecorate(decoded, identity, cell, choice, target, query)
      : target;
    const destination = await maybeSignAsset(decorated, c.req.url);
    // Unverified destinations show the continue screen, but only to a
    // human navigation headed for a page: an email client fetching an
    // image variant must always get its 302.
    if (verdict === "interstitial" && variant.url && isNavigation(c)) {
      return interstitialResponse(destination);
    }
    c.header("cache-control", NO_STORE);
    return c.redirect(destination, 302);
  };
  app.get("/s/:cfg", serveHandler);
  app.get("/s", serveHandler);

  // Click: rewards (id'd traffic) and redirects onward. Same two
  // spellings as /s.
  const clickHandler = async (c: Context): Promise<Response> => {
    const ctx = await serveContext(c);
    if ("error" in ctx) {
      return ctx.error;
    }
    const { decoded, params, identity, query } = ctx;
    const slot = resolveSlot(decoded, c.req.query("slot"));
    if ("error" in slot) {
      return slot.error;
    }
    const to = c.req.query("to");
    // Validate every destination BEFORE recording anything: an error that
    // has already counted a conversion would skew the test, and an error
    // after a sticky assignment would repeat for that visitor forever.
    if (to !== undefined && !isAllowedRedirect(decoded.config, to)) {
      return c.json(
        { error: "?to= must be on an origin the test config references" },
        400
      );
    }
    const candidates =
      to !== undefined
        ? [to]
        : slot.variants.map(v => v.redirectUrl ?? decoded.config.redirectUrl);
    if (candidates.some(target => target === undefined)) {
      return c.json(
        { error: "no redirect target: pass ?to= or set a redirectUrl" },
        400
      );
    }
    const verdict = await destinationsVerdict(
      candidates as string[],
      trustContext(decoded, c.req.url)
    );
    if (verdict === false) {
      return c.json({ error: "destination not allowed by this server" }, 403);
    }
    // A click implies a serve, so assign (sticky or fresh) before rewarding.
    const { cell } = await service.assign(params, identity);
    const choice = decodeCell(params.slotSizes, cell);
    const variant = slot.variants[choice[slot.index]];
    const target = (to ??
      variant.redirectUrl ??
      decoded.config.redirectUrl) as string;
    if (identity.idHash) {
      await service.reward(
        decoded.testId,
        identity.idHash,
        1,
        decoded.config.region
      );
    }
    const destination = await maybeSignAsset(
      maybeDecorate(decoded, identity, cell, choice, target, query),
      c.req.url
    );
    // The reward above is already recorded either way; abandonment at
    // the continue screen is uniform across variants, so it cannot bias
    // the comparison. Non-navigations (link scanners) still 302.
    if (verdict === "interstitial" && isNavigation(c)) {
      return interstitialResponse(destination);
    }
    c.header("cache-control", NO_STORE);
    return c.redirect(destination, 302);
  };
  app.get("/c/:cfg", clickHandler);
  app.get("/c", clickHandler);

  // No-JS conversion pixel for thank-you pages.
  app.get("/px/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if (!("error" in result)) {
      const { decoded } = result;
      const externalId = c.req.query("id");
      const amount = Number(c.req.query("amount") ?? "1");
      // Same bound as /reward: the pixel URL is public (it carries the raw
      // recipient id in emails), so an unbounded amount lets any recipient
      // or link-scanner drive rewardTotal to Infinity.
      if (
        externalId &&
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= MAX_REWARD_AMOUNT
      ) {
        await service.reward(
          decoded.testId,
          await externalIdHash(decoded.testId, externalId),
          amount,
          decoded.config.region
        );
      }
    }
    // Always the pixel, never an error: this sits in end-user pages.
    return c.body(PIXEL_GIF.slice().buffer, 200, {
      "content-type": "image/gif",
      "cache-control": "no-store, private"
    });
  });

  // JS-mode choose: content-free request, arm index response.
  app.post("/choose", async c => {
    const body = chooseRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "invalid request", details: body.error.issues },
        400
      );
    }
    const r = body.data;
    const denied = await originDenied(c, r.testId);
    if (denied) {
      return denied;
    }
    // The caller supplies both the priors and their cap, so the cap can't
    // be trusted to bound them: clamp to the server's own ceiling, which
    // is what keeps a hostile prior from pinning a variant (priors are
    // baked into persisted model state on first write).
    const cap = Math.min(r.priorStrengthCap ?? 50, MAX_PRIOR_STRENGTH);
    const params: ServingParams = {
      testId: r.testId,
      slotSizes: r.slotSizes,
      dim: r.dim,
      priors: r.priors?.map(p => ({
        ...p,
        strength: Math.min(p.strength, cap)
      })),
      noise: r.noise,
      region: r.region
    };
    if (!(await service.checkShape(params, false))) {
      return c.json(
        { error: "slotSizes/dim disagree with this test's serving shape" },
        409
      );
    }
    // JS mode sends a hash of its own context, so the server composes its
    // derived dimensions on top of that hash rather than into the map.
    // Redirect mode takes the same path (see resolveIdentity), which is
    // what keeps one context in one bucket across both channels.
    // Not gated on isAssetFetch: this is a POST from page JavaScript, so
    // a real visitor is already established. Mail proxies fetch images,
    // they do not run scripts.
    const signals = requestSignals(requestContext(c));
    const autoCtx = deriveAutoCtx(r.autoDims, signals, r.autoCtx ?? null);
    const { cell } = await service.assign(params, {
      idHash: r.idHash ?? null,
      ctxKey: await composeBucketKey(r.testId, r.ctxKey ?? null, autoCtx),
      featIdx: mergeFeatureIndices(r.featIdx ?? [0], autoCtx, r.dim),
      srcHash: await sourceHash(r.testId, clientIp(c), Date.now()),
      signals
    });
    const choice = decodeCell(r.slotSizes, cell);
    // Signatures for the WINNING combination's hosted assets only. The
    // SDK holds canonical asset URLs in its config that 403 on their own;
    // this is the JS-mode counterpart of the redirect path signing its
    // Location. Minting is deliberately scoped to the chosen variant of
    // each slot: the caller told us every variant's hashes, but only the
    // served combination gets working URLs.
    const wanted = options.assets
      ? choice.flatMap((v, slot) => r.assets?.[`${slot}:${v}`] ?? [])
      : [];
    if (wanted.length === 0) {
      return c.json({ cell, choice });
    }
    const ttlSeconds =
      options.assets?.urlTtlSeconds ?? DEFAULT_ASSET_TTL_SECONDS;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const assetSignatures: Record<string, string> = {};
    for (const hash of new Set(wanted)) {
      assetSignatures[hash] = await signAsset(
        (options.assets as AssetOptions).signingSecret,
        hash,
        expiresAt
      );
    }
    return c.json({ cell, choice, assetSignatures, assetsExpireAt: expiresAt });
  });

  app.post("/reward", async c => {
    const body = rewardRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "invalid request", details: body.error.issues },
        400
      );
    }
    const r = body.data;
    const denied = await originDenied(c, r.testId);
    if (denied) {
      return denied;
    }
    const result = await service.reward(r.testId, r.idHash, r.amount, r.region);
    return c.json({ rewarded: result !== null, first: result?.first ?? false });
  });

  // Creator-only endpoints, gated by the stats secret.
  app.get("/stats/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    if (!(await authorized(c, decoded))) {
      return c.json({ error: "stats secret required" }, 401);
    }
    return c.json(
      await service.stats(paramsFromConfig(decoded), labelsFromConfig(decoded))
    );
  });

  app.post("/recompute/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    if (!(await authorized(c, decoded))) {
      return c.json({ error: "stats secret required" }, 401);
    }
    const events = await service.recompute(paramsFromConfig(decoded));
    return c.json({ ok: true, events });
  });

  /**
   * Creator quarantine: exclude traffic sources or time windows, then
   * recompute so the exclusion applies to history, not just new traffic.
   * Source hashes come from the perSource breakdown in /stats.
   */
  app.post("/exclude/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    if (!(await authorized(c, decoded))) {
      return c.json({ error: "stats secret required" }, 401);
    }
    const body = excludeRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json(
        { error: "invalid request", details: body.error.issues },
        400
      );
    }
    const policy = await service.updatePolicy(
      decoded.testId,
      {
        excludedSources: body.data.sources,
        excludedWindows: body.data.windows
      },
      decoded.config.region
    );
    const events = await service.recompute(paramsFromConfig(decoded));
    return c.json({ ok: true, events, policy });
  });

  // Unauthenticated static shell: exposes nothing beyond the (public)
  // config; its script reads the secret from the #fragment and fetches
  // /stats with a Bearer header.
  app.get("/manage/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    return c.html(renderManagePage(result.decoded.config, c.req.param("cfg")));
  });

  return app;
}
