import { beforeEach, describe, expect, it } from "vitest";
import { computeTestId, parseTestConfig } from "@livevariant/core";
import { createTest } from "./index.js";
import { SDK_VERSION } from "./version.js";
import { autoTrack } from "./auto-track.js";
import { captureHandoff, getHandoff, listHandoffs } from "./handoff.js";
import { resetDataLayerInterception } from "./ga.js";
import { pageStorage } from "./page-store.js";

/**
 * The redirect -> SDK identity handoff, in a real browser: URL capture and
 * cleaning, assignment adoption in createTest, and the GTM-style
 * autoTrack mode that rewards stored handoffs from GA events.
 */

const CONFIG = parseTestConfig({
  name: "handoff test",
  variants: [
    { name: "control", text: "A" },
    { name: "variant", text: "B" }
  ],
  statsKeyHash: "0".repeat(64)
});

const ID_HASH = "ab".repeat(32);

function fakeServer() {
  const calls: { url: string; body: any }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : null
    });
    return Response.json({ cell: 0, choice: [0], rewarded: true, first: true });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function visitWithParams(params: Record<string, string>): void {
  const search = new URLSearchParams(params).toString();
  history.pushState(null, "", `/landing?${search}&utm_source=mail`);
}

beforeEach(() => {
  localStorage.clear();
  pageStorage(window).clear();
  history.replaceState(null, "", "/");
  delete (window as any).dataLayer;
  // The interceptor is a per-window singleton with an event replay buffer;
  // without this reset a later test inherits earlier tests' events.
  resetDataLayerInterception(window);
});

describe("captureHandoff", () => {
  it("stores the handoff and cleans the URL, keeping other params", async () => {
    const testId = await computeTestId(CONFIG);
    visitWithParams({ _lvt: testId, _lvid: ID_HASH, _lvvar: "1" });
    const captured = captureHandoff(window, localStorage);
    expect(captured?.cell).toBe(1);
    expect(location.search).toBe("?utm_source=mail"); // _lv* gone, utm kept
    expect(getHandoff(localStorage, testId)?.idHash).toBe(ID_HASH);
  });

  it("ignores malformed or partial params", () => {
    visitWithParams({ _lvt: "nothex", _lvid: ID_HASH, _lvvar: "1" });
    expect(captureHandoff(window, localStorage)).toBeNull();
  });

  it("lists live handoffs even while pruning expired ones", async () => {
    // Regression: pruning during an index loop re-compacts localStorage
    // keys and used to skip the entry sliding into the freed slot.
    localStorage.setItem(
      `lv:h:${"11".repeat(32)}`,
      JSON.stringify({
        testId: "11".repeat(32),
        idHash: ID_HASH,
        cell: 0,
        capturedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 // expired
      })
    );
    localStorage.setItem(
      `lv:h:${"22".repeat(32)}`,
      JSON.stringify({
        testId: "22".repeat(32),
        idHash: ID_HASH,
        cell: 1,
        capturedAt: Date.now() // live
      })
    );
    const live = listHandoffs(localStorage);
    expect(live).toHaveLength(1);
    expect(live[0].testId).toBe("22".repeat(32));
    // The expired entry was pruned as a side effect.
    expect(localStorage.getItem(`lv:h:${"11".repeat(32)}`)).toBeNull();
  });

  it("ignores handoffs whose cell exceeds the config", async () => {
    const testId = await computeTestId(CONFIG);
    // Only 2 combinations exist.
    visitWithParams({ _lvt: testId, _lvid: ID_HASH, _lvvar: "7" });
    const { calls, fetchImpl } = fakeServer();
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: fetchImpl,
      rewardEvents: false
    });
    // Falls back to a normal choose instead of rendering a wrong arm.
    expect(calls.filter(c => c.url.endsWith("/choose"))).toHaveLength(1);
    test.dispose();
  });

  it("expires stored handoffs after the TTL", async () => {
    const testId = await computeTestId(CONFIG);
    localStorage.setItem(
      `lv:h:${testId}`,
      JSON.stringify({
        testId,
        idHash: ID_HASH,
        cell: 1,
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
    expect(reward?.body).toEqual({
      testId,
      idHash: ID_HASH,
      amount: 3,
      sdk: SDK_VERSION
    });
    test.dispose();
  });
});

describe("autoTrack (GTM one-tag mode)", () => {
  it("captures on load and rewards every stored handoff on GA events", async () => {
    const testId = await computeTestId(CONFIG);
    const otherTest = "cd".repeat(32);
    // A second test's handoff, persisted under the localStorage opt-in by
    // an earlier pageview. Today's tag runs in the default page mode, and
    // the watcher must still reward it.
    localStorage.setItem(
      `lv:h:${otherTest}`,
      JSON.stringify({
        testId: otherTest,
        idHash: "ef".repeat(32),
        cell: 0,
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
    // The URL capture landed in the default page store; the legacy handoff
    // stayed where it was. One in each, both about to be rewarded.
    expect(listHandoffs(pageStorage(window))).toHaveLength(1);
    expect(listHandoffs(localStorage)).toHaveLength(1);

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
        "sdk",
        "testId"
      ]);
    }
    tracker.dispose();
  });

  it("rewards a localStorage assignment from a page-store watcher", async () => {
    // The Greptile P1 scenario: the tag booted first and claimed the page's
    // one GA watcher on the DEFAULT page store; page code then created a
    // test with the documented localStorage opt-in. Its cached assignment
    // lives where the watcher's own store does not, and the conversion
    // must reward it anyway.
    const inlineTest = "ab".repeat(32);
    localStorage.setItem(
      `lv:a:${inlineTest}`,
      JSON.stringify({ cell: 1, idHash: "0f".repeat(32) })
    );
    const { calls, fetchImpl } = fakeServer();
    const tracker = autoTrack({
      serverUrl: "https://livevariant.link",
      fetch: fetchImpl
    });
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ event: "purchase" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const rewards = calls.filter(c => c.url.endsWith("/reward"));
    expect(rewards).toHaveLength(1);
    expect(rewards[0].body.testId).toBe(inlineTest);
    tracker.dispose();
  });
});
