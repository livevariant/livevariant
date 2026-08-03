import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";

/**
 * The real Worker: real Durable Object, real assets binding, real wrangler
 * config. Every other test in this repository drives the Hono app directly
 * over an in-memory store, which is fast and proves the logic, and proves
 * nothing about the runtime the logic actually ships into.
 *
 * That gap is not hypothetical. `get_stats` fetches /stats, and a Worker
 * cannot fetch its own hostname; it passed every unit test and returned
 * 500 in production. A deploy with `durable_objects` missing from the
 * environment would likewise have passed everything and shipped a Worker
 * with no state store. Both are visible here and nowhere else.
 */
const configPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "wrangler.jsonc"
);

// The config binds apps/web's build as static assets, so it has to exist.
// Both CI and Workers Builds run a full build first; this is for whoever
// runs just this project and would otherwise get an opaque failure.
const assets = path.join(path.dirname(configPath), "apps", "web", "dist");
if (!existsSync(assets)) {
  throw new Error(
    `${assets} is missing: run \`npm run build\` before this suite, since ` +
      "the Worker serves it as static assets."
  );
}

const harness = createTestHarness({ workers: [{ configPath }] });

beforeAll(async () => {
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness.close();
});

/** The origin the base config serves on; every URL is built from it. */
const ORIGIN = "http://example.com";

describe("the deployed Worker", () => {
  it("builds, serves and reads back a test", async () => {
    // The whole loop through the runtime: the tool API builds a config,
    // the redirect path assigns through the Durable Object, and get_stats
    // reads it back through a fetch that must never leave the process.
    const built = (await (
      await harness.fetch(`${ORIGIN}/api/v1/build-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "integration",
          variants: [
            { url: "https://example.com/a" },
            { url: "https://example.com/b" }
          ]
        })
      })
    ).json()) as Record<string, string> & { urls: Record<string, string> };

    expect(built.testId).toMatch(/^[0-9a-f]{64}$/);
    // Built from the request's own origin: the single-domain default.
    expect(built.urls.serve).toBe(`${ORIGIN}/s/${built.config}`);

    const serve = await harness.fetch(`${built.urls.serve}?id=r1`, {
      redirect: "manual",
      headers: { accept: "text/html" }
    });
    expect(serve.status).toBe(302);
    expect(serve.headers.get("location")).toMatch(/example\.com\/(a|b)/);

    const stats = (await (
      await harness.fetch(`${ORIGIN}/api/v1/get-stats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test: built.config,
          statsSecret: built.statsSecret
        })
      })
    ).json()) as { totalAssignments: number };

    // 1, not a 500: this is the assertion the production bug would fail.
    expect(stats.totalAssignments).toBe(1);
  }, 60_000);

  it("keeps a visitor on one variant, through the Durable Object", async () => {
    const built = (await (
      await harness.fetch(`${ORIGIN}/api/v1/build-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variants: [
            { url: "https://example.com/a" },
            { url: "https://example.com/b" }
          ]
        })
      })
    ).json()) as { urls: Record<string, string> };

    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await harness.fetch(`${built.urls.serve}?id=sticky`, {
        redirect: "manual",
        headers: { accept: "text/html" }
      });
      seen.add(res.headers.get("location") ?? "");
    }
    // Sticky assignment is the DO's whole job, and it only exists if the
    // SQLite migration was applied to this class.
    expect(seen.size).toBe(1);
  }, 60_000);

  it("speaks MCP over HTTP", async () => {
    const res = await harness.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "integration", version: "0" }
        }
      })
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string } };
    };
    expect(body.result.serverInfo.name).toBe("livevariant");
  }, 60_000);

  it("serves the dashboard, and lets the app's own routes through", async () => {
    // The assets binding plus run_worker_first: a client-side route falls
    // back to the shell, while a path the app owns reaches the Worker.
    const shell = await harness.fetch(`${ORIGIN}/tests/anything`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toMatch(/text\/html/);

    const health = await harness.fetch(`${ORIGIN}/health`);
    expect(await health.json()).toEqual({ ok: true });
  }, 60_000);
});
