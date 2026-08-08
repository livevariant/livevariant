import { describe, expect, it } from "vitest";
import {
  cellNames,
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
