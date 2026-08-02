import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  bucketKey,
  configFromParams,
  encodeConfig,
  featureIndices,
  FEATURE_DIM,
  externalIdHash,
  hashStatsSecret,
  mulberry32,
  type TestConfigInput
} from "@livevariant/core";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";

/**
 * End-to-end tests over the HTTP surface with the memory store: the same
 * flows the plan's verification section names, driven through app.request.
 */

const SECRET = "test-stats-secret";

/** What a browser sends when a person clicks a link. */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,image/webp,*/*;q=0.8";

/** Deterministic 64-hex id for tests that mint many visitors. */
function hex(seed: string): string {
  let h = 0;
  for (const ch of seed) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h.toString(16).padStart(8, "0").repeat(8);
}

async function makeTest(overrides: Partial<TestConfigInput> = {}) {
  const config: TestConfigInput = {
    v: 1,
    name: "landing page test",
    arms: [
      {
        name: "control",
        formats: { url: "https://example.com/a" },
        redirectUrl: "https://example.com/thanks-a"
      },
      { name: "variant", formats: { url: "https://example.com/b" } }
    ],
    redirectUrl: "https://example.com/thanks",
    statsKeyHash: await hashStatsSecret(SECRET),
    ...overrides
  };
  const { encoded, testId } = await encodeConfig(config);
  return { config, encoded, testId };
}

let store: MemoryStore;
let app: Hono;

beforeEach(() => {
  store = new MemoryStore();
  app = createApp({ store, rng: mulberry32(42) });
});

async function stats(encoded: string): Promise<any> {
  const res = await app.request(`/stats/${encoded}`, {
    headers: { authorization: `Bearer ${SECRET}` }
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("redirect serving", () => {
  it("302s to an arm url with handoff decoration for id'd traffic", async () => {
    const { encoded, testId } = await makeTest();
    const res = await app.request(`/s/${encoded}?id=user1`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toMatch(
      /^https:\/\/example\.com\/(a|b)$/
    );
    expect(location.searchParams.get("_lvt")).toBe(testId);
    expect(location.searchParams.get("_lvid")).toMatch(/^[0-9a-f]{64}$/);
    expect(["0", "1"]).toContain(location.searchParams.get("_lvvar"));
  });

  it("leaves anonymous and opted-out redirects undecorated", async () => {
    const { encoded } = await makeTest();
    const anon = await app.request(`/s/${encoded}`);
    expect(anon.headers.get("location")).toMatch(
      /^https:\/\/example\.com\/(a|b)$/
    );
    const optedOut = await makeTest({ decorateRedirects: false });
    const res = await app.request(`/s/${optedOut.encoded}?id=user1`);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/example\.com\/(a|b)$/
    );
  });

  it("keeps assignment sticky per id (repeat email opens)", async () => {
    const { encoded } = await makeTest();
    const first = await app.request(`/s/${encoded}?id=recipient@x`);
    const target = first.headers.get("location");
    for (let open = 0; open < 5; open++) {
      const res = await app.request(`/s/${encoded}?id=recipient@x`);
      expect(res.headers.get("location")).toBe(target);
    }
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(1); // six opens, one assignment
  });

  it("records nothing for anonymous serves", async () => {
    const { encoded } = await makeTest();
    await app.request(`/s/${encoded}`);
    await app.request(`/s/${encoded}`);
    expect((await stats(encoded)).totalAssignments).toBe(0);
  });

  it("404s on a tampered config", async () => {
    const { encoded } = await makeTest();
    const res = await app.request(`/s/${encoded}xyz`);
    expect(res.status).toBe(404);
  });
});

describe("click and reward", () => {
  it("redirects with precedence to > arm.redirectUrl > config.redirectUrl", async () => {
    const { encoded } = await makeTest();
    // Pin the arm via stickiness so the assertion is deterministic.
    const serve = await app.request(`/s/${encoded}?id=u1`);
    const armIndex =
      serve.headers.get("location") === "https://example.com/a" ? 0 : 1;

    const explicit = await app.request(
      `/c/${encoded}?id=u1&to=${encodeURIComponent("https://example.com/custom")}`
    );
    const explicitUrl = new URL(explicit.headers.get("location")!);
    expect(explicitUrl.origin + explicitUrl.pathname).toBe(
      "https://example.com/custom"
    );
    // Click redirects carry the handoff too, so on-site conversions after
    // a click attribute correctly.
    expect(explicitUrl.searchParams.get("_lvid")).toMatch(/^[0-9a-f]{64}$/);

    const fallback = await app.request(`/c/${encoded}?id=u1`);
    const fallbackUrl = new URL(fallback.headers.get("location")!);
    expect(fallbackUrl.origin + fallbackUrl.pathname).toBe(
      armIndex === 0
        ? "https://example.com/thanks-a" // arm-level override
        : "https://example.com/thanks" // config-level fallback
    );
  });

  it("rejects ?to= redirects to origins the config does not reference", async () => {
    const { encoded } = await makeTest();
    const res = await app.request(
      `/c/${encoded}?id=u9&to=${encodeURIComponent("https://evil.example/phish")}`
    );
    expect(res.status).toBe(400);
    // Same-origin as a configured arm URL is allowed.
    const ok = await app.request(
      `/c/${encoded}?id=u9&to=${encodeURIComponent("https://example.com/other-page")}`
    );
    expect(ok.headers.get("location")).toMatch(
      /^https:\/\/example\.com\/other-page\?_lvt=/
    );
  });

  it("rewards a click once per id in derived stats", async () => {
    const { encoded } = await makeTest();
    await app.request(`/s/${encoded}?id=u1`);
    await app.request(`/c/${encoded}?id=u1`);
    await app.request(`/c/${encoded}?id=u1`);
    const s = await stats(encoded);
    const conversions = s.arms.reduce(
      (sum: number, a: any) => sum + a.conversions,
      0
    );
    expect(conversions).toBe(1);
    const rewardTotal = s.arms.reduce(
      (sum: number, a: any) => sum + a.rewardTotal,
      0
    );
    expect(rewardTotal).toBe(2); // both clicks accumulate on the record
  });
});

describe("handoff (email -> landing page -> SDK reward flow)", () => {
  it("rewards via the idHash handed off in the redirect URL", async () => {
    const { encoded, testId } = await makeTest();
    // Serve: recipient r1 is redirected with _lvid decoration.
    const serve = await app.request(`/s/${encoded}?id=r1`);
    const idHash = new URL(serve.headers.get("location")!).searchParams.get(
      "_lvid"
    )!;
    // The SDK on the destination site later rewards with ONLY the token
    // contents: no algorithm params, no config.
    const reward = await app.request("/reward", {
      method: "POST",
      body: JSON.stringify({ testId, idHash, amount: 5 }),
      headers: { "content-type": "application/json" }
    });
    expect(await reward.json()).toEqual({ rewarded: true, first: true });
    const s = await stats(encoded);
    expect(s.arms.reduce((sum: number, a: any) => sum + a.rewardTotal, 0)).toBe(
      5
    );
  });
});

describe("conversion pixel (email -> landing page flow)", () => {
  it("closes the loop without any SDK", async () => {
    const { encoded } = await makeTest();
    // Email open: serve assigns recipient r1 to a landing page.
    await app.request(`/s/${encoded}?id=r1`);
    // Thank-you page: pixel reports the conversion, id via URL param.
    const px = await app.request(`/px/${encoded}?id=r1&amount=3`);
    expect(px.status).toBe(200);
    expect(px.headers.get("content-type")).toBe("image/gif");
    const s = await stats(encoded);
    expect(s.arms.reduce((sum: number, a: any) => sum + a.conversions, 0)).toBe(
      1
    );
    expect(s.arms.reduce((sum: number, a: any) => sum + a.rewardTotal, 0)).toBe(
      3
    );
  });

  it("never errors toward the embedding page", async () => {
    const res = await app.request(`/px/garbage?id=x`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
  });

  it("ignores out-of-range pixel amounts", async () => {
    const { encoded } = await makeTest();
    await app.request(`/s/${encoded}?id=r1`);
    // The pixel URL is public and carries the raw recipient id, so an
    // unbounded amount would let anyone drive rewardTotal to Infinity.
    for (const amount of ["1e308", "-5", "NaN", "2000000"]) {
      await app.request(`/px/${encoded}?id=r1&amount=${amount}`);
    }
    const s = await stats(encoded);
    expect(s.arms.reduce((sum: number, a: any) => sum + a.rewardTotal, 0)).toBe(
      0
    );
  });

  it("drops pixel rewards for ids that were never served", async () => {
    const { encoded } = await makeTest();
    await app.request(`/px/${encoded}?id=stranger`);
    expect((await stats(encoded)).totalAssignments).toBe(0);
  });
});

describe("JS mode (choose/reward)", () => {
  it("assigns sticky by idHash and rewards first-only", async () => {
    const { testId } = await makeTest();
    const idHash = await externalIdHash(testId, "sdk-user");
    const body = { testId, armCount: 2, alg: "ts" as const, idHash };

    const chosen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/choose", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" }
      });
      expect(res.status).toBe(200);
      chosen.push((await res.json()).armIndex);
    }
    expect(new Set(chosen).size).toBe(1);

    const r1 = await app.request("/reward", {
      method: "POST",
      body: JSON.stringify({ ...body, amount: 2 }),
      headers: { "content-type": "application/json" }
    });
    expect(await r1.json()).toEqual({ rewarded: true, first: true });
    const r2 = await app.request("/reward", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    });
    expect(await r2.json()).toEqual({ rewarded: true, first: false });
  });

  it("validates request bodies", async () => {
    const res = await app.request("/choose", {
      method: "POST",
      body: JSON.stringify({ testId: "short", armCount: 2, alg: "ts" }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects feature indices outside the model dimension", async () => {
    const { testId } = await makeTest();
    // dim 16 with index 63 would read past the matrix and write NaN into
    // the linear model.
    const res = await app.request("/choose", {
      method: "POST",
      body: JSON.stringify({
        testId,
        armCount: 2,
        alg: "linear",
        dim: 16,
        featIdx: [0, 63]
      }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects bucket prior arrays that disagree with armCount", async () => {
    const { testId } = await makeTest();
    // A short bucket array would leave arms 1..n on the uniform prior
    // while arm 0 keeps a strong one, and bucket keys are derivable by
    // anyone who can see a serve URL.
    const res = await app.request("/choose", {
      method: "POST",
      body: JSON.stringify({
        testId,
        armCount: 2,
        alg: "bucketed",
        bucketPriors: { ["a".repeat(64)]: [{ alpha: 20, beta: 1 }] }
      }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects prior arrays that disagree with armCount", async () => {
    const { testId } = await makeTest();
    const res = await app.request("/choose", {
      method: "POST",
      body: JSON.stringify({
        testId,
        armCount: 2,
        alg: "ts",
        armPriors: [{ alpha: 1, beta: 1 }]
      }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(400);
  });

  it("rejects reward amounts beyond the cap", async () => {
    const { testId } = await makeTest();
    const idHash = await externalIdHash(testId, "u1");
    const res = await app.request("/reward", {
      method: "POST",
      body: JSON.stringify({ testId, idHash, amount: 1e12 }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(400);
  });
});

describe("cors", () => {
  it("preflights and allows browser calls on SDK and stats endpoints", async () => {
    const { encoded } = await makeTest();
    const preflight = await app.request("/choose", {
      method: "OPTIONS",
      headers: {
        origin: "https://customer-site.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(
      /content-type/i
    );
    const stats = await app.request(`/stats/${encoded}`, {
      headers: {
        origin: "https://livevariant.com",
        authorization: `Bearer ${SECRET}`
      }
    });
    expect(stats.status).toBe(200);
    expect(stats.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("destination allowlist", () => {
  const allowed = { allowedDestinations: ["example.com"] };

  it("refuses a config whose arms leave the allowlist, without recording", async () => {
    const gated = createApp({
      store: new MemoryStore(),
      rng: mulberry32(3),
      ...allowed
    });
    const { encoded } = await makeTest({
      arms: [
        { name: "ok", formats: { url: "https://example.com/a" } },
        { name: "offsite", formats: { url: "https://elsewhere.test/b" } }
      ]
    });
    // Twice: a sticky assignment made before the check would pin this
    // visitor to an arm they could never be served.
    for (let i = 0; i < 2; i++) {
      const res = await gated.request(`/s/${encoded}?id=u1`);
      expect(res.status).toBe(403);
    }
    const s = await gated.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect((await s.json()).totalAssignments).toBe(0);
  });

  it("serves normally when every destination is on the allowlist", async () => {
    const gated = createApp({
      store: new MemoryStore(),
      rng: mulberry32(3),
      ...allowed
    });
    const { encoded } = await makeTest();
    const res = await gated.request(`/s/${encoded}?id=u1`);
    expect(res.status).toBe(302);
    // Subdomains of an allowed host count too.
    const sub = await makeTest({
      arms: [
        { name: "a", formats: { url: "https://cdn.example.com/a" } },
        { name: "b", formats: { url: "https://example.com/b" } }
      ]
    });
    expect((await gated.request(`/s/${sub.encoded}?id=u2`)).status).toBe(302);
  });

  it("blocks a disallowed click target before counting the conversion", async () => {
    const gated = createApp({
      store: new MemoryStore(),
      rng: mulberry32(3),
      ...allowed
    });
    const { encoded } = await makeTest({
      redirectUrl: "https://elsewhere.test/thanks",
      arms: [
        { name: "a", formats: { url: "https://example.com/a" } },
        { name: "b", formats: { url: "https://example.com/b" } }
      ]
    });
    expect((await gated.request(`/c/${encoded}?id=u1`)).status).toBe(403);
    const s = await gated.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect((await s.json()).totalAssignments).toBe(0);
  });
});

describe("source visibility and creator quarantine", () => {
  /** One /choose from a given client address. */
  async function choose(testId: string, idHash: string, ip: string) {
    return app.request("/choose", {
      method: "POST",
      body: JSON.stringify({ testId, armCount: 2, alg: "ts", idHash }),
      headers: { "content-type": "application/json", "cf-connecting-ip": ip }
    });
  }

  it("records every visitor, however concentrated the source", async () => {
    const { encoded, testId } = await makeTest();
    // A mail provider fetching an email image proxies every open through
    // its own infrastructure, so a real campaign's records legitimately
    // share one prefix. Nothing is ever dropped automatically.
    for (let i = 0; i < 120; i++) {
      await choose(testId, hex(`proxied${i}`), "203.0.113.9");
    }
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(120);
    expect(s.excluded.total).toBe(0);
  });

  it("reports a per-source breakdown so the creator can see the flood", async () => {
    const { encoded, testId } = await makeTest();
    for (let i = 0; i < 5; i++) {
      await choose(testId, hex(`a${i}`), "198.51.100.1");
    }
    await choose(testId, hex("b"), "203.0.113.1");
    const s = await stats(encoded);
    const counts = Object.values(s.perSource).sort(
      (x: any, y: any) => y - x
    ) as number[];
    expect(counts).toEqual([5, 1]);
  });

  it("quarantines a source and heals history on recompute", async () => {
    const { encoded, testId } = await makeTest();
    for (let i = 0; i < 3; i++) {
      await choose(testId, hex(`good${i}`), "198.51.100.5");
    }
    for (let i = 0; i < 4; i++) {
      await choose(testId, hex(`bad${i}`), "203.0.113.5");
    }
    const before = await stats(encoded);
    expect(before.totalAssignments).toBe(7);
    const badSource = Object.entries(before.perSource).find(
      ([, count]) => count === 4
    )![0];

    const res = await app.request(`/exclude/${encoded}`, {
      method: "POST",
      body: JSON.stringify({ sources: [badSource] }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SECRET}`
      }
    });
    expect(res.status).toBe(200);

    const after = await stats(encoded);
    expect(after.totalAssignments).toBe(3);
    expect(after.excluded.bySource).toBe(4);
  });

  it("keeps existing exclusions when a patch omits them", async () => {
    const { encoded, testId } = await makeTest();
    for (let i = 0; i < 3; i++) {
      await choose(testId, hex(`x${i}`), "203.0.113.5");
    }
    const before = await stats(encoded);
    const source = Object.keys(before.perSource)[0];

    const exclude = async (body: unknown) =>
      app.request(`/exclude/${encoded}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRET}`
        }
      });

    await exclude({ sources: [source] });
    // A later patch that only sets windows must not wipe the source
    // exclusion a spread of undefined would have dropped.
    const res = await exclude({ windows: [{ since: 0, until: 1 }] });
    const { policy } = await res.json();
    expect(policy.excludedSources).toEqual([source]);
    expect((await stats(encoded)).excluded.bySource).toBe(3);
  });

  it("requires the stats secret to quarantine", async () => {
    const { encoded } = await makeTest();
    const res = await app.request(`/exclude/${encoded}`, {
      method: "POST",
      body: JSON.stringify({ sources: [] }),
      headers: { "content-type": "application/json" }
    });
    expect(res.status).toBe(401);
  });

  it("stats accepts only the bearer secret", async () => {
    const { encoded } = await makeTest();
    expect((await app.request(`/stats/${encoded}`)).status).toBe(401);
    // Query keys are rejected by design: they would land in access logs.
    expect((await app.request(`/stats/${encoded}?key=${SECRET}`)).status).toBe(
      401
    );
    const wrong = await app.request(`/stats/${encoded}`, {
      headers: { authorization: "Bearer nope" }
    });
    expect(wrong.status).toBe(401);
    const bearer = await app.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(bearer.status).toBe(200);
  });

  it("recompute rejects missing and wrong secrets", async () => {
    const { encoded } = await makeTest();
    expect(
      (await app.request(`/recompute/${encoded}`, { method: "POST" })).status
    ).toBe(401);
    const wrong = await app.request(`/recompute/${encoded}`, {
      method: "POST",
      headers: { authorization: "Bearer nope" }
    });
    expect(wrong.status).toBe(401);
  });

  it("serves the manage shell openly; stats stay behind the fragment secret", async () => {
    const { encoded } = await makeTest();
    const res = await app.request(`/manage/${encoded}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("landing page test");
    // The shell contains no stats data (only loading placeholders), just
    // the fetch wiring that turns the #fragment into a Bearer header.
    expect(html).toContain("location.hash");
    expect(html).toContain("Bearer");
    expect(html).toContain("loading…");
  });
});

describe("mid-test algorithm change", () => {
  it("keeps the testId and recomputes state from events", async () => {
    const base = await makeTest({ ctx: { dims: [{ key: "device" }] } });
    // Traffic on the original ts config, with context recorded.
    for (let i = 0; i < 10; i++) {
      await app.request(`/s/${base.encoded}?id=u${i}&c_device=mobile`);
    }
    await app.request(`/px/${base.encoded}?id=u3`);

    // Same test, switched to bucketed: identity must not change.
    const switched = await makeTest({
      ctx: { dims: [{ key: "device" }] },
      alg: "bucketed"
    });
    expect(switched.testId).toBe(base.testId);

    const rc = await app.request(`/recompute/${switched.encoded}`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(rc.status).toBe(200);
    expect((await rc.json()).events).toBe(10);

    const s = await stats(switched.encoded);
    expect(s.alg).toBe("bucketed");
    expect(s.totalAssignments).toBe(10);
    // The context bucket exists in the recomputed view.
    expect(Object.keys(s.buckets)).toHaveLength(1);

    // Serving continues on the switched config against the same state.
    const res = await app.request(
      `/s/${switched.encoded}?id=u3&c_device=mobile`
    );
    expect(res.status).toBe(302);
  });
});

describe("linear serving", () => {
  it("serves, rewards, and reports theta", async () => {
    const linear = await makeTest({
      alg: "linear",
      ctx: { dims: [{ key: "device" }] }
    });
    for (let i = 0; i < 20; i++) {
      await app.request(
        `/s/${linear.encoded}?id=lu${i}&c_device=${i % 2 ? "mobile" : "desktop"}`
      );
    }
    await app.request(`/px/${linear.encoded}?id=lu1`);
    const s = await stats(linear.encoded);
    expect(s.totalAssignments).toBe(20);
    expect(s.linearTheta).toHaveLength(2);
    expect(s.linearTheta[0]).toHaveLength(16);
  });
});

describe("auto-context from the platform", () => {
  /**
   * Cloudflare hands geo to the Worker on `request.cf`, which no fetch
   * init can set, so tests attach it to the Request the way the runtime
   * would.
   */
  function cfRequest(
    path: string,
    cf: Record<string, string> | null,
    headers: Record<string, string> = {}
  ): Request {
    const req = new Request(`http://localhost${path}`, {
      // A browser navigating always says so, and only a navigation is
      // taken for a person. Tests send it too, or they would all look
      // like mail proxies.
      headers: { accept: BROWSER_ACCEPT, ...headers }
    });
    if (cf) {
      Object.defineProperty(req, "cf", { value: cf });
    }
    return req;
  }

  const AUTO = {
    ctx: { dims: [{ key: "country", from: "country" as const }] }
  };

  it("fills a declared dimension from geo the caller never sent", async () => {
    // This is the whole point: an email redirect has no JavaScript and
    // the sender usually does not know where the reader is.
    const { encoded } = await makeTest(AUTO);
    for (const [i, country] of ["NL", "NL", "DE"].entries()) {
      const res = await app.request(
        cfRequest(`/s/${encoded}?id=geo${i}`, { country })
      );
      expect(res.status).toBe(302);
    }
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(3);
    // Two countries, two buckets: the NL pair shares one.
    expect(Object.keys(s.buckets)).toHaveLength(2);
    expect(s.bySignal.country).toEqual({
      nl: { pulls: 2, conversions: 0 },
      de: { pulls: 1, conversions: 0 }
    });
  });

  it("lets a caller-supplied value beat the derived one", async () => {
    // The integrator knows their own users; an IP database is a guess.
    const { encoded } = await makeTest(AUTO);
    await app.request(cfRequest(`/s/${encoded}?id=a`, { country: "NL" }));
    await app.request(
      cfRequest(`/s/${encoded}?id=b&c_country=nl`, { country: "DE" })
    );
    const s = await stats(encoded);
    // Both land in the "nl" bucket even though b's IP says Germany.
    expect(Object.keys(s.buckets)).toHaveLength(1);
    // The raw signal is still reported as observed, unmapped.
    expect(s.bySignal.country.de.pulls).toBe(1);
  });

  it("records signals even when no dimension uses them", async () => {
    // A plain non-contextual test still gets a legible breakdown, which
    // is what makes the algorithm suggestion possible later.
    const { encoded } = await makeTest();
    await app.request(
      cfRequest(
        `/s/${encoded}?id=plain`,
        { country: "NL", city: "Amsterdam" },
        {
          "user-agent": "Mozilla/5.0 (iPhone) AppleWebKit/605.1",
          "accept-language": "nl-NL,nl;q=0.9"
        }
      )
    );
    const s = await stats(encoded);
    expect(Object.keys(s.buckets)).toHaveLength(0);
    expect(s.bySignal.country.nl.pulls).toBe(1);
    expect(s.bySignal.city.amsterdam.pulls).toBe(1);
    expect(s.bySignal.device.mobile.pulls).toBe(1);
    expect(s.bySignal.language.nl.pulls).toBe(1);
  });

  it("ignores geo on a proxied image fetch", async () => {
    // Gmail fetches email images from Google's own infrastructure, so
    // this geo is a datacenter, not the reader. No context is better
    // than confidently wrong context.
    const { encoded } = await makeTest(AUTO);
    await app.request(
      cfRequest(
        `/s/${encoded}?id=mailproxy`,
        { country: "US", city: "Mountain View" },
        { accept: "image/webp,image/*,*/*;q=0.8" }
      )
    );
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(1);
    expect(s.bySignal).toEqual({});
    expect(Object.keys(s.buckets)).toHaveLength(0);
  });

  it("derives nothing from a proxy that only sends a wildcard accept", async () => {
    // The realistic mail-proxy shape: no sec-fetch-dest, no text/html,
    // just */*. Treating it as a reader would file a datacenter's country
    // as if it were the recipient's.
    const { encoded } = await makeTest(AUTO);
    const res = await app.request(
      cfRequest(
        `/s/${encoded}?id=wildcard`,
        { country: "US", city: "Mountain View" },
        { accept: "*/*" }
      )
    );
    expect(res.status).toBe(302);
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(1);
    expect(s.bySignal).toEqual({});
  });

  it("works with no platform geo at all", async () => {
    // Self-hosted on plain Node there is no `cf`; header-derived signals
    // still work and a geo dimension simply stays unfilled.
    const { encoded } = await makeTest(AUTO);
    const res = await app.request(
      cfRequest(`/s/${encoded}?id=nogeo`, null, {
        "user-agent": "Mozilla/5.0 (Macintosh) Chrome/120"
      })
    );
    expect(res.status).toBe(302);
    const s = await stats(encoded);
    expect(s.bySignal.device.mobile).toBeUndefined();
    expect(s.bySignal.device.desktop.pulls).toBe(1);
    expect(s.bySignal.country).toBeUndefined();
  });

  it("counts a conversion against the signal that produced it", async () => {
    const { encoded } = await makeTest(AUTO);
    await app.request(cfRequest(`/s/${encoded}?id=conv`, { country: "NL" }));
    await app.request(`/px/${encoded}?id=conv`);
    const s = await stats(encoded);
    expect(s.bySignal.country.nl).toEqual({ pulls: 1, conversions: 1 });
  });
});

describe("algorithm suggestion from observed traffic", () => {
  it("says nothing while the chosen algorithm still fits", async () => {
    const { encoded } = await makeTest();
    await app.request(`/s/${encoded}?id=solo`);
    const s = await stats(encoded);
    expect(s.suggestion).toBeNull();
  });

  it("flags a plain test that is quietly receiving context", async () => {
    // Declared dims lie: this test says `ts`, but context is arriving,
    // so a contextual algorithm could serve a per-segment winner.
    const { encoded } = await makeTest({
      alg: "ts",
      ctx: { dims: [{ key: "country", from: "country" }] }
    });
    for (const [i, country] of ["NL", "DE", "FR"].entries()) {
      const req = new Request(`http://localhost/s/${encoded}?id=sug${i}`, {
        headers: { accept: BROWSER_ACCEPT }
      });
      Object.defineProperty(req, "cf", { value: { country } });
      await app.request(req);
    }
    const s = await stats(encoded);
    expect(s.suggestion?.alg).toBe("linear");
    expect(s.suggestion?.reasoning).toContain("3 buckets");
  });

  it("tells a starving bucketed test to generalize instead", async () => {
    // City is the trap: it looks like one dimension and fragments into
    // thousands of buckets that each fall back to the global model.
    const { encoded } = await makeTest({
      alg: "bucketed",
      ctx: { dims: [{ key: "city", from: "city" }] }
    });
    for (let i = 0; i < 12; i++) {
      const req = new Request(`http://localhost/s/${encoded}?id=city${i}`, {
        headers: { accept: BROWSER_ACCEPT }
      });
      Object.defineProperty(req, "cf", { value: { city: `town${i}` } });
      await app.request(req);
    }
    const s = await stats(encoded);
    expect(s.suggestion?.alg).toBe("linear");
    expect(s.suggestion?.reasoning).toContain("recompute");
  });
});

describe("auto-context across serving channels", () => {
  /**
   * The invariant that makes `from` dimensions usable at all: one
   * effective context is one bucket, whether it arrived through an email
   * redirect (server derives it), through the SDK (server derives it on
   * top of a client-hashed key), or was supplied outright. If these
   * diverged, a campaign that emails people and then tracks them with the
   * SDK on the landing page would learn each half of its own traffic
   * separately.
   */
  function cfPost(body: unknown, cf: Record<string, string> | null): Request {
    const req = new Request("http://localhost/choose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (cf) {
      Object.defineProperty(req, "cf", { value: cf });
    }
    return req;
  }

  function cfGet(path: string, cf: Record<string, string> | null): Request {
    const req = new Request(`http://localhost${path}`, {
      headers: { accept: BROWSER_ACCEPT }
    });
    if (cf) {
      Object.defineProperty(req, "cf", { value: cf });
    }
    return req;
  }

  const DIMS = [
    { key: "country", from: "country" as const },
    { key: "persona" }
  ];

  /** The choose body the SDK builds for a given caller context. */
  async function sdkBody(testId: string, idHash: string, persona: string) {
    return {
      testId,
      armCount: 2,
      alg: "bucketed" as const,
      dim: FEATURE_DIM,
      idHash,
      ctxKey: await bucketKey(testId, { persona }),
      featIdx: featureIndices({ persona }),
      autoDims: [{ key: "country", from: "country" }]
    };
  }

  it("puts an SDK visitor and a redirect visitor in one bucket", async () => {
    const { encoded, testId } = await makeTest({
      alg: "bucketed",
      ctx: { dims: DIMS }
    });
    await app.request(
      cfGet(`/s/${encoded}?id=viaEmail&c_persona=power`, { country: "NL" })
    );
    const res = await app.request(
      cfPost(await sdkBody(testId, hex("viaSdk"), "power"), { country: "NL" })
    );
    expect(res.status).toBe(200);

    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(2);
    // One bucket, both visitors in it.
    expect(Object.keys(s.buckets)).toHaveLength(1);
    const bucket = Object.values(s.buckets)[0] as { pulls: number[] };
    expect(bucket.pulls.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("matches a supplied value against a derived one across channels", async () => {
    // The SDK knows this visitor is Dutch from the user's own profile;
    // their IP says Germany. They still belong with the redirect visitor
    // whose Dutch IP produced the same value.
    const { encoded, testId } = await makeTest({
      alg: "bucketed",
      ctx: { dims: DIMS }
    });
    await app.request(
      cfGet(`/s/${encoded}?id=derived&c_persona=power`, { country: "NL" })
    );
    await app.request(
      cfPost(
        {
          ...(await sdkBody(testId, hex("supplied"), "power")),
          autoCtx: { country: "nl" }
        },
        { country: "DE" }
      )
    );

    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(2);
    expect(Object.keys(s.buckets)).toHaveLength(1);
  });

  it("keeps genuinely different contexts apart", async () => {
    const { encoded, testId } = await makeTest({
      alg: "bucketed",
      ctx: { dims: DIMS }
    });
    await app.request(
      cfGet(`/s/${encoded}?id=nl&c_persona=power`, { country: "NL" })
    );
    await app.request(
      cfPost(await sdkBody(testId, hex("de"), "power"), { country: "DE" })
    );
    await app.request(
      cfPost(await sdkBody(testId, hex("casual"), "casual"), { country: "NL" })
    );

    const s = await stats(encoded);
    expect(Object.keys(s.buckets)).toHaveLength(3);
  });

  it("ignores an SDK caller that declares no auto dimensions", async () => {
    // An older SDK build predates `from` support. Its traffic must still
    // be served, just without the derived dimension.
    const { encoded, testId } = await makeTest({
      alg: "bucketed",
      ctx: { dims: DIMS }
    });
    const body = await sdkBody(testId, hex("oldSdk"), "power");
    const res = await app.request(
      cfPost({ ...body, autoDims: undefined }, { country: "NL" })
    );
    expect(res.status).toBe(200);
    const s = await stats(encoded);
    // Its own bucket: the persona key alone, uncomposed.
    expect(Object.keys(s.buckets)).toHaveLength(1);
    expect(s.bySignal.country.nl.pulls).toBe(1);
  });
});

describe("opting a link out of derived context", () => {
  /**
   * Nothing that touches an inbox is reliably the reader: mail providers
   * fetch images from their own infrastructure, and corporate link
   * scanners follow links from datacenters while sending browser headers,
   * which no header heuristic can catch. `?auto=0` makes that explicit
   * per link instead of leaving it to a guess.
   */
  function browserRequest(path: string, cf: Record<string, string>): Request {
    const req = new Request(`http://localhost${path}`, {
      headers: { accept: BROWSER_ACCEPT }
    });
    Object.defineProperty(req, "cf", { value: cf });
    return req;
  }

  const AUTO_COUNTRY = {
    alg: "bucketed" as const,
    ctx: { dims: [{ key: "country", from: "country" as const }] }
  };

  it("derives nothing even though the request looks like a person", async () => {
    // A link scanner presents exactly these headers. Without ?auto=0 it
    // would be read as the recipient and file a datacenter's country.
    const { encoded } = await makeTest(AUTO_COUNTRY);
    const res = await app.request(
      browserRequest(`/s/${encoded}?id=scanned&auto=0`, { country: "US" })
    );
    expect(res.status).toBe(302);
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(1);
    expect(s.bySignal).toEqual({});
    expect(Object.keys(s.buckets)).toHaveLength(0);
  });

  it("still derives context on the same test's ordinary links", async () => {
    // Opting out is per link, not per test: the web half of a campaign
    // keeps its context while the email half does not pretend to have it.
    const { encoded } = await makeTest(AUTO_COUNTRY);
    await app.request(
      browserRequest(`/s/${encoded}?id=fromEmail&auto=0`, { country: "US" })
    );
    await app.request(
      browserRequest(`/s/${encoded}?id=fromWeb`, { country: "NL" })
    );
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(2);
    expect(s.bySignal.country).toEqual({ nl: { pulls: 1, conversions: 0 } });
    expect(Object.keys(s.buckets)).toHaveLength(1);
  });

  it("keeps context the caller supplied outright", async () => {
    // ?auto=0 disables derivation, not context. A sender who merged the
    // recipient's country in from their own CRM still knows it.
    const { encoded } = await makeTest(AUTO_COUNTRY);
    await app.request(
      browserRequest(`/s/${encoded}?id=known&auto=0&c_country=nl`, {
        country: "US"
      })
    );
    const s = await stats(encoded);
    expect(Object.keys(s.buckets)).toHaveLength(1);
    // The supplied value bucketed the visitor; the machine's did not.
    expect(s.bySignal).toEqual({});
  });

  it("applies to click links too", async () => {
    const { encoded } = await makeTest(AUTO_COUNTRY);
    const res = await app.request(
      browserRequest(`/c/${encoded}?id=clicker&auto=0`, { country: "US" })
    );
    expect(res.status).toBe(302);
    const s = await stats(encoded);
    expect(s.bySignal).toEqual({});
  });

  it("reads the spellings that get pasted into ESP templates", async () => {
    const { encoded } = await makeTest(AUTO_COUNTRY);
    for (const [i, flag] of ["0", "false", "off", "no"].entries()) {
      await app.request(
        browserRequest(`/s/${encoded}?id=spell${i}&auto=${flag}`, {
          country: "US"
        })
      );
    }
    const s = await stats(encoded);
    expect(s.totalAssignments).toBe(4);
    expect(s.bySignal).toEqual({});
  });

  it("ignores a value that does not mean off", async () => {
    const { encoded } = await makeTest(AUTO_COUNTRY);
    await app.request(
      browserRequest(`/s/${encoded}?id=on&auto=1`, { country: "NL" })
    );
    const s = await stats(encoded);
    expect(s.bySignal.country.nl.pulls).toBe(1);
  });
});

describe("query-parameter tests (the ESP template form)", () => {
  /**
   * The whole point: a template author wires the fixed parts once, and a
   * campaign manager fills in nothing but variant URLs through ordinary
   * template fields. No encoding step, no account, no visit here.
   */
  const A = "https://example.com/a";
  const B = "https://example.com/b";

  function get(path: string, headers: Record<string, string> = {}) {
    return app.request(
      new Request(`http://localhost${path}`, {
        headers: { accept: BROWSER_ACCEPT, ...headers }
      })
    );
  }

  it("serves a test spelled out with nothing but variants", async () => {
    const res = await get(`/s?a=${A}&a=${B}&id=r1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/example\.com\/(a|b)/);
  });

  it("is the same test as its base64 spelling", async () => {
    // Two encodings of one config must share state, or a campaign that
    // moved between forms would silently restart its learning.
    const { config, testId } = await configFromParams(
      new URLSearchParams(`a=${A}&a=${B}&k=${await hashStatsSecret(SECRET)}`)
    );
    const { encoded } = await encodeConfig(config);
    await get(`/s?a=${A}&a=${B}&k=${await hashStatsSecret(SECRET)}&id=r1`);
    await app.request(
      new Request(`http://localhost/s/${encoded}?id=r2`, {
        headers: { accept: BROWSER_ACCEPT }
      })
    );
    const s = await stats(encoded);
    expect(s.testId).toBe(testId);
    expect(s.totalAssignments).toBe(2);
  });

  it("keeps a recipient on one variant across opens", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await get(`/s?a=${A}&a=${B}&id=sticky`);
      seen.add(res.headers.get("location")!);
    }
    expect(seen.size).toBe(1);
  });

  it("serves the control rather than break the layout", async () => {
    // A hand-filled template with one field left empty. In an img src a
    // 404 is a broken image in front of the whole list, so this degrades
    // to "no test" instead.
    const res = await get(`/s?a=${A}&id=r1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(A);
  });

  it("404s only when there is nothing servable at all", async () => {
    expect((await get("/s?n=nothing")).status).toBe(404);
  });

  it("has no readable stats without a stats key", async () => {
    // A test with no owner still runs; it just cannot be read, because
    // no secret can match a hash that was never set.
    const { config } = await configFromParams(
      new URLSearchParams(`a=${A}&a=${B}`)
    );
    const { encoded, warnings } = await encodeConfig(config);
    expect(warnings.join(" ")).toMatch(/never be read/);
    const res = await app.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(res.status).toBe(401);
  });
});

describe("carrying attribution to the destination", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";

  function get(path: string) {
    return app.request(
      new Request(`http://localhost${path}`, {
        headers: { accept: BROWSER_ACCEPT }
      })
    );
  }

  it("forwards params it does not recognize", async () => {
    // ESPs and ad platforms append their own attribution. A redirect that
    // swallowed it would break the customer's analytics at exactly the
    // point the test starts mattering.
    const res = await get(
      `/s?a=${A}&a=${B}&id=r1&utm_source=newsletter&gclid=xyz`
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("utm_source")).toBe("newsletter");
    expect(location.searchParams.get("gclid")).toBe("xyz");
    // Ours never leak onward.
    expect(location.searchParams.has("a")).toBe(false);
    expect(location.searchParams.has("id")).toBe(false);
  });

  it("stamps the served variant into the customer's own analytics", async () => {
    const res = await get(
      `/s?a=${A}&a=${B}&an=hero&an=lifestyle&vp=utm_content&id=r1` +
        "&utm_source=newsletter"
    );
    const location = new URL(res.headers.get("location")!);
    expect(["hero", "lifestyle"]).toContain(
      location.searchParams.get("utm_content")
    );
  });

  it("can be switched off", async () => {
    const res = await get(`/s?a=${A}&a=${B}&id=r1&fw=0&utm_source=newsletter`);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.has("utm_source")).toBe(false);
  });

  it("forwards on click redirects too", async () => {
    const res = await get(
      `/c?a=${A}&a=${B}&r=https://example.com/thanks&id=r1&utm_source=news`
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("utm_source")).toBe("news");
  });
});

describe("campaign tags as context", () => {
  const A = "https://example.com/a";
  const B = "https://example.com/b";

  function get(path: string, headers: Record<string, string> = {}) {
    return app.request(
      new Request(`http://localhost${path}`, {
        headers: { accept: BROWSER_ACCEPT, ...headers }
      })
    );
  }

  async function statsFor(search: string) {
    const { config } = await configFromParams(
      new URLSearchParams(`${search}&k=${await hashStatsSecret(SECRET)}`)
    );
    const { encoded } = await encodeConfig(config);
    return stats(encoded);
  }

  const TEST = `a=${A}&a=${B}&alg=bucketed&ctx=source:utm_source`;

  it("buckets by the tag the sender wrote", async () => {
    await get(
      `/s?${TEST}&k=${await hashStatsSecret(SECRET)}&id=n1&utm_source=newsletter`
    );
    await get(
      `/s?${TEST}&k=${await hashStatsSecret(SECRET)}&id=n2&utm_source=newsletter`
    );
    await get(
      `/s?${TEST}&k=${await hashStatsSecret(SECRET)}&id=s1&utm_source=twitter`
    );
    const s = await statsFor(TEST);
    expect(s.totalAssignments).toBe(3);
    expect(Object.keys(s.buckets)).toHaveLength(2);
    expect(s.bySignal.utm_source).toEqual({
      newsletter: { pulls: 2, conversions: 0 },
      twitter: { pulls: 1, conversions: 0 }
    });
  });

  it("survives a proxy fetch, unlike geo", async () => {
    // This is what makes campaign tags the trustworthy derived context in
    // email: Gmail's fetcher relays the URL the sender wrote, so the tag
    // is as true for it as for the reader, while its geo is a datacenter.
    const req = new Request(
      `http://localhost/s?${TEST}&k=${await hashStatsSecret(SECRET)}&id=proxy&utm_source=newsletter`,
      { headers: { accept: "image/webp,*/*" } }
    );
    Object.defineProperty(req, "cf", { value: { country: "US" } });
    await app.request(req);
    const s = await statsFor(TEST);
    expect(s.bySignal.utm_source.newsletter.pulls).toBe(1);
    expect(s.bySignal.country).toBeUndefined();
  });

  it("survives ?auto=0 too", async () => {
    const req = new Request(
      `http://localhost/s?${TEST}&k=${await hashStatsSecret(SECRET)}&id=noauto&auto=0&utm_source=newsletter`,
      { headers: { accept: BROWSER_ACCEPT } }
    );
    Object.defineProperty(req, "cf", { value: { country: "NL" } });
    await app.request(req);
    const s = await statsFor(TEST);
    expect(s.bySignal.utm_source.newsletter.pulls).toBe(1);
    expect(s.bySignal.country).toBeUndefined();
  });
});
