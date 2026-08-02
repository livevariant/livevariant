import { beforeEach, describe, expect, it } from "vitest";
import type { TestConfig } from "@livevariant/core";
import { createTest, type CreateTestOptions } from "./index.js";
import { gaClientId } from "./identity.js";
import { eventNameOf, resetDataLayerInterception } from "./ga.js";

/**
 * Real-browser tests (chromium via vitest browser mode): cookies, storage,
 * and dataLayer interception are exactly the things jsdom fakes badly.
 * The server is faked with an injected fetch so assertions are exact.
 */

const CONFIG: TestConfig = {
  v: 1,
  name: "sdk test",
  arms: [
    {
      name: "control",
      formats: {
        text: "Buy now",
        html: "<b>Buy now</b>",
        url: "https://example.com/a"
      }
    },
    { name: "variant", formats: { text: "Get started" } }
  ],
  alg: "ts",
  priorStrengthCap: 50,
  minBucketPulls: 100,
  statsKeyHash: "0".repeat(64)
} as TestConfig;

interface FakeServer {
  fetch: typeof fetch;
  chooseCalls: any[];
  rewardCalls: any[];
}

function fakeServer(armIndex = 1): FakeServer {
  const server: FakeServer = { chooseCalls: [], rewardCalls: [], fetch: null! };
  server.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/choose")) {
      server.chooseCalls.push(body);
      return Response.json({ armIndex });
    }
    if (url.endsWith("/reward")) {
      server.rewardCalls.push(body);
      return Response.json({ rewarded: true, first: true });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return server;
}

function options(
  server: FakeServer,
  extra?: Partial<CreateTestOptions>
): CreateTestOptions {
  return {
    serverUrl: "https://livevariant.link",
    fetch: server.fetch,
    rewardEvents: false,
    ...extra
  };
}

function clearDataLayer(): void {
  // Remove any wrapper/trap earlier tests installed, and the shared
  // interception state that goes with it.
  delete (window as any).dataLayer;
  resetDataLayerInterception(window);
}

beforeEach(() => {
  localStorage.clear();
  document.cookie = "_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  clearDataLayer();
});

describe("assignment", () => {
  it("chooses via the server and exposes the variant formats", async () => {
    const server = fakeServer(1);
    const test = await createTest(CONFIG, options(server));
    expect(test.variant.name).toBe("variant");
    expect(test.variant.text).toBe("Get started");
    expect(server.chooseCalls).toHaveLength(1);
    test.dispose();
  });

  it("sends only hashes and numbers, never content or raw ids", async () => {
    const server = fakeServer();
    const ctxConfig: TestConfig = {
      ...CONFIG,
      ctx: { dims: [{ key: "country" }] }
    } as TestConfig;
    const test = await createTest(ctxConfig, {
      ...options(server),
      externalId: "michael@example.com",
      context: { country: "NL" }
    });
    const sent = JSON.stringify(server.chooseCalls[0]);
    expect(sent).not.toContain("michael");
    expect(sent).not.toContain("NL");
    expect(sent).not.toContain("Buy now");
    expect(server.chooseCalls[0].idHash).toMatch(/^[0-9a-f]{64}$/);
    expect(server.chooseCalls[0].ctxKey).toMatch(/^[0-9a-f]{64}$/);
    expect(server.chooseCalls[0].featIdx.length).toBeGreaterThan(1);
    test.dispose();
  });

  it("caches the assignment in localStorage and skips the network", async () => {
    const server = fakeServer();
    (await createTest(CONFIG, options(server, { externalId: "u1" }))).dispose();
    const again = await createTest(
      CONFIG,
      options(server, { externalId: "u1" })
    );
    expect(server.chooseCalls).toHaveLength(1); // second call served from cache
    expect(again.variant.name).toBe("variant");
    again.dispose();
  });

  it("refetches when the external id changes (cache is per-id)", async () => {
    const server = fakeServer();
    (await createTest(CONFIG, options(server, { externalId: "u1" }))).dispose();
    (await createTest(CONFIG, options(server, { externalId: "u2" }))).dispose();
    expect(server.chooseCalls).toHaveLength(2);
  });

  it("accepts a pre-encoded config string and builds matching urls", async () => {
    const server = fakeServer();
    // Object round-trip: URLs from object and string input must agree.
    const fromObject = await createTest(CONFIG, options(server));
    const encoded = fromObject.urls.serve.split("/s/")[1];
    const fromString = await createTest(encoded, options(server));
    expect(fromString.testId).toBe(fromObject.testId);
    expect(fromString.urls.serve).toBe(fromObject.urls.serve);
    fromObject.dispose();
    fromString.dispose();
  });
});

describe("external id resolution", () => {
  it("prefers the GA client id from the _ga cookie", async () => {
    document.cookie = "_ga=GA1.1.1234567890.1699999999";
    const server = fakeServer();
    const a = await createTest(CONFIG, options(server));
    // Same cookie -> same idHash on a fresh createTest.
    localStorage.clear();
    const b = await createTest(CONFIG, options(server));
    expect(server.chooseCalls[0].idHash).toBe(server.chooseCalls[1].idHash);
    a.dispose();
    b.dispose();
  });

  it("parses realistic _ga cookies", () => {
    expect(gaClientId("_ga=GA1.1.123.456")).toBe("123.456");
    expect(gaClientId("foo=bar; _ga=GA1.2.99.11; baz=1")).toBe("99.11");
    expect(gaClientId("foo=bar")).toBeNull();
    expect(gaClientId("_ga=garbage")).toBeNull();
  });

  it("generates and persists an id when nothing else is available", async () => {
    const server = fakeServer();
    (await createTest(CONFIG, options(server))).dispose();
    const generated = localStorage.getItem("lv:id");
    expect(generated).toBeTruthy();
    localStorage.removeItem(
      `lv:a:${(await createTest(CONFIG, options(server))).testId}`
    );
    (await createTest(CONFIG, options(server))).dispose();
    expect(localStorage.getItem("lv:id")).toBe(generated); // stable across visits
  });
});

describe("GA auto-reward", () => {
  it("rewards on matching events when gtag loaded first", async () => {
    const dl: unknown[] = [];
    (window as any).dataLayer = dl;
    const server = fakeServer();
    const test = await createTest(
      CONFIG,
      options(server, { rewardEvents: undefined })
    );
    dl.push({ event: "page_view" });
    dl.push({ event: "purchase", value: 42 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.rewardCalls).toHaveLength(1);
    test.dispose();
  });

  it("rewards when the SDK loads before gtag (property trap)", async () => {
    const server = fakeServer();
    const test = await createTest(
      CONFIG,
      options(server, { rewardEvents: undefined })
    );
    // gtag boots afterwards, exactly like the real snippet does.
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ event: "sign_up" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.rewardCalls).toHaveLength(1);
    test.dispose();
  });

  it("supports multiple concurrent tests before gtag loads", async () => {
    // Two tests on one page, both created before window.dataLayer exists:
    // they must share the property trap, not overwrite each other.
    const server = fakeServer();
    const testA = await createTest(
      CONFIG,
      options(server, { rewardEvents: undefined, externalId: "uA" })
    );
    const testB = await createTest(
      { ...CONFIG, name: "second test" },
      options(server, { rewardEvents: undefined, externalId: "uB" })
    );
    expect(testA.testId).not.toBe(testB.testId);
    (window as any).dataLayer = (window as any).dataLayer || [];
    (window as any).dataLayer.push({ event: "purchase" });
    await new Promise(resolve => setTimeout(resolve, 10));
    // One purchase event -> one reward per live test.
    expect(server.rewardCalls).toHaveLength(2);
    const rewardedTests = new Set(server.rewardCalls.map(r => r.testId));
    expect(rewardedTests).toEqual(new Set([testA.testId, testB.testId]));
    testA.dispose();
    testB.dispose();
  });

  it("understands gtag-style Arguments entries", () => {
    function gtagEntry(..._args: unknown[]): IArguments {
      // eslint-disable-next-line prefer-rest-params
      return arguments;
    }
    expect(eventNameOf(gtagEntry("event", "purchase", { value: 1 }))).toBe(
      "purchase"
    );
    expect(eventNameOf(gtagEntry("config", "G-XXX"))).toBeNull();
    expect(eventNameOf({ event: "sign_up" })).toBe("sign_up");
    expect(eventNameOf("junk")).toBeNull();
  });

  it("respects denied analytics consent", async () => {
    const dl: unknown[] = [];
    (window as any).dataLayer = dl;
    function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      dl.push(arguments);
    }
    gtag("consent", "default", { analytics_storage: "denied" });
    const server = fakeServer();
    const test = await createTest(
      CONFIG,
      options(server, { rewardEvents: undefined })
    );
    dl.push({ event: "purchase" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.rewardCalls).toHaveLength(0);
    // Consent granted later: rewards flow again.
    gtag("consent", "update", { analytics_storage: "granted" });
    dl.push({ event: "purchase" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.rewardCalls).toHaveLength(1);
    test.dispose();
  });

  it("honors config.rewardEvents over the defaults", async () => {
    const dl: unknown[] = [];
    (window as any).dataLayer = dl;
    const server = fakeServer();
    const test = await createTest(
      { ...CONFIG, rewardEvents: ["newsletter_signup"] },
      options(server, { rewardEvents: undefined })
    );
    dl.push({ event: "purchase" }); // default name, NOT configured
    dl.push({ event: "newsletter_signup" });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(server.rewardCalls).toHaveLength(1);
    test.dispose();
  });
});

describe("manual conversion", () => {
  it("sends the amount and the assignment's idHash", async () => {
    const server = fakeServer();
    const test = await createTest(
      CONFIG,
      options(server, { externalId: "u1" })
    );
    await test.trackConversion(12.5);
    expect(server.rewardCalls[0].amount).toBe(12.5);
    expect(server.rewardCalls[0].idHash).toBe(server.chooseCalls[0].idHash);
    test.dispose();
  });
});
