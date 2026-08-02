import { describe, expect, it } from "vitest";
import {
  CONFIG_HARD_LIMIT,
  computeTestId,
  decodeConfig,
  encodeConfig
} from "./codec.js";
import { hashStatsSecret, verifyStatsSecret } from "./secret.js";
import { testConfigSchema, type TestConfigInput } from "./schema.js";

const statsKeyHash = "0".repeat(64);

function baseConfig(): TestConfigInput {
  return {
    v: 1,
    name: "hero test",
    arms: [
      { name: "control", formats: { url: "https://example.com/a" } },
      { name: "variant", formats: { url: "https://example.com/b" } }
    ],
    statsKeyHash
  };
}

describe("codec", () => {
  it("round-trips a config", async () => {
    const { encoded, testId } = await encodeConfig(baseConfig());
    const decoded = await decodeConfig(encoded);
    expect(decoded.testId).toBe(testId);
    expect(decoded.config.arms[1].name).toBe("variant");
    expect(decoded.config.alg).toBe("ts"); // default applied
  });

  it("computes a stable, fixture-pinned testId", async () => {
    // Pinned on purpose: if this changes, every existing test URL in the
    // wild would silently detach from its state. Never update this value
    // without a migration story.
    const { testId } = await encodeConfig(baseConfig());
    expect(testId).toBe(
      "a94659afd6d112044ccb0eb96ecd3132b08bbe28c8a0d3748220d2a3ec787cdd"
    );
  });

  it("keeps identity stable across alg/prior tuning", async () => {
    const tuned: TestConfigInput = {
      ...baseConfig(),
      alg: "bucketed",
      ctx: { dims: [{ key: "device" }] },
      priors: {
        arms: [
          { alpha: 8, beta: 2 },
          { alpha: 2, beta: 8 }
        ]
      },
      priorStrengthCap: 10,
      minBucketPulls: 5
    };
    // ctx IS identity-relevant, so compare tuned vs tuned-minus-tuning.
    const withCtx: TestConfigInput = {
      ...baseConfig(),
      ctx: { dims: [{ key: "device" }] }
    };
    expect(await computeTestId(testConfigSchema.parse(tuned))).toBe(
      await computeTestId(testConfigSchema.parse(withCtx))
    );
  });

  it("changes identity when arms change", async () => {
    const a = await encodeConfig(baseConfig());
    const b = await encodeConfig({
      ...baseConfig(),
      arms: [
        { name: "control", formats: { url: "https://example.com/a" } },
        { name: "variant", formats: { url: "https://example.com/CHANGED" } }
      ]
    });
    expect(a.testId).not.toBe(b.testId);
  });

  it("is insensitive to key order", async () => {
    const shuffled = {
      statsKeyHash,
      arms: baseConfig().arms,
      name: "hero test",
      v: 1
    } as TestConfigInput;
    expect(await computeTestId(testConfigSchema.parse(shuffled))).toBe(
      await computeTestId(testConfigSchema.parse(baseConfig()))
    );
  });

  it("rejects configs above the hard size limit", async () => {
    const big: TestConfigInput = {
      ...baseConfig(),
      arms: [
        { name: "a", formats: { html: "x".repeat(CONFIG_HARD_LIMIT) } },
        { name: "b", formats: { url: "https://example.com/b" } }
      ]
    };
    await expect(encodeConfig(big)).rejects.toThrow(/host large HTML/);
  });

  it("warns above the soft limit", async () => {
    const chunky: TestConfigInput = {
      ...baseConfig(),
      arms: [
        { name: "a", formats: { html: "x".repeat(2500) } },
        { name: "b", formats: { url: "https://example.com/b" } }
      ]
    };
    const { warnings } = await encodeConfig(chunky);
    expect(warnings).toHaveLength(1);
  });

  it("rejects bucketed/linear without ctx", () => {
    expect(() =>
      testConfigSchema.parse({ ...baseConfig(), alg: "linear" })
    ).toThrow(/requires a ctx/);
  });

  it("rejects prior arrays with the wrong arity", () => {
    expect(() =>
      testConfigSchema.parse({
        ...baseConfig(),
        priors: { arms: [{ alpha: 1, beta: 1 }] }
      })
    ).toThrow(/one entry per arm/);
  });

  it("rejects malformed encodings", async () => {
    await expect(decodeConfig("not-a-config")).rejects.toThrow(
      /not a valid base64url/
    );
  });
});

describe("stats secret", () => {
  it("verifies the right secret and rejects the wrong one", async () => {
    const hash = await hashStatsSecret("s3cret");
    expect(await verifyStatsSecret("s3cret", hash)).toBe(true);
    expect(await verifyStatsSecret("nope", hash)).toBe(false);
  });
});
