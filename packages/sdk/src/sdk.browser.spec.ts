import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bucketKey,
  computeTestId,
  parseTestConfig,
  type TestConfigInput
} from "@livevariant/core";
import { createTest, type CreateTestOptions } from "./index.js";
import { gaClientId } from "./identity.js";
import { eventNameOf, resetDataLayerInterception } from "./ga.js";
import { resetAutoTrack } from "./auto-track.js";
import { pageStorage, resetStoreRegistry } from "./page-store.js";
import { SDK_VERSION } from "./version.js";

/**
 * Real-browser tests (chromium via vitest browser mode): cookies, storage,
 * and dataLayer interception are exactly the things jsdom fakes badly.
 * The server is faked with an injected fetch so assertions are exact.
 */

const CONFIG: TestConfigInput = {
  name: "sdk test",
  variants: [
    {
      name: "control",
      text: "Buy now",
      html: "<b>Buy now</b>",
      url: "https://example.com/a"
    },
    { name: "variant", text: "Get started" }
  ],
  statsKeyHash: "0".repeat(64)
};

interface FakeServer {
  fetch: typeof fetch;
  chooseCalls: any[];
  rewardCalls: any[];
}

function fakeServer(cell = 1): FakeServer {
  const server: FakeServer = { chooseCalls: [], rewardCalls: [], fetch: null! };
  server.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith("/choose")) {
      server.chooseCalls.push(body);
      // Single-slot fake: the cell IS the variant index of slot 0.
      const hashes: string[] = body?.assets?.[`0:${cell}`] ?? [];
      if (hashes.length === 0) {
        return Response.json({ cell, choice: [cell] });
      }
      return Response.json({
        cell,
        choice: [cell],
        assetSignatures: Object.fromEntries(
          hashes.map((h: string) => [h, `e=99&s=sig-${h.slice(0, 6)}`])
        ),
        assetsExpireAt: Date.now() + 3600_000
      });
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
  sessionStorage.clear();
  pageStorage(window).clear();
  resetStoreRegistry(window);
  document.cookie = "_ga=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  clearDataLayer();
  // Release the page-wide watcher claim an earlier test's tracker took.
  resetAutoTrack(window);
  delete (window as { livevariant?: unknown }).livevariant;
});

describe("assignment", () => {
  it("chooses via the server and exposes the variant formats", async () => {
    const server = fakeServer(1);
    const test = await createTest(CONFIG, options(server));
    expect(test.variant.name).toBe("variant");
    expect(test.variant.text).toBe("Get started");
    expect(server.chooseCalls).toHaveLength(1);
    // Every wire request names its sender's generation, imported
    // straight from package.json so it can never drift.
    expect(server.chooseCalls[0].sdk).toBe(SDK_VERSION);
    test.dispose();
  });

  it("sends only hashes and numbers, never content or raw ids", async () => {
    const server = fakeServer();
    const ctxConfig: TestConfigInput = {
      ...CONFIG,
      ctx: { dims: [{ key: "country" }] }
    };
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

  it("forwards auto dimensions instead of hashing them into the key", async () => {
    // A `from` dimension is filled server-side (only the server sees the
    // request's geo), so it must stay out of the key hashed here. What
    // goes on the wire is the public dimension spec, plus any value the
    // page itself knows, which the server composes the same way it does
    // for an email redirect.
    const server = fakeServer();
    const autoConfig: TestConfigInput = {
      ...CONFIG,
      ctx: {
        dims: [{ key: "country", from: "country" }, { key: "persona" }]
      }
    };
    const test = await createTest(autoConfig, {
      ...options(server),
      externalId: "u-auto",
      context: { country: "nl", persona: "power" }
    });
    const call = server.chooseCalls[0];
    expect(call.autoDims).toEqual([{ key: "country", from: "country" }]);
    expect(call.autoCtx).toEqual({ country: "nl" });
    // The hashed key covers persona alone: country is composed on top of
    // it by the server, for SDK and redirect traffic alike.
    expect(call.ctxKey).toBe(
      await bucketKey(await computeTestId(parseTestConfig(autoConfig)), {
        persona: "power"
      })
    );
    test.dispose();
  });

  it("omits auto fields entirely for a config that declares none", async () => {
    const server = fakeServer();
    const ctxConfig: TestConfigInput = {
      ...CONFIG,
      ctx: { dims: [{ key: "persona" }] }
    };
    const test = await createTest(ctxConfig, {
      ...options(server),
      context: { persona: "power" }
    });
    expect(server.chooseCalls[0].autoDims).toEqual([]);
    expect(server.chooseCalls[0].autoCtx).toBeUndefined();
    test.dispose();
  });

  it("splices minted signatures into hosted-asset formats", async () => {
    // Hosted assets 403 on their canonical URLs; the SDK sends the
    // content hashes (nothing else) and splices the winning arm's fresh
    // signatures into the formats it hands the page.
    const hash = "a".repeat(64);
    const assetConfig: TestConfigInput = {
      ...CONFIG,
      variants: [
        CONFIG.variants![0],
        { name: "hosted", image: `https://livevariant.link/a/${hash}` }
      ]
    };
    const server = fakeServer(1);
    const test = await createTest(assetConfig, {
      ...options(server),
      externalId: "asset-user"
    });
    expect(server.chooseCalls[0].assets).toEqual({ "0:1": [hash] });
    expect(test.variant.image).toBe(
      `https://livevariant.link/a/${hash}?e=99&s=sig-${hash.slice(0, 6)}`
    );
    // Non-asset formats pass through untouched.
    expect(test.variant.text).toBeUndefined();
    test.dispose();
  });

  it("re-asks the server when cached signatures have gone stale", async () => {
    // The assignment cache normally skips the network entirely, but a
    // cached signature that expired renders a broken image. /choose is
    // sticky server-side, so re-asking returns the same arm with fresh
    // signatures.
    const hash = "b".repeat(64);
    const assetConfig: TestConfigInput = {
      ...CONFIG,
      variants: [
        CONFIG.variants![0],
        { name: "hosted", image: `https://livevariant.link/a/${hash}` }
      ]
    };
    const server = fakeServer(1);
    const first = await createTest(assetConfig, {
      ...options(server),
      externalId: "stale-user"
    });
    first.dispose();
    expect(server.chooseCalls).toHaveLength(1);

    // Sabotage the cache: same assignment, expired signatures.
    const cacheKey = `lv:a:${first.testId}`;
    const cached = JSON.parse(sessionStorage.getItem(cacheKey)!);
    cached.assetsExpireAt = Date.now() - 1;
    sessionStorage.setItem(cacheKey, JSON.stringify(cached));

    const second = await createTest(assetConfig, {
      ...options(server),
      externalId: "stale-user"
    });
    expect(server.chooseCalls).toHaveLength(2);
    expect(second.variant.image).toContain("?e=99&s=");
    second.dispose();

    // A plain text test with the same staleness never refetches: only
    // hosted assets need the network again.
    const plain = await createTest(CONFIG, {
      ...options(server),
      externalId: "u1"
    });
    const calls = server.chooseCalls.length;
    plain.dispose();
    const again = await createTest(CONFIG, {
      ...options(server),
      externalId: "u1"
    });
    expect(server.chooseCalls).toHaveLength(calls);
    again.dispose();
  });

  it("caches the assignment for the page and skips the network", async () => {
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

  it("accepts the readable shorthands: bare strings and `variants`", async () => {
    // The documented story: a whole test, legible in page source.
    const server = fakeServer(1);
    const test = await createTest(
      { variants: ["Ship faster", "Ship safer"] },
      options(server, { externalId: "reader" })
    );
    expect(test.variant.text).toBe("Ship safer");
    expect(test.variant.name).toBe("v2");
    expect(server.chooseCalls[0].slotSizes).toEqual([2]);
    test.dispose();
  });

  it("renders the chosen variant per slot for a multi-slot test", async () => {
    const server: FakeServer = {
      chooseCalls: [],
      rewardCalls: [],
      fetch: null!
    };
    server.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      server.chooseCalls.push(JSON.parse(String(init?.body)));
      // 2x2 shape, cell 3 = choice [1, 1] (row-major).
      return Response.json({ cell: 3, choice: [1, 1] });
    }) as typeof fetch;
    const test = await createTest(
      {
        slots: {
          headline: ["A headline", "B headline"],
          cta: ["Buy", "Try"]
        }
      },
      options(server, { externalId: "multi" })
    );
    expect(server.chooseCalls[0].slotSizes).toEqual([2, 2]);
    expect(test.cell).toBe(3);
    // Canonical slot order is sorted: cta first, then headline.
    expect(test.slots.cta.text).toBe("Try");
    expect(test.slots.headline.text).toBe("B headline");
    // `variant` is the first slot's choice.
    expect(test.variant.text).toBe("Try");
    test.dispose();
  });

  it("scopes keyless inline configs to the page's hostname", async () => {
    // Two sites inlining the same trivial test must not share state. The
    // hostname becomes the identity namespace, deterministically, so the
    // same page always reaches the same test.
    const server = fakeServer();
    const inline = { variants: ["Book now", "Book"] };
    const test = await createTest(
      inline,
      options(server, { externalId: "s1" })
    );
    expect(test.testId).toBe(
      await computeTestId(
        parseTestConfig({ ...inline, scope: location.hostname })
      )
    );
    // An explicit scope wins, and a stats key means no injection at all:
    // those configs carry a random hash that already makes them unique,
    // and their URLs were printed with that identity.
    const explicit = await createTest(
      { ...inline, scope: "campaign-7" },
      options(server, { externalId: "s2" })
    );
    expect(explicit.testId).toBe(
      await computeTestId(parseTestConfig({ ...inline, scope: "campaign-7" }))
    );
    const keyed = await createTest(
      CONFIG,
      options(server, { externalId: "s3" })
    );
    expect(keyed.testId).toBe(await computeTestId(parseTestConfig(CONFIG)));
    test.dispose();
    explicit.dispose();
    keyed.dispose();
  });

  it("sends the config's region with choose and reward", async () => {
    const server = fakeServer(1);
    const test = await createTest(
      { ...CONFIG, region: "eu" },
      options(server, { externalId: "eu-user" })
    );
    expect(server.chooseCalls[0].region).toBe("eu");
    await test.trackConversion(2);
    expect(server.rewardCalls[0].region).toBe("eu");
    expect(server.rewardCalls[0].sdk).toBe(SDK_VERSION);
    test.dispose();
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

describe("resilience: the page must render regardless", () => {
  it("renders the control arm when the server errors", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: failing,
      rewardEvents: false
    });
    expect(test.variant.name).toBe("control");
    expect(test.fallback).toBe(true);
    // A transient outage must not pin this visitor to control for good.
    expect(sessionStorage.getItem(`lv:a:${test.testId}`)).toBeNull();
    test.dispose();
  });

  it("renders the control arm when the server is unreachable", async () => {
    const unreachable = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: unreachable,
      rewardEvents: false
    });
    expect(test.variant.name).toBe("control");
    expect(test.fallback).toBe(true);
    test.dispose();
  });

  it("gives up on a hanging server and renders control", async () => {
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })) as unknown as typeof fetch;
    const started = Date.now();
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: hanging,
      rewardEvents: false,
      timeoutMs: 50
    });
    expect(test.variant.name).toBe("control");
    expect(test.fallback).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    test.dispose();
  });

  it("renders control when the server answers with a nonsense cell", async () => {
    const nonsense = (async () =>
      Response.json({ cell: 99, choice: [99] })) as unknown as typeof fetch;
    const test = await createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: nonsense,
      rewardEvents: false
    });
    expect(test.variant.index).toBe(0);
    expect(test.fallback).toBe(true);
    test.dispose();
  });

  it("never rejects from trackConversion", async () => {
    const server = fakeServer();
    const test = await createTest(CONFIG, options(server));
    const flaky = createTest(CONFIG, {
      serverUrl: "https://livevariant.link",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      rewardEvents: false
    });
    const offline = await flaky;
    // A customer may await this inside their own checkout flow.
    await expect(offline.trackConversion(5)).resolves.toBeUndefined();
    test.dispose();
    offline.dispose();
  });
});

describe("external id resolution", () => {
  it("reads the _ga cookie only under the autoIdentify opt-in", async () => {
    document.cookie = "_ga=GA1.1.1234567890.1699999999";
    const server = fakeServer();
    const a = await createTest(CONFIG, options(server, { autoIdentify: true }));
    // Same cookie -> same idHash on a fresh createTest.
    sessionStorage.clear();
    const b = await createTest(CONFIG, options(server, { autoIdentify: true }));
    expect(server.chooseCalls[0].idHash).toBe(server.chooseCalls[1].idHash);
    a.dispose();
    b.dispose();
  });

  it("never touches document.cookie without the opt-in", async () => {
    document.cookie = "_ga=GA1.1.1234567890.1699999999";
    // Counting actual jar accesses, because evaluating document.cookie IS
    // the read whatever happens to the value: a gate that only skips the
    // parse would still have the consent surface.
    const original = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "cookie"
    )!;
    let reads = 0;
    Object.defineProperty(Document.prototype, "cookie", {
      configurable: true,
      get(this: Document) {
        reads++;
        return original.get!.call(this) as string;
      },
      set(this: Document, value: string) {
        original.set!.call(this, value);
      }
    });
    try {
      const server = fakeServer();
      const a = await createTest(CONFIG, options(server));
      expect(reads).toBe(0);
      // Two fresh stores, same cookie present: identities differ,
      // proving the cookie also never influenced the result.
      sessionStorage.clear();
      const b = await createTest(CONFIG, options(server));
      expect(server.chooseCalls[0].idHash).not.toBe(
        server.chooseCalls[1].idHash
      );
      expect(reads).toBe(0);
      // The opt-in is what performs the read.
      sessionStorage.clear();
      const c = await createTest(
        CONFIG,
        options(server, { autoIdentify: true })
      );
      expect(reads).toBeGreaterThan(0);
      a.dispose();
      b.dispose();
      c.dispose();
    } finally {
      Object.defineProperty(Document.prototype, "cookie", original);
    }
  });

  it("parses realistic _ga cookies", () => {
    expect(gaClientId("_ga=GA1.1.123.456")).toBe("123.456");
    expect(gaClientId("foo=bar; _ga=GA1.2.99.11; baz=1")).toBe("99.11");
    expect(gaClientId("foo=bar")).toBeNull();
    expect(gaClientId("_ga=garbage")).toBeNull();
  });

  it("generates an id kept for the tab when nothing else is available", async () => {
    const server = fakeServer();
    (await createTest(CONFIG, options(server))).dispose();
    const generated = sessionStorage.getItem("lv:id");
    expect(generated).toBeTruthy();
    // Session-scoped functional state only: nothing crosses visits.
    expect(localStorage.getItem("lv:id")).toBeNull();
    sessionStorage.removeItem(
      `lv:a:${(await createTest(CONFIG, options(server))).testId}`
    );
    (await createTest(CONFIG, options(server))).dispose();
    // Stable within the tab: same store, same id.
    expect(sessionStorage.getItem("lv:id")).toBe(generated);
  });

  it("persists across visits only when localStorage is opted into", async () => {
    const server = fakeServer();
    const test = await createTest(
      CONFIG,
      options(server, { storage: localStorage })
    );
    test.dispose();
    expect(localStorage.getItem("lv:id")).toBeTruthy();
    expect(localStorage.getItem(`lv:a:${test.testId}`)).toBeTruthy();
    // And nothing leaked into the default store meanwhile.
    expect(sessionStorage.getItem("lv:id")).toBeNull();
  });

  it('"none" mode touches no web storage and still assigns', async () => {
    (window as { livevariant?: unknown }).livevariant = {
      config: { storage: "none" }
    };
    try {
      const server = fakeServer();
      const test = await createTest(CONFIG, options(server));
      expect(test.variant.name).toBeTruthy();
      expect(sessionStorage.getItem("lv:id")).toBeNull();
      expect(localStorage.getItem("lv:id")).toBeNull();
      // The window store is what keeps it sticky for the page.
      expect(pageStorage(window).getItem("lv:id")).toBeTruthy();
      test.dispose();
    } finally {
      delete (window as { livevariant?: unknown }).livevariant;
    }
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

describe("the page-wide global config", () => {
  afterEach(() => {
    delete (window as { livevariant?: unknown }).livevariant;
  });

  it("lets createTest run with no options at all", async () => {
    const server = fakeServer(1);
    (window as { livevariant?: unknown }).livevariant = {
      config: {
        serverUrl: "https://global.example",
        publishableKey: "pk_globalglobalglobalglobal"
      }
    };
    // fetch has to come from somewhere injectable: stash it on the
    // global too? No: the global carries config only. Patch fetch.
    const original = window.fetch;
    window.fetch = server.fetch;
    try {
      const test = await createTest({ ...CONFIG, name: "global config" });
      expect(test.fallback).toBe(false);
      expect(server.chooseCalls[0].publishableKey).toBe(
        "pk_globalglobalglobalglobal"
      );
      expect(test.urls.serve).toContain("https://global.example/s/");
      test.dispose();
    } finally {
      window.fetch = original;
    }
  });

  it("explicit options beat the global", async () => {
    const server = fakeServer(1);
    (window as { livevariant?: unknown }).livevariant = {
      config: {
        serverUrl: "https://global.example",
        publishableKey: "pk_globalglobalglobalglobal"
      }
    };
    const test = await createTest(
      { ...CONFIG, name: "explicit wins" },
      {
        serverUrl: "https://explicit.example",
        publishableKey: "pk_explicitexplicitexplici",
        fetch: server.fetch
      }
    );
    expect(server.chooseCalls[0].publishableKey).toBe(
      "pk_explicitexplicitexplici"
    );
    expect(test.urls.serve).toContain("https://explicit.example/s/");
    test.dispose();
  });

  it("throws a naming error without any server at all", async () => {
    await expect(createTest({ ...CONFIG, name: "no server" })).rejects.toThrow(
      /serverUrl/
    );
  });
});

describe("createTest waits for a late tag", () => {
  afterEach(() => {
    delete (window as { livevariant?: unknown }).livevariant;
  });

  it("uses the global a tag manager sets after page code already ran", async () => {
    // Tag managers inject the tag late; page code calling createTest
    // first must not lose the race.
    setTimeout(() => {
      (window as { livevariant?: unknown }).livevariant = {
        config: { serverUrl: "https://late.example" }
      };
    }, 50);
    const test = await createTest(CONFIG, {
      storage: null,
      fetch: (async () =>
        new Response("nope", { status: 404 })) as unknown as typeof fetch
    });
    // The stubbed server answered (badly), which proves the serverUrl
    // was resolved from the late global rather than throwing.
    expect(test.fallback).toBe(true);
  });

  it("throws past the timeout when no tag ever arrives", async () => {
    await expect(
      createTest(CONFIG, { storage: null, tagWaitMs: 80 })
    ).rejects.toThrow(/serverUrl/);
  });
});
