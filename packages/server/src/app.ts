import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  capArmPriors,
  composeBucketKey,
  decodeConfig,
  decorateUrl,
  deriveAutoCtx,
  externalIdHash,
  isAssetFetch,
  mergeFeatureIndices,
  requestSignals,
  mulberry32,
  sourceHash,
  randomSeed,
  verifyStatsSecret,
  type CloudflareGeo,
  type DecodedConfig,
  type Rng
} from "@livevariant/core";
import {
  chooseRequestSchema,
  excludeRequestSchema,
  rewardRequestSchema,
  MAX_REWARD_AMOUNT
} from "./api-schemas.js";
import { renderManagePage } from "./manage-page.js";
import {
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
   * Hostnames redirects may send visitors to. Unset means allow-all,
   * which is right for self-hosters serving their own configs; the
   * hosted deployment sets it so livevariant.link can't be used as an
   * open redirector for phishing (anyone can author a config, so the
   * config's own origins are not a trust boundary).
   */
  allowedDestinations?: string[];
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
  app.use("/choose", openCors);
  app.use("/reward", openCors);
  app.use("/stats/*", openCors);
  app.use("/recompute/*", openCors);
  app.use("/exclude/*", openCors);

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
   * Operator allowlist: the only real anti-phishing control here, because
   * anyone can author a config, so a config's own origins prove nothing.
   * Unset means allow-all (correct for a self-host serving its own
   * campaigns); the hosted deployment sets it to protect the serving
   * domain's reputation. Matches a host or any of its subdomains.
   */
  const allowedHosts = (options.allowedDestinations ?? []).map(h =>
    h.toLowerCase().replace(/^\./, "")
  );
  function destinationAllowed(target: string): boolean {
    if (allowedHosts.length === 0) {
      return true;
    }
    let host: string;
    try {
      host = new URL(target).hostname.toLowerCase();
    } catch {
      return false;
    }
    return allowedHosts.some(
      allowed => host === allowed || host.endsWith(`.${allowed}`)
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
    const candidates = [config.redirectUrl];
    for (const arm of config.arms) {
      candidates.push(arm.formats.url, arm.formats.image, arm.redirectUrl);
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
        params: Awaited<ReturnType<typeof paramsFromConfig>>;
        identity: Awaited<ReturnType<typeof resolveIdentity>>;
      }
  > {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result;
    }
    const { decoded } = result;
    const params = await paramsFromConfig(decoded);
    // The config is authoritative: it defines the test's real shape, so
    // it overwrites anything a JS-mode caller pinned earlier.
    await service.checkShape(params, true);
    const externalId = c.req.query("id") ?? null;
    const identity = await resolveIdentity(
      decoded,
      externalId ? await externalIdHash(decoded.testId, externalId) : null,
      ctxFromQuery(c.req.query()),
      await sourceHash(decoded.testId, clientIp(c), Date.now()),
      requestContext(c)
    );
    return { decoded, params, identity };
  }

  /** Handoff decoration, shared by both redirect handlers. */
  function maybeDecorate(
    decoded: DecodedConfig,
    identity: { idHash: string | null },
    armIndex: number,
    target: string
  ): string {
    return decoded.config.decorateRedirects && identity.idHash
      ? decorateUrl(target, {
          testId: decoded.testId,
          idHash: identity.idHash,
          armIndex
        })
      : target;
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
    if (!secret) {
      return false;
    }
    return verifyStatsSecret(secret, decoded.config.statsKeyHash);
  }

  app.get("/health", c => c.json({ ok: true }));

  // Redirect-mode serve: 302 to the assigned arm's url/image.
  app.get("/s/:cfg", async c => {
    const ctx = await serveContext(c);
    if ("error" in ctx) {
      return ctx.error;
    }
    const { decoded, params, identity } = ctx;
    // EVERY arm must be servable and allowed before we record anything.
    // Checking only the chosen arm afterwards would sticky-assign a
    // visitor to an arm they can never be served, so every later visit
    // returns the same assignment and the same error.
    const unservable = decoded.config.arms.find(
      arm => !(arm.formats.url ?? arm.formats.image)
    );
    if (unservable) {
      return c.json(
        {
          error: `arm "${unservable.name}" has no url/image format for redirect serving`
        },
        400
      );
    }
    const disallowed = decoded.config.arms.find(
      arm => !destinationAllowed((arm.formats.url ?? arm.formats.image)!)
    );
    if (disallowed) {
      return c.json({ error: "destination not allowed by this server" }, 403);
    }
    const { armIndex } = await service.assign(params, identity);
    const arm = decoded.config.arms[armIndex];
    const target = (arm.formats.url ?? arm.formats.image) as string;
    // Handoff decoration applies to pages, not image assets.
    const decorated = arm.formats.url
      ? maybeDecorate(decoded, identity, armIndex, target)
      : target;
    c.header("cache-control", NO_STORE);
    return c.redirect(decorated, 302);
  });

  // Click: rewards (id'd traffic) and redirects onward.
  app.get("/c/:cfg", async c => {
    const ctx = await serveContext(c);
    if ("error" in ctx) {
      return ctx.error;
    }
    const { decoded, params, identity } = ctx;
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
        : decoded.config.arms.map(
            arm => arm.redirectUrl ?? decoded.config.redirectUrl
          );
    if (candidates.some(target => target === undefined)) {
      return c.json(
        { error: "no redirect target: pass ?to= or set a redirectUrl" },
        400
      );
    }
    if (!candidates.every(target => destinationAllowed(target as string))) {
      return c.json({ error: "destination not allowed by this server" }, 403);
    }
    // A click implies a serve, so assign (sticky or fresh) before rewarding.
    const { armIndex } = await service.assign(params, identity);
    const arm = decoded.config.arms[armIndex];
    const target = (to ??
      arm.redirectUrl ??
      decoded.config.redirectUrl) as string;
    if (identity.idHash) {
      await service.reward(decoded.testId, identity.idHash, 1);
    }
    c.header("cache-control", NO_STORE);
    return c.redirect(maybeDecorate(decoded, identity, armIndex, target), 302);
  });

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
          amount
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
    // The caller supplies both the priors and their cap, so the cap can't
    // be trusted to bound them: clamp to the server's own ceiling, which
    // is what keeps a hostile prior from pinning an arm (linear priors are
    // baked into persisted state on first write).
    const cap = Math.min(r.priorStrengthCap ?? 50, MAX_PRIOR_STRENGTH);
    const params: ServingParams = {
      testId: r.testId,
      armCount: r.armCount,
      alg: r.alg,
      dim: r.dim ?? 16,
      minBucketPulls: r.minBucketPulls ?? 100,
      armPriors: r.armPriors ? capArmPriors(r.armPriors, cap) : undefined,
      bucketPriors: r.bucketPriors
        ? Object.fromEntries(
            Object.entries(r.bucketPriors).map(([k, p]) => [
              k,
              capArmPriors(p, cap)
            ])
          )
        : undefined,
      linearPriors: r.linearPriors?.map(p => ({
        mean: p.mean,
        strength: Math.min(p.strength, cap)
      })),
      noise: r.noise
    };
    if (!(await service.checkShape(params, false))) {
      return c.json(
        { error: "armCount/alg/dim disagree with this test's serving shape" },
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
    const { armIndex } = await service.assign(params, {
      idHash: r.idHash ?? null,
      ctxKey: await composeBucketKey(r.testId, r.ctxKey ?? null, autoCtx),
      featIdx: mergeFeatureIndices(r.featIdx ?? [0], autoCtx, r.dim ?? 16),
      srcHash: await sourceHash(r.testId, clientIp(c), Date.now()),
      signals
    });
    return c.json({ armIndex });
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
    const result = await service.reward(r.testId, r.idHash, r.amount);
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
    const params = await paramsFromConfig(decoded);
    return c.json(
      await service.stats(
        params,
        decoded.config.arms.map(a => a.name)
      )
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
    const params = await paramsFromConfig(decoded);
    const events = await service.recompute(params);
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
    const policy = await service.updatePolicy(decoded.testId, {
      excludedSources: body.data.sources,
      excludedWindows: body.data.windows
    });
    const params = await paramsFromConfig(decoded);
    const events = await service.recompute(params);
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
