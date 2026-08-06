import { afterEach, describe, expect, it } from "vitest";
import { bootTag } from "./tag.js";
import { createTest, whenTagReady } from "./index.js";
import { resetAutoTrack } from "./auto-track.js";
import { resetDataLayerInterception } from "./ga.js";

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

  it("rewards stored handoffs on trackConversion with zero page code", async () => {
    // A previous redirect landing left a handoff in storage.
    localStorage.setItem(
      `lv:h:${"t".repeat(64)}`,
      JSON.stringify({
        testId: "t".repeat(64),
        idHash: "i".repeat(64),
        cell: 1
      })
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
      await tag?.sdk.trackConversion();
      expect(rewards).toHaveLength(1);
      expect((rewards[0] as { testId: string }).testId).toBe("t".repeat(64));
    } finally {
      window.fetch = original;
    }
  });

  it("rewards cached inline assignments too, skipping noAuto ones", async () => {
    // Two npm-created tests left assignments in the shared cache; one
    // opted out of automatic rewarding (rewardEvents: false).
    localStorage.setItem(
      `lv:a:${"a".repeat(64)}`,
      JSON.stringify({ cell: 2, idHash: "x".repeat(64), region: "eu" })
    );
    localStorage.setItem(
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
