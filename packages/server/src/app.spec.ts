import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  encodeConfig,
  externalIdHash,
  hashStatsSecret,
  mulberry32,
  type TestConfigInput
} from "@livevariant/core";
import { createApp, pruneWindows } from "./app.js";
import { MemoryStore } from "./store/memory.js";

/**
 * End-to-end tests over the HTTP surface with the memory store: the same
 * flows the plan's verification section names, driven through app.request.
 */

const SECRET = "test-stats-secret";

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

describe("rate-limit window pruning", () => {
  it("drops expired windows and leaves live ones alone", () => {
    const now = 1_700_000_000_000;
    const windows = new Map([
      ["stale", { count: 5, windowStart: now - 90_000 }],
      ["live", { count: 2, windowStart: now - 1_000 }]
    ]);
    pruneWindows(windows, now);
    expect([...windows.keys()]).toEqual(["live"]);
  });

  it("never resets everyone's allowance at once", () => {
    // All windows live: a blanket clear would hand every source a fresh
    // allowance at the moment an attacker overflows the map.
    const now = 1_700_000_000_000;
    const windows = new Map(
      Array.from({ length: 10 }, (_, i) => [
        `ip${i}`,
        { count: 9, windowStart: now - i * 100 }
      ]) as Array<[string, { count: number; windowStart: number }]>
    );
    pruneWindows(windows, now);
    expect(windows.size).toBe(5);
    // The survivors are the most recent, so active limits keep counting.
    expect(windows.has("ip0")).toBe(true);
    expect(windows.has("ip9")).toBe(false);
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

describe("stats and manage auth", () => {
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
