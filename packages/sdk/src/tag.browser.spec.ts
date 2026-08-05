import { afterEach, describe, expect, it } from "vitest";
import { bootTag } from "./tag.js";
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
  const tag = (window as { livevariant?: { dispose?: () => void } })
    .livevariant;
  tag?.dispose?.();
  delete (window as { livevariant?: unknown }).livevariant;
  resetDataLayerInterception(window);
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
    expect(tag?.serverUrl).toBe("https://deploy.example");
    expect(tag?.publishableKey).toBe("pk_tagtagtagtagtagtagtagta");
    const globalTag = (window as { livevariant?: { createTest?: unknown } })
      .livevariant;
    expect(typeof globalTag?.createTest).toBe("function");
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
      await tag?.trackConversion();
      expect(rewards).toHaveLength(1);
      expect((rewards[0] as { testId: string }).testId).toBe("t".repeat(64));
    } finally {
      window.fetch = original;
    }
  });

  it("a preset window.livevariant wins over attributes", () => {
    (window as { livevariant?: unknown }).livevariant = {
      serverUrl: "https://preset.example"
    };
    const script = scriptWith({
      src: "https://deploy.example/sdk.js",
      "data-publishable-key": "pk_tagtagtagtagtagtagtagta"
    });
    const tag = bootTag(window, script);
    expect(tag?.serverUrl).toBe("https://preset.example");
  });
});
