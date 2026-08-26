import { afterEach, describe, expect, it } from "vitest";
import { encodeConfig } from "@livevariant/core";
import { bootTag } from "./tag.js";
import { createTest, whenTagReady } from "./index.js";
import { resetAutoTrack } from "./auto-track.js";
import { resetDataLayerInterception } from "./ga.js";
import { pageStorage, resetStoreRegistry } from "./page-store.js";

/**
 * The tag is the reward-only install: a script element, no page code.
 * These tests drive bootTag with real DOM script elements.
 */

function scriptWith(attrs: Record<string, string>): HTMLScriptElement {
  const script = document.createElement("script");
  for (const [key, value] of Object.entries(attrs)) {
    script.setAttribute(key, value);
  }
  document.head.appendChild(script);
  return script;
}

afterEach(() => {
  const tag = (window as { livevariant?: { sdk?: { dispose?: () => void } } })
    .livevariant;
  tag?.sdk?.dispose?.();
  delete (window as { livevariant?: unknown }).livevariant;
  resetAutoTrack(window);
  resetDataLayerInterception(window);
  delete (window as { dataLayer?: unknown }).dataLayer;
  document
    .querySelectorAll("script[data-publishable-key]")
    .forEach(el => el.remove());
  localStorage.clear();
  pageStorage(window).clear();
  resetStoreRegistry(window);
});

describe("the tag", () => {
  it("configures itself from its own script element and src origin", () => {
    const script = scriptWith({
      src: "https://deploy.example/sdk.js",
      "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
    });
    const tag = bootTag(window, script);
    expect(tag?.config.serverUrl).toBe("https://deploy.example");
    expect(tag?.config.publishableKey).toBe("pk_tagtagtagtagtagtagtagta");
    // The callable surface for pages without an npm install.
    const globalTag = (
      window as { livevariant?: { sdk?: { createTest?: unknown } } }
    ).livevariant;
    expect(typeof globalTag?.sdk?.createTest).toBe("function");
  });

  it("rewards a redirect handoff captured from the landing URL, zero page code", async () => {
    // The visitor just arrived through /c: the URL carries the handoff,
    // the tag captures it into the page store and cleans the address
    // bar, and the conversion this pageview rewards it.
    const testId = "c".repeat(64);
    const landing = window.location.pathname + window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?_lvt=${testId}&_lvid=${"d".repeat(64)}&_lvvar=1`
    );
    const rewards: unknown[] = [];
    const original = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reward")) {
        rewards.push(JSON.parse(String(init?.body)));
        return Response.json({ rewarded: true, first: true });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const script = scriptWith({
        src: "https://deploy.example/sdk.js",
        "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
      });
      const tag = bootTag(window, script);
      // Captured and cleaned: the params are gone from the address bar.
      expect(window.location.search).not.toContain("_lvt");
      await tag?.sdk.trackConversion();
      expect(rewards).toHaveLength(1);
      expect((rewards[0] as { testId: string }).testId).toBe(testId);
    } finally {
      window.fetch = original;
      window.history.replaceState(window.history.state, "", landing);
    }
  });

  it('data-storage="local" opts the deployment into persistence', async () => {
    const testId = "e5".repeat(32);
    const landing = window.location.pathname + window.location.hash;
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}?_lvt=${testId}&_lvid=${"a1".repeat(32)}&_lvvar=0`
    );
    try {
      const tag = bootTag(
        window,
        scriptWith({
          src: "https://deploy.example/sdk.js",
          "data-publishable-key": "pk_tagtagtagtagtagtagtagta",
          "data-storage": "local"
        })
      );
      // The handoff went to localStorage, surviving navigation, and the
      // mode rides on tag.config so npm createTest calls follow it.
      expect(localStorage.getItem(`lv:h:${testId}`)).toBeTruthy();
      expect(tag?.config.storage).toBe("local");
    } finally {
      window.history.replaceState(window.history.state, "", landing);
      localStorage.removeItem(`lv:h:${testId}`);
    }
  });

  it("rewards cached inline assignments too, skipping noAuto ones", async () => {
    // Two npm-created tests on this page left assignments in the shared
    // page store; one opted out of automatic rewarding (rewardEvents:
    // false). Cross-bundle: the npm SDK wrote, the tag reads.
    pageStorage(window).setItem(
      `lv:a:${"a".repeat(64)}`,
      JSON.stringify({ cell: 2, idHash: "x".repeat(64), region: "eu" })
    );
    pageStorage(window).setItem(
      `lv:a:${"b".repeat(64)}`,
      JSON.stringify({ cell: 0, idHash: "y".repeat(64), noAuto: true })
    );
    const rewards: { testId: string; region?: string }[] = [];
    const original = window.fetch;
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/reward")) {
        rewards.push(
          JSON.parse(String(init?.body)) as { testId: string; region?: string }
        );
        return Response.json({ rewarded: true, first: true });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    try {
      const script = scriptWith({
        src: "https://deploy.example/sdk.js",
        "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
      });
      bootTag(window, script);
      // The tag's GA watcher is the page's ONE rewarder.
      const layered = window as Window & { dataLayer?: unknown[] };
      layered.dataLayer = layered.dataLayer || [];
      layered.dataLayer.push({ event: "purchase", value: 9 });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(rewards).toHaveLength(1);
      expect(rewards[0].testId).toBe("a".repeat(64));
      expect(rewards[0].region).toBe("eu");
    } finally {
      window.fetch = original;
    }
  });

  it("adds no second watcher when page code already claimed one", async () => {
    // npm SDK ran first (createTest with storage): its page tracker
    // holds the claim. The tag booting later must not double-reward.
    const rewards: unknown[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/choose")) {
        return Response.json({ cell: 1, choice: [1] });
      }
      if (url.endsWith("/reward")) {
        rewards.push(JSON.parse(String(init?.body)));
        return Response.json({ rewarded: true, first: true });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const test = await createTest(
      { name: "inline", variants: ["a", "b"] },
      { serverUrl: "https://deploy.example", fetch: fakeFetch }
    );
    const original = window.fetch;
    window.fetch = fakeFetch;
    try {
      const script = scriptWith({
        src: "https://deploy.example/sdk.js",
        "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
      });
      bootTag(window, script);
      const layered = window as Window & { dataLayer?: unknown[] };
      layered.dataLayer = layered.dataLayer || [];
      layered.dataLayer.push({ event: "purchase" });
      await new Promise(resolve => setTimeout(resolve, 10));
      // One event, one participation, ONE reward: not one per bundle.
      expect(rewards).toHaveLength(1);
      expect((rewards[0] as { testId: string }).testId).toBe(test.testId);
    } finally {
      window.fetch = original;
      test.dispose();
    }
  });

  it("a preset window.livevariant config wins over attributes", () => {
    (window as { livevariant?: unknown }).livevariant = {
      config: { serverUrl: "https://preset.example" }
    };
    const script = scriptWith({
      src: "https://deploy.example/sdk.js",
      "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
    });
    const tag = bootTag(window, script);
    expect(tag?.config.serverUrl).toBe("https://preset.example");
    expect(tag?.config.publishableKey).toBe("pk_tagtagtagtagtagtagtagta");
  });
});

describe("media decoration", () => {
  async function encoded(): Promise<{ encoded: string; testId: string }> {
    return encodeConfig({
      v: 2,
      name: "embedded image test",
      variants: [
        { name: "a", image: "https://cdn.example/a.png" },
        { name: "b", image: "https://cdn.example/b.png" }
      ]
    } as never);
  }

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attrs: Record<string, string>
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      node.setAttribute(key, value);
    }
    document.body.appendChild(node);
    return node;
  }

  async function until(check: () => boolean, ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error("condition never became true");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  afterEach(() => {
    document
      .querySelectorAll("img[src], img[data-lv-src], a[href]")
      .forEach(node => node.remove());
  });

  it("upgrades bare serve images and click links with the SDK id", async () => {
    const { encoded: cfg } = await encoded();
    const img = el("img", { src: `https://deploy.example/s/${cfg}` });
    const link = el("a", { href: `https://deploy.example/c/${cfg}` });
    const foreign = el("img", { src: `https://other.example/s/${cfg}` });
    const already = el("img", {
      src: `https://deploy.example/s/${cfg}?id=explicit`
    });
    bootTag(
      window,
      (() => {
        const script = document.createElement("script");
        script.setAttribute("src", "https://deploy.example/sdk.js");
        script.setAttribute(
          "data-publishable-key",
          "pk_tagtagtagtagtagtagtagta"
        );
        document.head.appendChild(script);
        return script;
      })()
    );
    await until(() => img.src.includes("id="));
    const assigned = new URL(img.src).searchParams.get("id")!;
    expect(assigned.length).toBeGreaterThan(0);
    // The click link carries the SAME identity: one visitor, one record.
    await until(() => link.href.includes("id="));
    expect(new URL(link.href).searchParams.get("id")).toBe(assigned);
    // Foreign servers and already-identified URLs are left alone.
    expect(foreign.src).toBe(`https://other.example/s/${cfg}`);
    expect(new URL(already.src).searchParams.get("id")).toBe("explicit");
  });

  it("prefers a stored handoff for the SAME test: email keeps its variant", async () => {
    const { encoded: cfg, testId } = await encoded();
    pageStorage(window).setItem(
      `lv:h:${testId}`,
      JSON.stringify({
        testId,
        idHash: "f".repeat(64),
        cell: 1,
        capturedAt: Date.now()
      })
    );
    const img = el("img", { src: `https://deploy.example/s/${cfg}` });
    bootTag(
      window,
      (() => {
        const script = document.createElement("script");
        script.setAttribute("src", "https://deploy.example/sdk.js");
        script.setAttribute(
          "data-publishable-key",
          "pk_tagtagtagtagtagtagtagta"
        );
        document.head.appendChild(script);
        return script;
      })()
    );
    await until(() => img.src.includes("_lvid="));
    expect(new URL(img.src).searchParams.get("_lvid")).toBe("f".repeat(64));
  });

  it("replays handoffs for servers mounted under a path prefix", async () => {
    const { encoded: cfg, testId } = await encoded();
    pageStorage(window).setItem(
      `lv:h:${testId}`,
      JSON.stringify({
        testId,
        idHash: "e".repeat(64),
        cell: 0,
        capturedAt: Date.now()
      })
    );
    (window as { livevariant?: unknown }).livevariant = {
      config: { serverUrl: "https://deploy.example/lv" }
    };
    const img = el("img", { src: `https://deploy.example/lv/s/${cfg}` });
    bootTag(
      window,
      (() => {
        const script = document.createElement("script");
        script.setAttribute("src", "https://deploy.example/lv/sdk.js");
        script.setAttribute(
          "data-publishable-key",
          "pk_tagtagtagtagtagtagtagta"
        );
        document.head.appendChild(script);
        return script;
      })()
    );
    await until(() => img.src.includes("_lvid="));
    expect(new URL(img.src).searchParams.get("_lvid")).toBe("e".repeat(64));
  });

  it("fills data-lv-src images with one identified fetch", async () => {
    const { encoded: cfg } = await encoded();
    const img = el("img", {
      "data-lv-src": `https://deploy.example/s/${cfg}`
    });
    expect(img.getAttribute("src")).toBeNull();
    bootTag(
      window,
      (() => {
        const script = document.createElement("script");
        script.setAttribute("src", "https://deploy.example/sdk.js");
        script.setAttribute(
          "data-publishable-key",
          "pk_tagtagtagtagtagtagtagta"
        );
        document.head.appendChild(script);
        return script;
      })()
    );
    await until(() => img.src.includes("id="));
    expect(img.src.startsWith(`https://deploy.example/s/${cfg}`)).toBe(true);
  });
});

describe("whenTagReady", () => {
  it("returns an already-present global without waiting", async () => {
    const win = {
      livevariant: { config: { serverUrl: "https://now.example" } }
    } as unknown as Window;
    const tag = await whenTagReady({ win, timeoutMs: 1000 });
    expect(tag?.config?.serverUrl).toBe("https://now.example");
  });

  it("resolves as soon as the tag's global appears", async () => {
    const win = {} as Window & {
      livevariant?: { config?: { serverUrl?: string } };
    };
    const pending = whenTagReady({ win, timeoutMs: 2000, pollMs: 10 });
    setTimeout(() => {
      win.livevariant = { config: { serverUrl: "https://late.example" } };
    }, 60);
    const tag = await pending;
    expect(tag?.config?.serverUrl).toBe("https://late.example");
  });

  it("gives up with null once the timeout passes", async () => {
    const tag = await whenTagReady({
      win: {} as Window,
      timeoutMs: 80,
      pollMs: 10
    });
    expect(tag).toBeNull();
  });
});
