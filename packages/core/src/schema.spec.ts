import { describe, expect, it } from "vitest";
import {
  cellNames,
  clickTarget,
  destinationUrls,
  hasPerElementDestinations,
  slotEntries,
  slotSizes,
  parseTestConfig,
  variantName
} from "./schema.js";

/**
 * The v2 config: slots-native, readable, and free of algorithm knobs.
 */
const KH = "0".repeat(64);

describe("authoring sugar", () => {
  it("turns `variants` into a single main slot", () => {
    const config = parseTestConfig({
      variants: [{ text: "A" }, { text: "B" }],
      statsKeyHash: KH
    });
    expect(Object.keys(config.slots)).toEqual(["main"]);
    expect(config.v).toBe(2);
  });

  it("reads bare strings as text or destination", () => {
    // The most readable spelling of the common cases: an example in the
    // docs should not need a single object literal.
    const config = parseTestConfig({
      variants: ["Ship faster", "https://example.com/b"],
      statsKeyHash: KH
    });
    expect(config.slots.main[0]).toEqual({ text: "Ship faster" });
    expect(config.slots.main[1]).toEqual({ url: "https://example.com/b" });
  });

  it("has no algorithm to configure, by design", () => {
    // Users describe what to test; the model is our job. An alg field is
    // silently dropped rather than honored.
    const config = parseTestConfig({
      variants: ["A", "B"],
      alg: "bucketed",
      statsKeyHash: KH
    }) as Record<string, unknown>;
    expect(config.alg).toBeUndefined();
  });
});

describe("slots", () => {
  it("orders slots canonically by key, whatever the input order", () => {
    // Cell indices are defined against this order and canonical JSON
    // sorts keys, so it must survive serialization.
    const config = parseTestConfig({
      slots: { hero: ["A", "B"], cta: ["X", "Y", "Z"] },
      statsKeyHash: KH
    });
    expect(slotEntries(config).map(([k]) => k)).toEqual(["cta", "hero"]);
    expect(slotSizes(config)).toEqual([3, 2]);
  });

  it("requires at least two combinations", () => {
    expect(() =>
      parseTestConfig({ slots: { main: ["only"] }, statsKeyHash: KH })
    ).toThrow(/two combinations/);
  });

  it("caps the combination space", () => {
    // Cells are enumerated and counted; an unbounded product would be
    // unlearnable anyway.
    expect(() =>
      parseTestConfig({
        slots: {
          a: Array.from({ length: 9 }, (_, i) => `a${i}`),
          b: Array.from({ length: 9 }, (_, i) => `b${i}`),
          c: Array.from({ length: 9 }, (_, i) => `c${i}`)
        },
        statsKeyHash: KH
      })
    ).toThrow(/512-cell limit/);
  });

  it("rejects a variant with no content at all", () => {
    expect(() =>
      parseTestConfig({
        variants: [{ name: "empty" }, "B"],
        statsKeyHash: KH
      })
    ).toThrow(/url, image, html, md or text/);
  });
});

describe("priors", () => {
  it("must name real slots with matching arity", () => {
    const base = { slots: { hero: ["A", "B"] }, statsKeyHash: KH };
    expect(() =>
      parseTestConfig({
        ...base,
        priors: { cta: [{ mean: 0.1, strength: 10 }] }
      })
    ).toThrow(/does not exist/);
    expect(() =>
      parseTestConfig({
        ...base,
        priors: { hero: [{ mean: 0.1, strength: 10 }] }
      })
    ).toThrow(/2 variants but 1 priors/);
  });
});

describe("click destinations", () => {
  const config = parseTestConfig({
    slots: {
      hero: ["https://a.example/1", "https://a.example/2"],
      cta: [
        { url: "https://a.example/3" },
        { url: "https://a.example/4", redirectUrl: "https://own.example/x" }
      ]
    },
    slotRedirects: { hero: "https://lp.example/campaign" },
    redirectUrl: "https://lp.example/home",
    statsKeyHash: KH
  });

  it("resolves to: then variant, then slot, then test", () => {
    // One precedence, in one function, because the click route, the
    // trust check and the tools must not each invent their own.
    expect(
      clickTarget(config, "cta", config.slots.cta[1], "https://to.example/q")
    ).toBe("https://to.example/q");
    expect(clickTarget(config, "cta", config.slots.cta[1])).toBe(
      "https://own.example/x"
    );
    expect(clickTarget(config, "hero", config.slots.hero[0])).toBe(
      "https://lp.example/campaign"
    );
    expect(clickTarget(config, "cta", config.slots.cta[0])).toBe(
      "https://lp.example/home"
    );
  });

  it("knows when a click has to name its element", () => {
    expect(hasPerElementDestinations(config)).toBe(true);
    const uniform = parseTestConfig({
      variants: ["https://a.example/1", "https://a.example/2"],
      redirectUrl: "https://lp.example/home",
      statsKeyHash: KH
    });
    expect(hasPerElementDestinations(uniform)).toBe(false);
    const slotOnly = parseTestConfig({
      slots: { hero: ["https://a.example/1", "https://a.example/2"] },
      slotRedirects: { hero: "https://lp.example/campaign" },
      statsKeyHash: KH
    });
    expect(hasPerElementDestinations(slotOnly)).toBe(true);
  });

  it("enumerates every place a visitor can be sent", () => {
    // Trust checks read this list; a destination missing from it is a
    // destination nothing verified.
    expect(destinationUrls(config)).toContain("https://lp.example/campaign");
    expect(destinationUrls(config)).toContain("https://own.example/x");
    expect(destinationUrls(config)).toContain("https://lp.example/home");
  });

  it("must name a slot that exists", () => {
    expect(() =>
      parseTestConfig({
        slots: { hero: ["A", "B"] },
        slotRedirects: { cta: "https://lp.example/x" },
        statsKeyHash: KH
      })
    ).toThrow(/does not exist/);
  });
});

describe("names", () => {
  it("defaults readable per-slot names", () => {
    const config = parseTestConfig({
      slots: { cta: ["X", { name: "hero-b", text: "B" }] },
      statsKeyHash: KH
    });
    expect(variantName(config.slots.cta[0], 0)).toBe("v1");
    expect(cellNames(config, [1])).toEqual({ cta: "hero-b" });
  });
});
