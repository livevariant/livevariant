import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  encodeConfig,
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
  const res = await app.request(`/stats/${encoded}?key=${SECRET}`);
  expect(res.status).toBe(200);
  return res.json();
}

describe("redirect serving", () => {
  it("302s to an arm url", async () => {
    const { encoded } = await makeTest();
    const res = await app.request(`/s/${encoded}?id=user1`);
    expect(res.status).toBe(302);
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
    expect(explicit.headers.get("location")).toBe("https://example.com/custom");

    const fallback = await app.request(`/c/${encoded}?id=u1`);
    expect(fallback.headers.get("location")).toBe(
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
    expect(ok.headers.get("location")).toBe("https://example.com/other-page");
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
});

describe("stats and manage auth", () => {
  it("401s without or with a wrong key, 200s with query key or bearer", async () => {
    const { encoded } = await makeTest();
    expect((await app.request(`/stats/${encoded}`)).status).toBe(401);
    expect((await app.request(`/stats/${encoded}?key=wrong`)).status).toBe(401);
    expect((await app.request(`/stats/${encoded}?key=${SECRET}`)).status).toBe(
      200
    );
    const bearer = await app.request(`/stats/${encoded}`, {
      headers: { authorization: `Bearer ${SECRET}` }
    });
    expect(bearer.status).toBe(200);
  });

  it("serves the manage page with the key", async () => {
    const { encoded } = await makeTest();
    expect((await app.request(`/manage/${encoded}`)).status).toBe(401);
    const res = await app.request(`/manage/${encoded}?key=${SECRET}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("landing page test");
    expect(html).toContain("control");
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

    const rc = await app.request(
      `/recompute/${switched.encoded}?key=${SECRET}`,
      {
        method: "POST"
      }
    );
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
