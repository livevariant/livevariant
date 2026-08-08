import { describe, expect, it } from "vitest";
import { effectivePriors } from "./priors.js";
import { parseTestConfig } from "./schema.js";

describe("effectivePriors", () => {
  const config = parseTestConfig({
    slots: { hero: ["A", "B"], cta: ["X", "Y"] },
    priors: {
      hero: [
        { mean: 0.05, strength: 20 },
        { mean: 0.1, strength: 500 }
      ],
      cta: [
        { mean: 0.02, strength: 0 },
        { mean: 0.08, strength: 30 }
      ]
    },
    statsKeyHash: "0".repeat(64)
  });

  it("maps slot keys to canonical slot indices", () => {
    const priors = effectivePriors(config);
    // Canonical order is sorted: cta = slot 0, hero = slot 1.
    expect(priors).toContainEqual({
      slot: 0,
      variant: 1,
      mean: 0.08,
      strength: 30
    });
    expect(priors.find(p => p.slot === 1 && p.variant === 0)?.mean).toBe(0.05);
  });

  it("caps strength and drops zero-strength entries", () => {
    // The cap is the whole design: a confident wrong guess costs a little
    // early traffic, never the test.
    const priors = effectivePriors(config);
    expect(priors.find(p => p.slot === 1 && p.variant === 1)?.strength).toBe(
      50
    );
    expect(priors.some(p => p.slot === 0 && p.variant === 0)).toBe(false);
  });

  it("returns nothing when the config has no priors", () => {
    const bare = parseTestConfig({
      variants: ["A", "B"],
      statsKeyHash: "0".repeat(64)
    });
    expect(effectivePriors(bare)).toEqual([]);
  });
});
