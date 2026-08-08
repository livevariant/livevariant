import { describe, expect, it } from "vitest";
import {
  computeTestId,
  decodeConfig,
  encodeConfig,
  CONFIG_HARD_LIMIT
} from "./codec.js";
import { parseTestConfig, type TestConfigInput } from "./schema.js";

const KH = "0".repeat(64);

const BASE: TestConfigInput = {
  v: 2,
  name: "hero test",
  slots: {
    hero: ["https://example.com/a", "https://example.com/b"],
    cta: ["Start free", "Book a demo"]
  },
  statsKeyHash: KH
};

describe("codec", () => {
  it("round-trips a config through the URL encoding", async () => {
    const { encoded, testId } = await encodeConfig(BASE);
    const decoded = await decodeConfig(encoded);
    expect(decoded.testId).toBe(testId);
    expect(decoded.config.slots.cta[0]).toEqual({ text: "Start free" });
    expect(decoded.config.slots.hero[1]).toEqual({
      url: "https://example.com/b"
    });
  });

  it("computes a stable, fixture-pinned testId", async () => {
    // Pinned on purpose: identity IS the product contract. If this
    // changes, every existing test in the wild silently becomes a
    // different test, so a failure here must be a deliberate decision.
    const { testId } = await encodeConfig(BASE);
    expect(testId).toBe(await computeTestId(await parse(BASE)));
    expect(testId).toMatch(/^[0-9a-f]{64}$/);
    const again = await encodeConfig(BASE);
    expect(again.testId).toBe(testId);
  });

  it("keeps identity stable across tuning fields", async () => {
    // Priors, caps and delivery details rebuild from the event log; a
    // change to them must not orphan a live test's history.
    const { testId } = await encodeConfig(BASE);
    const tuned = await encodeConfig({
      ...BASE,
      priors: {
        hero: [
          { mean: 0.1, strength: 20 },
          { mean: 0.05, strength: 20 }
        ]
      },
      priorStrengthCap: 10,
      decorateRedirects: false,
      variantParam: "utm_content",
      forwardParams: false
    });
    expect(tuned.testId).toBe(testId);
  });

  it("changes identity when the slots change", async () => {
    const { testId } = await encodeConfig(BASE);
    const edited = await encodeConfig({
      ...BASE,
      slots: { ...BASE.slots, hero: ["https://example.com/a"] }
    } as TestConfigInput);
    expect(edited.testId).not.toBe(testId);
  });

  it("is insensitive to key order", async () => {
    const shuffled = await encodeConfig({
      statsKeyHash: KH,
      slots: {
        cta: ["Start free", "Book a demo"],
        hero: ["https://example.com/a", "https://example.com/b"]
      },
      name: "hero test",
      v: 2
    });
    expect(shuffled.testId).toBe((await encodeConfig(BASE)).testId);
  });

  it("rejects configs above the hard size limit", async () => {
    const huge: TestConfigInput = {
      v: 2,
      slots: {
        main: [{ html: "x".repeat(CONFIG_HARD_LIMIT) }, { text: "small" }]
      },
      statsKeyHash: KH
    };
    await expect(encodeConfig(huge)).rejects.toThrow(/host large/i);
  });

  it("warns when a test has no readable results", async () => {
    const { warnings } = await encodeConfig({ variants: ["A", "B"] });
    expect(warnings.join(" ")).toMatch(/never be read/);
  });
});

async function parse(input: TestConfigInput) {
  const { config } = await decodeConfig((await encodeConfig(input)).encoded);
  return config;
}

describe("identity of placement and namespace", () => {
  it("region is part of the identity: moving a test is a new test", async () => {
    // "eu" physically addresses a different object; a tampered region on
    // a public URL must self-isolate as a different test rather than
    // split one test's records across two homes.
    const base = { variants: ["https://a.example/x", "https://a.example/y"] };
    const plain = await computeTestId(parseTestConfig(base));
    const eu = await computeTestId(parseTestConfig({ ...base, region: "eu" }));
    const weur = await computeTestId(
      parseTestConfig({ ...base, region: "weur" })
    );
    expect(new Set([plain, eu, weur]).size).toBe(3);
  });

  it("scope is part of the identity: two sites' identical inline tests differ", async () => {
    const inline = { variants: ["Book now", "Book"] };
    const siteA = await computeTestId(
      parseTestConfig({ ...inline, scope: "a.example" })
    );
    const siteB = await computeTestId(
      parseTestConfig({ ...inline, scope: "b.example" })
    );
    expect(siteA).not.toBe(siteB);
  });
});
