import { describe, expect, it } from "vitest";
import { mulberry32, sampleBeta, sampleGaussian } from "./rng.js";

describe("rng", () => {
  it("is deterministic per seed", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("beta sampler matches the analytic mean", () => {
    const rng = mulberry32(3);
    const draws = 5000;
    let sum = 0;
    for (let i = 0; i < draws; i++) {
      sum += sampleBeta(3, 7, rng);
    }
    expect(sum / draws).toBeCloseTo(0.3, 1);
  });

  it("gaussian sampler is roughly standard normal", () => {
    const rng = mulberry32(9);
    const draws = 5000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < draws; i++) {
      const x = sampleGaussian(rng);
      sum += x;
      sumSq += x * x;
    }
    const mean = sum / draws;
    expect(mean).toBeCloseTo(0, 1);
    expect(sumSq / draws - mean * mean).toBeCloseTo(1, 1);
  });
});
