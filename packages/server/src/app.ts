import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  capArmPriors,
  decodeConfig,
  decorateUrl,
  externalIdHash,
  mulberry32,
  randomSeed,
  verifyStatsSecret,
  type DecodedConfig,
  type Rng
} from "@livevariant/core";
import { chooseRequestSchema, rewardRequestSchema } from "./api-schemas.js";
import { renderManagePage } from "./manage-page.js";
import {
  buildStats,
  paramsFromConfig,
  resolveIdentity,
  TestService,
  type ServingParams
} from "./service.js";
import type { StateStore } from "./store/types.js";

export interface AppOptions {
  store: StateStore;
  /** Injectable for deterministic tests; defaults to a random seed. */
  rng?: Rng;
}

/** 1x1 transparent GIF for the no-JS conversion pixel. */
const PIXEL_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  c => c.charCodeAt(0)
);

export function createApp(options: AppOptions): Hono {
  const service = new TestService(
    options.store,
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
   * Click ?to= must land on an origin the config itself names. The click
   * URL is public (it lives in every email), so an unvalidated ?to= would
   * turn the serving domain into an open redirector for phishing; origins
   * are creator-controlled because the config is hash-bound.
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
    const secret = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (!secret) {
      return false;
    }
    return verifyStatsSecret(secret, decoded.config.statsKeyHash);
  }

  app.get("/health", c => c.json({ ok: true }));

  // Redirect-mode serve: 302 to the assigned arm's url/image.
  app.get("/s/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    const params = await paramsFromConfig(decoded);
    const externalId = c.req.query("id") ?? null;
    const identity = await resolveIdentity(
      decoded,
      externalId ? await externalIdHash(decoded.testId, externalId) : null,
      ctxFromQuery(c.req.query())
    );
    const { armIndex } = await service.assign(params, identity);
    const arm = decoded.config.arms[armIndex];
    const target = arm.formats.url ?? arm.formats.image;
    if (!target) {
      return c.json(
        {
          error: `arm "${arm.name}" has no url/image format for redirect serving`
        },
        400
      );
    }
    // Identity handoff: decorate page destinations (not image assets) so
    // an SDK on the destination site can adopt this assignment.
    const decorated =
      decoded.config.decorateRedirects && identity.idHash && arm.formats.url
        ? decorateUrl(target, {
            testId: decoded.testId,
            idHash: identity.idHash,
            armIndex
          })
        : target;
    return c.redirect(decorated, 302);
  });

  // Click: rewards (id'd traffic) and redirects onward.
  app.get("/c/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if ("error" in result) {
      return result.error;
    }
    const { decoded } = result;
    const params = await paramsFromConfig(decoded);
    const externalId = c.req.query("id") ?? null;
    const identity = await resolveIdentity(
      decoded,
      externalId ? await externalIdHash(decoded.testId, externalId) : null,
      ctxFromQuery(c.req.query())
    );
    // A click implies a serve, so assign (sticky or fresh) before rewarding.
    const { armIndex } = await service.assign(params, identity);
    if (identity.idHash) {
      await service.reward(decoded.testId, identity.idHash, 1);
    }
    const arm = decoded.config.arms[armIndex];
    const to = c.req.query("to");
    if (to !== undefined && !isAllowedRedirect(decoded.config, to)) {
      return c.json(
        { error: "?to= must be on an origin the test config references" },
        400
      );
    }
    const target = to ?? arm.redirectUrl ?? decoded.config.redirectUrl;
    if (!target) {
      return c.json(
        { error: "no redirect target: pass ?to= or set a redirectUrl" },
        400
      );
    }
    const decorated =
      decoded.config.decorateRedirects && identity.idHash
        ? decorateUrl(target, {
            testId: decoded.testId,
            idHash: identity.idHash,
            armIndex
          })
        : target;
    return c.redirect(decorated, 302);
  });

  // No-JS conversion pixel for thank-you pages.
  app.get("/px/:cfg", async c => {
    const result = await decodeOr404(c.req.param("cfg"));
    if (!("error" in result)) {
      const { decoded } = result;
      const externalId = c.req.query("id");
      const amount = Number(c.req.query("amount") ?? "1");
      if (externalId && Number.isFinite(amount) && amount > 0) {
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
      return c.json({ error: body.error.issues }, 400);
    }
    const r = body.data;
    const cap = r.priorStrengthCap ?? 50;
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
    const { armIndex } = await service.assign(params, {
      idHash: r.idHash ?? null,
      ctxKey: r.ctxKey ?? null,
      featIdx: r.featIdx ?? [0]
    });
    return c.json({ armIndex });
  });

  app.post("/reward", async c => {
    const body = rewardRequestSchema.safeParse(
      await c.req.json().catch(() => null)
    );
    if (!body.success) {
      return c.json({ error: body.error.issues }, 400);
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
    const stats = await buildStats(
      options.store,
      params,
      decoded.config.arms.map(a => a.name)
    );
    return c.json(stats);
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
