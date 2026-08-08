import { Hono } from "hono";
import { cors } from "hono/cors";
import { sha256Hex, withQuery } from "@livevariant/core";
import { signAsset, verifyAssetSignature } from "./sign.js";
import type { AssetStore } from "./types.js";

/**
 * Image hosting, optional: these routes mount only when the deployment
 * configures a store and a signing secret.
 *
 * Uploads are content-addressed (the id IS the sha256 of the bytes), so
 * re-uploading is idempotent, nothing can be overwritten with different
 * content, and the served bytes are cacheable forever. Downloads exist
 * only through /a/<hash> with a fresh, short-lived signature that the
 * serve endpoint mints per redirect; the canonical URL alone answers 403.
 * That is deliberate: without it, /assets would be free anonymous static
 * hosting on the operator's domain.
 */

export interface AssetOptions {
  store: AssetStore;
  /** Keys the signatures. Rotating it invalidates in-flight URLs only. */
  signingSecret: string;
  /** Origin baked into returned asset URLs (the serving domain). */
  serveUrl?: string;
  /**
   * Path prefix the app is mounted under, appended to the request origin
   * when no serveUrl is set. See AppOptions.basePath.
   */
  basePath?: string;
  /**
   * Lifetime of a minted download URL. Default one hour: long enough for
   * a lazily-loaded image far down a page to still fetch, short enough
   * that a copied URL cannot serve as static hosting. A hotlinker would
   * have to re-mint hourly through a serve endpoint, which records an
   * assignment every time and stays visible.
   */
  urlTtlSeconds?: number;
  /** Upload cap. Default 10 MiB: email images should be far smaller. */
  maxBytes?: number;
  /**
   * Optional bearer token required on POST /assets. Unset means open
   * uploads, which matches the account-free product but hands strangers
   * a 10 MiB-per-request pipe into the operator's storage; an operator
   * who wants that door shut sets this and shares it with their own
   * uploaders. Serving is unaffected either way.
   */
  uploadToken?: string;
}

/**
 * Raster formats only. SVG is deliberately refused: it is a script
 * container, and serving attacker-uploaded SVG from our origin would be
 * stored XSS wearing an image's clothes.
 */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif"
]);

export const DEFAULT_ASSET_TTL_SECONDS = 3600;

export function createAssetRoutes(options: AssetOptions): Hono {
  const app = new Hono();
  const ttlSeconds = options.urlTtlSeconds ?? DEFAULT_ASSET_TTL_SECONDS;
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;

  // Uploads come from the dashboard (another origin) and from tools.
  app.use(
    "/assets",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type", "authorization"]
    })
  );

  app.post("/assets", async c => {
    if (options.uploadToken) {
      const header = c.req.header("authorization");
      if (header !== `Bearer ${options.uploadToken}`) {
        return c.json(
          { error: "this deployment requires an upload token" },
          401
        );
      }
    }
    const contentType =
      c.req.header("content-type")?.split(";")[0].trim() ?? "";
    if (!IMAGE_TYPES.has(contentType)) {
      return c.json(
        {
          error:
            `content-type "${contentType}" is not an accepted image type ` +
            `(${[...IMAGE_TYPES].join(", ")}; svg is refused because it can ` +
            "carry scripts)"
        },
        415
      );
    }
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > maxBytes) {
      return c.json({ error: `image exceeds ${maxBytes} bytes` }, 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) {
      return c.json({ error: "empty body" }, 400);
    }
    if (bytes.byteLength > maxBytes) {
      return c.json({ error: `image exceeds ${maxBytes} bytes` }, 413);
    }

    const assetId = await sha256Hex(bytes);
    await options.store.put(assetId, bytes, contentType);

    const origin = (
      options.serveUrl ?? new URL(c.req.url).origin + (options.basePath ?? "")
    ).replace(/\/+$/, "");
    const url = `${origin}/a/${assetId}`;
    // A human wants to eyeball what they just uploaded; an hour is plenty
    // and the preview link still dies.
    const previewUrl = withQuery(
      url,
      await signAsset(options.signingSecret, assetId, Date.now() + 3600_000)
    );
    return c.json(
      {
        assetId,
        url,
        previewUrl,
        size: bytes.byteLength,
        contentType
      },
      201
    );
  });

  app.get("/a/:id{[0-9a-f]{64}}", async c => {
    const assetId = c.req.param("id");
    const valid = await verifyAssetSignature(
      options.signingSecret,
      assetId,
      c.req.query("e"),
      c.req.query("s"),
      Date.now()
    );
    if (!valid) {
      // One message for missing, expired and forged alike: an unsigned
      // probe learns nothing about whether the asset exists.
      return c.json(
        { error: "this asset is only served through a test's serve URL" },
        403
      );
    }
    // A backend that pays for relayed bytes can hand out its own
    // presigned URL; the visitor already holds OUR valid signature, so
    // this widens nothing.
    if (options.store.redirectUrl) {
      const presigned = await options.store.redirectUrl(assetId, ttlSeconds);
      if (presigned) {
        c.header("cache-control", "no-store, private");
        return c.redirect(presigned, 302);
      }
    }
    const asset = await options.store.get(assetId);
    if (!asset) {
      return c.json({ error: "no such asset" }, 404);
    }
    return new Response(asset.body as BodyInit, {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.size),
        // Content-addressed: these bytes can never change under this URL.
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff"
      }
    });
  });

  return app;
}

/** Fresh signed URL for a target our serve endpoint is about to 302 to. */
export async function signAssetUrl(
  target: string,
  assetId: string,
  options: Pick<AssetOptions, "signingSecret" | "urlTtlSeconds">
): Promise<string> {
  const ttlMs = (options.urlTtlSeconds ?? DEFAULT_ASSET_TTL_SECONDS) * 1000;
  const query = await signAsset(
    options.signingSecret,
    assetId,
    Date.now() + ttlMs
  );
  return withQuery(target, query);
}
