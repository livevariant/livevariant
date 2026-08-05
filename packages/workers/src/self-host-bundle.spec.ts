import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The self-host guarantee, written as a build: the base entry must
 * bundle without a trace of the accounts stack. A runtime flag cannot
 * prove this (bundlers follow imports regardless), so the test bundles
 * exactly what `wrangler deploy` would and greps the output.
 */
describe("self-host bundle", () => {
  it("contains no auth framework and stays under the size ceiling", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const result = await build({
      entryPoints: [join(here, "index.ts")],
      bundle: true,
      write: false,
      format: "esm",
      conditions: ["@livevariant/source", "workerd"],
      external: ["cloudflare:workers"],
      logLevel: "silent"
    });
    const output = result.outputFiles[0].text;
    for (const marker of ["better-auth", "drizzle", "@livevariant/accounts"]) {
      expect(output.includes(marker), `bundle contains ${marker}`).toBe(false);
    }
    // A ceiling, not a target: growth past this is a review
    // conversation, not a surprise at the free-plan 3 MB limit.
    expect(output.length).toBeLessThan(2_000_000);
  }, 30_000);
});
