/**
 * Seeded RNG and the distribution samplers the bandits need. Everything is
 * injected (never Math.random) so simulations and tests are deterministic.
 */

/** Returns a uniform draw in [0, 1). */
export type Rng = () => number;

/** mulberry32: tiny, fast, good-enough PRNG for bandit sampling. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0];
}

/** Standard normal via Box-Muller. */
export function sampleGaussian(rng: Rng): number {
  let u = 0;
  while (u === 0) {
    u = rng(); // avoid log(0)
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Gamma(shape, 1) via Marsaglia-Tsang, with the shape<1 boost. */
export function sampleGamma(shape: number, rng: Rng): number {
  if (shape < 1) {
    return (
      sampleGamma(shape + 1, rng) * Math.pow(rng() || Number.EPSILON, 1 / shape)
    );
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleGaussian(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) {
      return d * v;
    }
    if (u > 0 && Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** Beta(alpha, beta) as the ratio of two gammas. */
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const a = sampleGamma(alpha, rng);
  const b = sampleGamma(beta, rng);
  return a / (a + b);
}
