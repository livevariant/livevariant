import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A size ceiling on the served tag.
 *
 * /sdk.js goes on customer sites, in front of every visitor, so its weight
 * is a product decision and not an implementation detail. It reached 71 KB
 * gzipped without anyone noticing, almost all of it one dependency pulled
 * in by a namespace import that defeated tree-shaking. Nothing was
 * watching, so nothing objected.
 *
 * This lives in the Workers package because that is the deployment that
 * serves the file, and because the sdk package's own suite runs in a real
 * browser, where esbuild cannot. The sibling self-host-bundle.spec.ts
 * bundles the Worker entry the same way for the same kind of reason.
 *
 * The ceiling has room to breathe. Raise it deliberately and say why in
 * the commit; do not nudge it up to make a red build green.
 */
const MAX_GZIP_BYTES = 18 * 1024;

describe("served tag", () => {
  it("stays under the size ceiling", async () => {
    const result = await build({
      entryPoints: [
        fileURLToPath(new URL("../../sdk/src/tag-entry.ts", import.meta.url))
      ],
      bundle: true,
      write: false,
      minify: true,
      format: "iife",
      platform: "browser",
      conditions: ["@livevariant/source"],
      logLevel: "silent"
    });
    const bytes = gzipSync(result.outputFiles[0].contents, { level: 9 }).length;
    expect(
      bytes,
      `tag is ${(bytes / 1024).toFixed(1)} KB gzipped, ceiling is ${
        MAX_GZIP_BYTES / 1024
      } KB`
    ).toBeLessThanOrEqual(MAX_GZIP_BYTES);
  });
});
