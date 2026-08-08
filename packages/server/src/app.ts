import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
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
  geoFromRequest,
  type RequestGeo,
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
import type { AccountsProvider } from "./accounts-port.js";
import { SERVER_VERSION } from "./version.js";
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
   * Accounts sub-app (sign-in, key claiming, domains), mounted at "/".
   * Built elsewhere and passed in ready-made: this package never
   * imports an auth framework, which is what keeps one out of a
   * self-hoster's bundle.
   */
  accounts?: Hono;
  /**
   * The read side of accounts for the creator-only endpoints. Unset
   * (self-host, Node, tests) keeps the classic bearer-secret behavior.
   */
  provider?: AccountsProvider;
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
  /**
   * Self-host machine credential: when set, the tool API (/api/v1) and
   * /mcp require it as a Bearer token. See ApiOptions.apiToken.
   */
  apiToken?: string;
  /** GTM container id for the dashboard pages. See ApiOptions.gtmId. */
  gtmId?: string;
  /** The deployment's own key. See ApiOptions.publishableKey. */
  publishableKey?: string;
  /** OpenAI Apps domain-verification token. See ApiOptions.openaiAppsChallengeToken. */
  openaiAppsChallengeToken?: string;
  /**
   * First-party identity cookie for id-less serve/click NAVIGATIONS
   * (LV_BROWSER_ID_COOKIE, "off" disables). Image fetches and ?auto=0
   * links (email) never see it: proxies strip cookies there anyway,
   * and minting one would be tracking theater. False = fully
   * cookieless deployment.
   */
  browserIdCookie?: boolean;
  /**
   * How often GET /stats/:cfg/stream re-reads the event log to look for
   * something new to push. Injectable so tests do not wait wall-clock
   * seconds; deployments keep the default.
   */
  statsStreamIntervalMs?: number;
  /** Static app-shell fetcher for the homepage. See ApiOptions.spaFetch. */
  spaFetch?: (request: Request) => Promise<Response>;
  /**
   * Path prefix this app is mounted under, for deployments that do not own
   * the root of their origin: behind a reverse proxy, or embedded in a
   * larger application that owns "/". Leading slash, no trailing one
   * ("/lv"). Empty (the default) is the one-domain shape.
   *
   * Set `serveUrl` to the origin PLUS the same prefix, so the links handed
   * to visitors resolve; the link builders take a path there happily.
   */
  basePath?: string;
  /**
   * Where a request's geography comes from. Defaults to `geoFromRequest`,
   * which reads Cloudflare's `request.cf` and Vercel's `x-vercel-ip-*`
   * headers. Anything else passes its own resolver rather than having a
   * third header convention baked into core.
   */
  geo?: (request: Request) => RequestGeo | null;
  /**
   * Keeps a promise alive past the response, for work that must not
   * block it (today: SDK registration). Defaults to the platform's own
   * `executionCtx.waitUntil` when there is one, and to letting the
   * promise run unanchored when there is not. On Vercel, pass `after`
   * from `next/server` or `waitUntil` from `@vercel/functions`, or the
   * function can be frozen before the work lands.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Mount the tool API, OpenAPI document, Swagger page, MCP endpoint and
   * the agent-discovery routes (/, /llms.txt, /.well-known/*, /robots.txt,
   * /sitemap.xml). Default true, which is the standalone deployment.
   *
   * An application embedding this app owns those paths itself and exposes
   * the tools through its own surfaces, so it sets false and gets only the
   * serving and creator endpoints.
   */
  toolApi?: boolean;
  /**
   * How many times GET /stats/:cfg/stream re-reads the log before closing
   * and letting the client reconnect. Default 360, about half an hour at
   * the default interval. Lower it to fit inside a platform's function
   * duration cap.
   */
  statsStreamMaxTicks?: number;
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

/**
 * A stats stream re-reads the log this many times, then closes and lets
 * the client reconnect: at the default interval that is ~30 minutes, long
 * enough that a watched dashboard never notices, short enough that an
 * abandoned tab's Worker is reclaimed.
 */
const MAX_STREAM_TICKS = 360;

export function createApp(options: AppOptions): Hono {
  const service: TestBackend =
    options.backend ??
    new TestService(
      options.store as StateStore,
      options.rng ?? mulberry32(randomSeed())
    );
  const basePath = (options.basePath ?? "").replace(/\/+$/, "");
  // Hono matches against the full incoming path, so the prefix has to be
  // declared here rather than stripped by the host: every route below,
  // every middleware pattern and the SPA fallback all inherit it.
  const app = basePath ? new Hono().basePath(basePath) : new Hono();
  const resolveGeo = options.geo ?? geoFromRequest;
  const streamMaxTicks = options.statsStreamMaxTicks ?? MAX_STREAM_TICKS;
  /**
   * Anchors background work to the platform's request lifetime when there
   * is one. Cloudflare has executionCtx; Node has nothing and the promise
   * simply runs; a serverless host that freezes between invocations MUST
   * pass its own, or the work is silently dropped.
   */
  const keepAlive = (c: Context, promise: Promise<unknown>): void => {
    if (options.waitUntil) {
      options.waitUntil(promise);
      return;
    }
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      // Node has no executionCtx; let it run unanchored (dev only).
      void promise;
    }
  };

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
    return {
      geo: resolveGeo(c.req.raw),
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
    const id = assetIdFromUrl(target, basePath);
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

  /** Attaches a Set-Cookie to a hand-built Response (mutable headers). */
  function withCookie(res: Response, cookie?: string): Response {
    if (cookie) {
      res.headers.append("set-cookie", cookie);
    }
    return res;
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
        /** A browser-id cookie to attach to whatever response goes out. */
        setCookie?: string;
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
    const resolved = await resolveServeIdentity(c, decoded.testId);
    const identity = await resolveIdentity(
      decoded,
      params.dim,
      resolved.idHash,
      ctxFromQuery(c.req.query()),
      await sourceHash(decoded.testId, clientIp(c), Date.now()),
      {
        ...requestContext(c),
        noAuto: autoContextDisabled(c.req.query("auto")),
        query
      }
    );
    return { decoded, params, identity, query, setCookie: resolved.setCookie };
  }

  const BROWSER_ID_COOKIE = "lv_uid";
  const BROWSER_ID_TTL_S = 180 * 24 * 60 * 60;

  /**
   * Who this serve/click is for, strongest source first:
   *
   *   1. ?id=     the caller's own identifier (email merge tags), hashed
   *               per test here;
   *   2. ?_lvid=  an already-hashed identity, which is how the tag reuses
   *               a redirect handoff for the SAME test embedded on the
   *               landing page (email and page then show one variant);
   *   3. lv_uid   the first-party browser cookie, minted on id-less page
   *               NAVIGATIONS so a shared redirect link is sticky and
   *               rewardable for return visits. Never on image fetches
   *               (mail proxies and cross-site embeds strip cookies) and
   *               never on ?auto=0 links (email by declaration).
   *
   * The cookie's raw value never reaches storage: like ?id=, it is
   * hashed per test, so one browser yields unlinkable identities across
   * tests.
   */
  async function resolveServeIdentity(
    c: {
      req: {
        query(name: string): string | undefined;
        header(name: string): string | undefined;
      };
    },
    testId: string
  ): Promise<{ idHash: string | null; setCookie?: string }> {
    const raw = c.req.query("id");
    if (raw) {
      return { idHash: await externalIdHash(testId, raw) };
    }
    const preHashed = c.req.query("_lvid");
    if (preHashed && /^[0-9a-f]{64}$/.test(preHashed)) {
      return { idHash: preHashed };
    }
    if (
      options.browserIdCookie === false ||
      !isNavigation(c) ||
      autoContextDisabled(c.req.query("auto"))
    ) {
      return { idHash: null };
    }
    const existing = (c.req.header("cookie") ?? "").match(
      /(?:^|;\s*)lv_uid=([A-Za-z0-9-]{8,64})/
    )?.[1];
    const uid = existing ?? crypto.randomUUID();
    return {
      idHash: await externalIdHash(testId, uid),
      setCookie: existing
        ? undefined
        : `${BROWSER_ID_COOKIE}=${uid}; Max-Age=${BROWSER_ID_TTL_S}; ` +
          `Path=/; Secure; HttpOnly; SameSite=Lax`
    };
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
   * page's script converts it into this Bearer header.
   *
   * With an accounts provider configured, a claimed key adds a second
   * way in (a session in the owning org) and lockReads can remove the
   * first. Read the branches in order and note what does not change:
   * with no provider, or for an unclaimed key, this is byte-for-byte
   * the classic zero-I/O check, which is the self-host guarantee. Not
   * on the serving hot path: only /stats, /recompute and /exclude call
   * this.
   */
  async function authorized(
    c: { req: { header(name: string): string | undefined; raw: Request } },
    decoded: DecodedConfig
  ): Promise<boolean> {
    const header = c.req.header("authorization");
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    const secret = match?.[1];
    const { statsKeyHash } = decoded.config;
    // A config without a stats key has no owner through the secret path:
    // nothing can match a hash that is not there. It can still have an
    // org owner via registration (keyless SDK tests), checked below.
    const bearerOk =
      secret && statsKeyHash
        ? await verifyStatsSecret(secret, statsKeyHash)
        : false;
    const provider = options.provider;
    if (!provider) {
      return bearerOk;
    }
    const policy = statsKeyHash ? await provider.keyPolicy(statsKeyHash) : null;
    if (policy) {
      const orgs = await provider.sessionOrgIds(c.req.raw);
      const orgOk = orgs.includes(policy.orgId);
      // A locked key must fail exactly like a wrong secret, or an old
      // secret becomes an oracle for "claimed and locked".
      return orgOk || (bearerOk && !policy.lockReads);
    }
    if (bearerOk) {
      return true;
    }
    // Keyless-but-registered tests: readable by the owning org, which is
    // the first time a config without a stats key is readable at all.
    const owner = await provider.testOrg(decoded.testId);
    if (!owner) {
      return false;
    }
    const orgs = await provider.sessionOrgIds(c.req.raw);
    return orgs.includes(owner);
  }

  app.get("/health", c => c.json({ ok: true }));

  if (options.assets) {
    app.route(
      "/",
      createAssetRoutes({
        ...options.assets,
        serveUrl: options.serveUrl,
        basePath
      })
    );
  }

  // Accounts (hosted only): the sub-app arrives ready-made so this
  // package never depends on an auth framework. Mounted before the tool
  // API so its /auth and /account prefixes are matched by their own
  // middleware and nothing else.
  if (options.accounts) {
    app.route("/", options.accounts);
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
  if (options.toolApi !== false) {
    app.route(
      "/",
      createApi({
        serveUrl: options.serveUrl,
        basePath,
        apiToken: options.apiToken,
        provider: options.provider,
        gtmId: options.gtmId,
        publishableKey: options.publishableKey,
        openaiAppsChallengeToken: options.openaiAppsChallengeToken,
        spaFetch: options.spaFetch,
        geo: resolveGeo,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          app.fetch(new Request(input as RequestInfo, init))) as typeof fetch
      })
    );
  }

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
    if (ctx.setCookie) {
      c.header("set-cookie", ctx.setCookie);
    }
    if (verdict === "interstitial" && variant.url && isNavigation(c)) {
      return withCookie(interstitialResponse(destination), ctx.setCookie);
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
    const requestedSlot = c.req.query("slot");
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
    // A multi-slot email wraps every element in ONE click link, so a
    // click needs no ?slot= when the destination cannot depend on the
    // slot anyway: an explicit ?to=, or a config-level redirectUrl with
    // no per-variant redirects. Only when variants carry their own
    // destinations does the click have to say which element was clicked.
    const entries = slotEntries(decoded.config);
    const uniformDestination =
      to ??
      (entries.every(([, variants]) =>
        variants.every(v => v.redirectUrl === undefined)
      )
        ? decoded.config.redirectUrl
        : undefined);
    let candidates: Array<string | undefined>;
    let pickTarget: (choice: number[]) => string | undefined;
    if (
      requestedSlot === undefined &&
      entries.length > 1 &&
      uniformDestination !== undefined
    ) {
      candidates = [uniformDestination];
      pickTarget = () => uniformDestination;
    } else {
      const slot = resolveSlot(decoded, requestedSlot);
      if ("error" in slot) {
        return slot.error;
      }
      candidates =
        to !== undefined
          ? [to]
          : slot.variants.map(v => v.redirectUrl ?? decoded.config.redirectUrl);
      pickTarget = choice =>
        to ??
        slot.variants[choice[slot.index]].redirectUrl ??
        decoded.config.redirectUrl;
    }
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
    const target = pickTarget(choice) as string;
    // Never reward an identity BORN on this request: a crawler or link
    // scanner presenting browser headers would otherwise mint a cookie
    // and count a conversion in one hit. A real first-time visitor
    // still gets their assignment and cookie here; their conversions
    // count from the next identified touch (pixel, tag, later click).
    if (identity.idHash && !ctx.setCookie) {
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
    if (ctx.setCookie) {
      c.header("set-cookie", ctx.setCookie);
    }
    if (verdict === "interstitial" && isNavigation(c)) {
      return withCookie(interstitialResponse(destination), ctx.setCookie);
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
      const preHashed = c.req.query("_lvid");
      const idHash = externalId
        ? await externalIdHash(decoded.testId, externalId)
        : preHashed && /^[0-9a-f]{64}$/.test(preHashed)
          ? preHashed
          : null;
      const amount = Number(c.req.query("amount") ?? "1");
      // Same bound as /reward: the pixel URL is public (it carries the raw
      // recipient id in emails), so an unbounded amount lets any recipient
      // or link-scanner drive rewardTotal to Infinity.
      if (
        idHash &&
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= MAX_REWARD_AMOUNT
      ) {
        await service.reward(
          decoded.testId,
          idHash,
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
    const { cell } = await service.assign(
      params,
      {
        idHash: r.idHash ?? null,
        ctxKey: await composeBucketKey(r.testId, r.ctxKey ?? null, autoCtx),
        featIdx: mergeFeatureIndices(r.featIdx ?? [0], autoCtx, r.dim),
        srcHash: await sourceHash(r.testId, clientIp(c), Date.now()),
        signals
      },
      { sdk: r.sdk }
    );
    const choice = decodeCell(r.slotSizes, cell);
    // First-sight registration, entirely off the response path: a
    // publishable key plus a verified page origin may register this
    // test to an org. The provider decides; serving never waits.
    if (r.publishableKey && options.provider?.registerFromSdk) {
      const registration = options.provider.registerFromSdk({
        testId: r.testId,
        encoded: r.encoded,
        region: r.region,
        publishableKey: r.publishableKey,
        origin: c.req.header("origin") ?? null
      });
      keepAlive(c, registration);
    }
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
    return c.json({
      cell,
      choice,
      assetSignatures,
      assetsExpireAt: expiresAt,
      // The deployment's version, so clients can adapt to older
      // self-hosted servers without a second request.
      server: SERVER_VERSION
    });
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
    const result = await service.reward(
      r.testId,
      r.idHash,
      r.amount,
      r.region,
      r.sdk
    );
    return c.json({
      rewarded: result !== null,
      first: result?.first ?? false,
      server: SERVER_VERSION
    });
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
      await service.stats(
        paramsFromConfig(decoded),
        labelsFromConfig(decoded),
        decoded.config.ctx?.dims
      )
    );
  });

  /**
   * Signed preview URLs for the config's own hosted assets, so a manage
   * page can SHOW image variants whose canonical /a/ URLs answer 403 on
   * their own. Authorization is exactly /stats: whoever may read the
   * results may see the creative. Foreign-hosted images need no signing
   * and are not listed; without an asset store the map is just empty.
   */
  app.get("/stats/:cfg/assets", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    if (!(await authorized(c, decoded))) {
      return c.json({ error: "stats secret required" }, 401);
    }
    const assets: Record<string, string> = {};
    if (options.assets) {
      for (const variants of Object.values(decoded.config.slots ?? {})) {
        for (const variant of variants) {
          const target = variant.image;
          if (!target || target in assets) {
            continue;
          }
          const id = ownAssetId(target, c.req.url);
          if (id) {
            assets[target] = await signAssetUrl(target, id, options.assets);
          }
        }
      }
    }
    return c.json({ assets });
  });

  /**
   * Live stats over Server-Sent Events: the full /stats payload as a
   * `stats` event immediately, then again whenever it changes, with a
   * `ping` between unchanged reads so proxies keep the connection.
   *
   * The event log is re-read each interval, which is the same cost the
   * refresh button had; the win is that the dashboard no longer chooses
   * between stale numbers and hammering refresh. The connection closes
   * itself after MAX_STREAM_TICKS reads (a dashboard reconnects
   * transparently), so an abandoned tab cannot hold a Worker forever.
   *
   * Authorization is the Bearer secret, same as /stats. EventSource
   * cannot send headers, so the dashboard consumes this with a streaming
   * fetch; the secret stays out of the URL either way (query params land
   * in access logs).
   */
  app.get("/stats/:cfg/stream", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    if (!(await authorized(c, decoded))) {
      return c.json({ error: "stats secret required" }, 401);
    }
    const interval = options.statsStreamIntervalMs ?? 5000;
    const params = paramsFromConfig(decoded);
    const labels = labelsFromConfig(decoded);
    const ctxDims = decoded.config.ctx?.dims;
    return streamSSE(c, async stream => {
      let sent = "";
      for (let tick = 0; tick < streamMaxTicks && !stream.aborted; tick++) {
        let payload: string;
        try {
          payload = JSON.stringify(
            await service.stats(params, labels, ctxDims)
          );
        } catch {
          // A transient backend failure must not kill the stream with a
          // half-written event; skip the tick and let the next one heal.
          await stream.sleep(interval);
          continue;
        }
        if (payload !== sent) {
          await stream.writeSSE({ event: "stats", data: payload });
          sent = payload;
        } else {
          await stream.writeSSE({ event: "ping", data: "" });
        }
        await stream.sleep(interval);
      }
    });
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

  // /manage/<cfg> is deliberately NOT here anymore: it is a dashboard
  // route (apps/web), served by the SPA fallback, so the stats page
  // exists exactly once. The URL shape and its #fragment secret are
  // unchanged for everyone holding an old link.

  /**
   * The SPA fallback, ours rather than the asset router's, because the
   * router's version answers EVERY miss with index.html at 200: a
   * crawler asking for /sitemap_index.xml, a browser asking for
   * /favicon.ico and an agent asking for /openapi.yaml each got a page
   * of HTML claiming success. That is a soft-404, and machines cannot
   * see through it.
   *
   * What separates "render the app" from "that file does not exist" is
   * NOT the shape of the path. We do not control the paths: people
   * configure and share their own links, and a rule like "no dots means
   * an app route" would 404 a real visitor the first time one of those
   * broke the pattern. The honest signal is the client's own: a
   * top-level navigation (`Sec-Fetch-Dest: document`, or an Accept that
   * asks for HTML) means a person is looking at a page, so serve the
   * shell and let the router decide. Anything else is a machine
   * fetching a resource, and a resource we did not serve above is a
   * genuine 404.
   *
   * Worst case for a crawler that claims to want HTML is exactly the
   * old behaviour, and a real browser can never be 404'd out of the
   * dashboard. Requires `not_found_handling: "none"` in wrangler.jsonc,
   * which is what routes asset misses here at all.
   */
  app.notFound(async c => {
    if (!isNavigation(c) || !options.spaFetch) {
      return c.text("not found", 404);
    }
    // The shell lives at "/", so ask for that rather than the route the
    // visitor typed, which the asset router does not have.
    const shell = new URL(c.req.url);
    shell.pathname = "/";
    shell.search = "";
    return options.spaFetch(new Request(shell, { headers: c.req.raw.headers }));
  });

  return app;
}
