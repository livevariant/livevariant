import { encodeConfig } from "@livevariant/core";
import { describe, expect, it } from "vitest";
import { resolveTest } from "./resolve.js";

/**
 * An assistant is handed a link out of an email template or an address
 * bar, so what these accept is the difference between a working product
 * and one that feels broken.
 */

const config = { slots: { hero: ["https://x.test/a", "https://x.test/b"] } };

describe("resolveTest", () => {
  it("takes a bare encoded config", async () => {
    const { encoded } = await encodeConfig(config);
    const resolved = await resolveTest(encoded);
    expect(resolved.serverUrl).toBeUndefined();
    expect(Object.keys(resolved.config.slots)).toEqual(["hero"]);
  });

  it("takes a serving URL and remembers where it pointed", async () => {
    const { encoded } = await encodeConfig(config);
    const resolved = await resolveTest(`https://lv.test/s/${encoded}`);
    expect(resolved.serverUrl).toBe("https://lv.test");
  });

  it("keeps a mounted deployment's prefix on the serverUrl", async () => {
    // Reading the route off the FIRST path segment used to parse this as
    // route "lv", config "s": the config failed to decode, and any
    // follow-up call went to a root the deployment does not own.
    const { encoded } = await encodeConfig(config);
    const resolved = await resolveTest(`https://host.test/lv/s/${encoded}`);
    expect(resolved.serverUrl).toBe("https://host.test/lv");
    expect(Object.keys(resolved.config.slots)).toEqual(["hero"]);
  });

  it("keeps the prefix on the query-parameter spelling too", async () => {
    const resolved = await resolveTest(
      "https://host.test/lv/s?v=https://x.test/a&v=https://x.test/b"
    );
    expect(resolved.serverUrl).toBe("https://host.test/lv");
    expect(resolved.config.slots.main).toHaveLength(2);
  });

  it("lifts the stats secret out of a manage link's fragment", async () => {
    // The fragment never reaches a server log, which is why the secret
    // travels there and why taking it from here saves a second paste.
    const { encoded } = await encodeConfig(config);
    const resolved = await resolveTest(
      `https://lv.test/manage/${encoded}#s3cret`
    );
    expect(resolved.statsSecret).toBe("s3cret");
  });

  it("refuses what carries no test, by name", async () => {
    await expect(resolveTest("")).rejects.toThrow(/no test given/);
    await expect(resolveTest("https://lv.test/about")).rejects.toThrow(
      /carries no LiveVariant test/
    );
  });
});
