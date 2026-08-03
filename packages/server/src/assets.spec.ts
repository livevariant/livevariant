import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  encodeConfig,
  hashStatsSecret,
  mulberry32,
  withQuery,
  type TestConfigInput
} from "@livevariant/core";
import { createApp } from "./app.js";
import { signAsset, verifyAssetSignature } from "./assets/sign.js";
import { MemoryAssetStore } from "./assets/types.js";
import { MemoryStore } from "./store/memory.js";

/**
 * Image hosting end to end: upload, protection, serve-time signing, and
 * the /choose extension the SDK uses. The store is the in-memory
 * reference; R2 differs only in where bytes sleep.
 */
const SECRET = "asset-signing-secret";
const STATS_SECRET = "stats-secret";

/** A real PNG header plus noise, so uploads look like an actual file. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8
]);

let app: Hono;
let store: MemoryAssetStore;

beforeEach(() => {
  store = new MemoryAssetStore();
  app = createApp({
    store: new MemoryStore(),
    rng: mulberry32(42),
    assets: { store, signingSecret: SECRET }
  });
});

async function upload(
  bytes: Uint8Array = PNG,
  contentType = "image/png"
): Promise<{ assetId: string; url: string; previewUrl: string }> {
  const res = await app.request("https://livevariant.com/assets", {
    method: "POST",
    headers: { "content-type": contentType },
    body: bytes
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe("signatures", () => {
  it("round-trips and refuses tampering and expiry", async () => {
    const id = "a".repeat(64);
    const query = await signAsset(SECRET, id, Date.now() + 60_000);
    const params = new URLSearchParams(query);
    const e = params.get("e")!;
    const s = params.get("s")!;
    expect(await verifyAssetSignature(SECRET, id, e, s, Date.now())).toBe(true);
    // Wrong asset, wrong secret, doctored expiry, expired clock: all dead.
    expect(
      await verifyAssetSignature(SECRET, "b".repeat(64), e, s, Date.now())
    ).toBe(false);
    expect(await verifyAssetSignature("other", id, e, s, Date.now())).toBe(
      false
    );
    expect(
      await verifyAssetSignature(
        SECRET,
        id,
        String(Number(e) + 9999),
        s,
        Date.now()
      )
    ).toBe(false);
    expect(
      await verifyAssetSignature(SECRET, id, e, s, (Number(e) + 1) * 1000)
    ).toBe(false);
  });
});

describe("upload and protected serving", () => {
  it("stores content-addressed and serves only with a signature", async () => {
    const { assetId, url, previewUrl } = await upload();
    expect(assetId).toMatch(/^[0-9a-f]{64}$/);
    expect(url.endsWith(`/a/${assetId}`)).toBe(true);

    // The canonical URL is useless on its own: that is the entire
    // anti-hotlinking design.
    const bare = await app.request(url);
    expect(bare.status).toBe(403);

    const preview = await app.request(previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(preview.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(PNG);
  });

  it("is idempotent: same bytes, same id", async () => {
    const first = await upload();
    const second = await upload();
    expect(second.assetId).toBe(first.assetId);
  });

  it("refuses non-image and oversized uploads", async () => {
    const svg = await app.request("https://livevariant.com/assets", {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: "<svg onload=alert(1)/>"
    });
    // SVG is a script container; serving it from our origin would be
    // stored XSS wearing an image's clothes.
    expect(svg.status).toBe(415);

    const tiny = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      assets: { store, signingSecret: SECRET, maxBytes: 8 }
    });
    const big = await tiny.request("https://livevariant.com/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    expect(big.status).toBe(413);
  });

  it("does not exist at all on a deployment without asset hosting", async () => {
    const plain = createApp({ store: new MemoryStore(), rng: mulberry32(1) });
    expect(
      (
        await plain.request("https://livevariant.com/assets", {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: PNG
        })
      ).status
    ).toBe(404);
    expect(
      (await plain.request(`https://livevariant.com/a/${"a".repeat(64)}`))
        .status
    ).toBe(404);
  });

  it("redirects instead of streaming when the store presigns", async () => {
    // The escape hatch for backends where relaying bytes costs money:
    // the visitor already carries OUR signature, so handing them the
    // backend's own URL widens nothing.
    store.redirectUrl = async id => `https://cdn.example.com/${id}`;
    const { assetId, previewUrl } = await upload();
    const res = await app.request(previewUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `https://cdn.example.com/${assetId}`
    );
    delete store.redirectUrl;
  });
});

describe("serve-time signing", () => {
  async function assetTest(url: string) {
    const config: TestConfigInput = {
      v: 1,
      arms: [
        { name: "hosted", formats: { image: url } },
        { name: "hostedToo", formats: { image: url } }
      ],
      statsKeyHash: await hashStatsSecret(STATS_SECRET),
      decorateRedirects: false
    };
    return encodeConfig(config);
  }

  it("mints a working URL on redirect, and only there", async () => {
    const { url } = await upload();
    const { encoded } = await assetTest(url);
    const serve = await app.request(
      `https://livevariant.com/s/${encoded}?id=r1`,
      { headers: { accept: "text/html" } }
    );
    expect(serve.status).toBe(302);
    const location = serve.headers.get("location")!;
    expect(location.startsWith(`${url}?`)).toBe(true);

    // The Location works, once followed...
    expect((await app.request(location)).status).toBe(200);
    // ...and the same URL with its signature stripped does not.
    expect((await app.request(url)).status).toBe(403);
  });

  it("ignores the operator destination allowlist for hosted assets", async () => {
    // The allowlist is an anti-phishing control on OUTBOUND redirects;
    // hosted assets never leave this deployment.
    const { url } = await upload();
    const { encoded } = await assetTest(url);
    const locked = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      allowedDestinations: ["customer.example"],
      assets: { store, signingSecret: SECRET }
    });
    const res = await locked.request(
      `https://livevariant.com/s/${encoded}?id=r1`,
      { headers: { accept: "text/html" } }
    );
    expect(res.status).toBe(302);
  });
});

describe("asset-path spoofing (the allowlist bypass that was)", () => {
  const SPOOF = `https://evil.example/a/${"f".repeat(64)}`;

  async function spoofTest() {
    return encodeConfig({
      v: 1,
      arms: [
        { name: "a", formats: { url: SPOOF } },
        { name: "b", formats: { url: SPOOF } }
      ],
      statsKeyHash: await hashStatsSecret(STATS_SECRET),
      decorateRedirects: false
    });
  }

  it("a foreign URL shaped like an asset does not bypass the allowlist", async () => {
    // The path alone is spoofable: /a/<64hex> on evil.example matched the
    // asset shape and sailed through LV_ALLOWED_DESTINATIONS, an open
    // redirect through the exact control meant to prevent one. Ours means
    // path AND host now.
    const { encoded } = await spoofTest();
    const locked = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      allowedDestinations: ["customer.example"],
      assets: { store, signingSecret: SECRET }
    });
    const res = await locked.request(
      `https://livevariant.com/s/${encoded}?id=r1`,
      { headers: { accept: "text/html" } }
    );
    expect(res.status).toBe(403);
  });

  it("never signs a foreign URL either", async () => {
    // Even on an allow-all deployment, our signature belongs only on our
    // own asset URLs; stamping it onto a foreign host's URL would leak a
    // valid signature for that hash to whoever controls the host.
    const { encoded } = await spoofTest();
    const res = await app.request(
      `https://livevariant.com/s/${encoded}?id=r1`,
      { headers: { accept: "text/html" } }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SPOOF);
  });

  it("still recognizes its own asset on the serving domain", async () => {
    // The serve URL lives on the serving domain while the dashboard
    // domain answers the request; both hosts are "ours".
    const withServeUrl = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      serveUrl: "https://livevariant.link",
      allowedDestinations: ["customer.example"],
      assets: { store, signingSecret: SECRET }
    });
    const up = await withServeUrl.request("https://livevariant.com/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    const { url } = (await up.json()) as { url: string };
    expect(url.startsWith("https://livevariant.link/a/")).toBe(true);
    const { encoded } = await encodeConfig({
      v: 1,
      arms: [
        { name: "a", formats: { image: url } },
        { name: "b", formats: { image: url } }
      ],
      statsKeyHash: await hashStatsSecret(STATS_SECRET)
    });
    const res = await withServeUrl.request(
      `https://livevariant.com/s/${encoded}?id=r1`,
      { headers: { accept: "text/html" } }
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("&s=");
  });
});

describe("upload token", () => {
  it("gates uploads when set, and only uploads", async () => {
    const gated = createApp({
      store: new MemoryStore(),
      rng: mulberry32(7),
      assets: { store, signingSecret: SECRET, uploadToken: "sesame" }
    });
    const anonymous = await gated.request("https://livevariant.com/assets", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: PNG
    });
    expect(anonymous.status).toBe(401);

    const authed = await gated.request("https://livevariant.com/assets", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        authorization: "Bearer sesame"
      },
      body: PNG
    });
    expect(authed.status).toBe(201);
    // Serving stays open: signatures, not tokens, protect downloads.
    const { previewUrl } = (await authed.json()) as { previewUrl: string };
    expect((await gated.request(previewUrl)).status).toBe(200);
  });
});

describe("/choose asset signatures (the SDK contract)", () => {
  async function choose(body: Record<string, unknown>) {
    const res = await app.request("https://livevariant.com/choose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        testId: "c".repeat(64),
        armCount: 2,
        alg: "ts",
        idHash: "d".repeat(64),
        ...body
      })
    });
    return { status: res.status, body: await res.json() };
  }

  it("signs the winning arm's assets and no others", async () => {
    const { assetId, url } = await upload();
    const other = "e".repeat(64);
    const { status, body } = await choose({
      assets: { "0": [assetId], "1": [other] }
    });
    expect(status).toBe(200);
    const out = body as {
      armIndex: number;
      assetSignatures: Record<string, string>;
      assetsExpireAt: number;
    };
    const winners = Object.keys(out.assetSignatures);
    // Exactly the chosen arm's hashes were signed: minting is scoped.
    expect(winners).toEqual(out.armIndex === 0 ? [assetId] : [other]);
    expect(out.assetsExpireAt).toBeGreaterThan(Date.now());

    // And a signature actually opens the asset, spliced the way the SDK
    // splices it.
    if (out.armIndex === 0) {
      const fetched = await app.request(
        withQuery(url, out.assetSignatures[assetId])
      );
      expect(fetched.status).toBe(200);
    }
  });

  it("returns no signature block when the caller sent no assets", async () => {
    const { body } = await choose({});
    expect(body).toEqual({ armIndex: expect.any(Number) });
  });

  it("rejects asset entries outside the arm count", async () => {
    const { status } = await choose({ assets: { "9": ["f".repeat(64)] } });
    expect(status).toBe(400);
  });

  it("omits signatures entirely when assets are not configured", async () => {
    const plain = createApp({ store: new MemoryStore(), rng: mulberry32(1) });
    const res = await plain.request("https://livevariant.com/choose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        testId: "c".repeat(64),
        armCount: 2,
        alg: "ts",
        assets: { "0": ["a".repeat(64)] }
      })
    });
    expect(await res.json()).toEqual({ armIndex: expect.any(Number) });
  });
});
