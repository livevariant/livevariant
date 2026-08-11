import { describe, expect, it } from "vitest";
import { ctxVariantFeature, newModel } from "./model.js";
import { featureIndices } from "./context.js";
import { effectivePriors } from "./priors.js";
import { parseTestConfig } from "./schema.js";

const DIM = 64;

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
    const priors = effectivePriors(config, DIM);
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
    const priors = effectivePriors(config, DIM);
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
    expect(effectivePriors(bare, DIM)).toEqual([]);
  });

  it("puts a conditioned prior on the segment's own interaction feature", () => {
    // The point of the whole feature: "image B is the one for the blue
    // segment" is a belief about an interaction, and writing it to the
    // variant's main effect would say it about everybody instead.
    const conditioned = parseTestConfig({
      variants: ["A", "B"],
      ctx: { dims: [{ key: "color", values: ["blauw", "rood"] }] },
      ctxPriors: [
        {
          when: { color: "blauw" },
          priors: {
            main: [
              { mean: 0.02, strength: 10 },
              { mean: 0.2, strength: 10 }
            ]
          }
        }
      ],
      statsKeyHash: "0".repeat(64)
    });
    const priors = effectivePriors(conditioned, DIM);
    const expected = featureIndices({ color: "blauw" }, DIM).filter(
      f => f !== 0
    );
    expect(expected).toHaveLength(1);
    expect(priors).toHaveLength(2);
    for (const prior of priors) {
      expect(prior.ctxFeatIdx).toEqual(expected);
    }

    // And the model writes it where the blue segment's traffic will land.
    const model = newModel(DIM, priors);
    const feature = ctxVariantFeature(DIM, expected[0], 0, 1);
    expect(model.b[feature]).toBeCloseTo(10 * 0.2);
  });

  it("caps a conditioned prior exactly like an unconditioned one", () => {
    const shouty = parseTestConfig({
      variants: ["A", "B"],
      ctx: { dims: [{ key: "color", values: ["blauw", "rood"] }] },
      priorStrengthCap: 25,
      ctxPriors: [
        {
          when: { color: "blauw" },
          priors: {
            main: [
              { mean: 0.5, strength: 900 },
              { mean: 0.5, strength: 0 }
            ]
          }
        }
      ],
      statsKeyHash: "0".repeat(64)
    });
    const priors = effectivePriors(shouty, DIM);
    expect(priors).toHaveLength(1);
    expect(priors[0].strength).toBe(25);
  });

  it("leaves the test id alone, so a warm start never resets history", async () => {
    const { computeTestId } = await import("./codec.js");
    const base = {
      variants: ["A", "B"],
      ctx: { dims: [{ key: "color", values: ["blauw", "rood"] }] },
      statsKeyHash: "0".repeat(64)
    };
    const before = await computeTestId(parseTestConfig(base));
    const after = await computeTestId(
      parseTestConfig({
        ...base,
        ctxPriors: [
          {
            when: { color: "blauw" },
            priors: {
              main: [
                { mean: 0.1, strength: 5 },
                { mean: 0.3, strength: 5 }
              ]
            }
          }
        ]
      })
    );
    expect(after).toBe(before);
  });
});
