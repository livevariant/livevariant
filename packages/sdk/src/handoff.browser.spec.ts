import { beforeEach, describe, expect, it } from "vitest";
import { computeTestId, type TestConfig } from "@livevariant/core";
import { createTest } from "./index.js";
import { autoTrack } from "./auto-track.js";
import { captureHandoff, getHandoff, listHandoffs } from "./handoff.js";

/**
 * The redirect -> SDK identity handoff, in a real browser: URL capture and
 * cleaning, assignment adoption in createTest, and the GTM-style
 * autoTrack mode that rewards stored handoffs from GA events.
 */

const CONFIG: TestConfig = {
  v: 1,
  name: "handoff test",
  arms: [
    { name: "control", formats: { text: "A" } },
    { name: "variant", formats: { text: "B" } }
  ],
  alg: "ts",
  priorStrengthCap: 50,
  minBucketPulls: 100,
  decorateRedirects: true,
  statsKeyHash: "0".repeat(64)
} as TestConfig;

const ID_HASH = "ab".repeat(32);

function fakeServer() {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    return Response.json({ armIndex: 0, rewarded: true, first: true });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function visitWithParams(params: Record<string, string>): void {
  const search = new URLSearchParams(params).toString();
  history.pushState(null, "", `/landing?${search}&utm_source=mail`);
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, "", "/");
  delete (window as any).dataLayer;
});

describe("captureHandoff", () => {
  it("stores the handoff and cleans the URL, keeping other params", async () => {
    const testId = await computeTestId(CONFIG);
    visitWithParams({ _lvt: testId, _lvid: ID_HASH, _lvvar: "1" });
    const captured = captureHandoff(window, localStorage);
    expect(captured?.armIndex).toBe(1);
    expect(location.search).toBe("?utm_source=mail"); // _lv* gone, utm kept
    expect(getHandoff(localStorage, testId)?.idHash).toBe(ID_HASH);
  });

  it("ignores malformed or partial params", () => {
    visitWithParams({ _lvt: "nothex", _lvid: ID_HASH, _lvvar: "1" });
    expect(captureHandoff(window, localStorage)).toBeNull();
  });

  it("expires stored handoffs after the TTL", async () => {
    const testId = await computeTestId(CONFIG);
    localStorage.setItem(
      `lv:h:${testId}`,
      JSON.stringify({
        testId,
        idHash: ID_HASH,
        armIndex: 1,
        capturedAt: Date.now() - 31 * 24 * 60 * 60 * 1000
      })
    );
    expect(getHandoff(localStorage, testId)).toBeNull();
  });
});

describe("createTest with a handoff", () => {
  it("adopts the server-side assignment: no choose call, same idHash", async () => {
    const testId = await computeTestId(CONFIG);
    visitWithParams({ _lvt: testId, _lvid: ID_HASH, _lvvar: "1" });
    const { calls, fetchImpl } = fakeServer();
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: fetchImpl,
      rewardEvents: false
    });
    // Server said arm 1 during the redirect; no /choose round-trip.
    expect(test.variant.name).toBe("variant");
    expect(calls.filter(c => c.url.endsWith("/choose"))).toHaveLength(0);

    await test.trackConversion(3);
    const reward = calls.find(c => c.url.endsWith("/reward"));
    expect(reward?.body).toEqual({ testId, idHash: ID_HASH, amount: 3 });
    test.dispose();
  });
});

describe("autoTrack (GTM one-tag mode)", () => {
  it("captures on load and rewards every stored handoff on GA events", async () => {
    const testId = await computeTestId(CONFIG);
    const otherTest = "cd".repeat(32);
    // A second test's handoff captured on an earlier pageview.
    localStorage.setItem(
      `lv:h:${otherTest}`,
      JSON.stringify({
        testId: otherTest,
        idHash: "ef".repeat(32),
        armIndex: 0,
        capturedAt: Date.now()
      })
    );
    visitWithParams({ _lvt: testId, _lvid: ID_HASH, _lvvar: "0" });

    const { calls, fetchImpl } = fakeServer();
    const tracker = autoTrack({
      serverUrl: "https://livevariant.link",
      fetch: fetchImpl
    });
    expect(location.search).toBe("?utm_source=mail");
    expect(listHandoffs(localStorage)).toHaveLength(2);

    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ event: "purchase" });
    await new Promise(resolve => setTimeout(resolve, 20));

    const rewards = calls.filter(c => c.url.endsWith("/reward"));
    expect(rewards).toHaveLength(2);
    const rewarded = new Set(rewards.map(r => r.body.testId));
    expect(rewarded).toEqual(new Set([testId, otherTest]));
    for (const r of rewards) {
      expect(Object.keys(r.body).sort()).toEqual([
        "amount",
        "idHash",
        "testId"
      ]);
    }
    tracker.dispose();
  });
});
