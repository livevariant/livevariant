import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { TOOLS, toolPath } from "@livevariant/tools";
import { mulberry32 } from "@livevariant/core";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";

/**
 * The REST fallback exists for agents that cannot install an MCP server,
 * so what matters is that it exposes the same tools with the same answers,
 * and that the published document describes what is actually mounted.
 */
const A = "https://example.com/a";
const B = "https://example.com/b";

let app: Hono;

beforeEach(() => {
  app = createApp({
    store: new MemoryStore(),
    rng: mulberry32(42),
    apiUrl: "https://livevariant.com"
  });
});

async function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("the tool API", () => {
  it("mounts every tool in the registry", async () => {
    for (const tool of TOOLS) {
      const res = await post(toolPath(tool.name), {});
      // Present, whatever it thinks of an empty body.
      expect(res.status).not.toBe(404);
    }
  });

  it("builds a test over plain HTTP", async () => {
    const res = await post(toolPath("build_test"), {
      variants: [{ url: A }, { url: B }]
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, any>;
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.urls.serve).toBe(`https://livevariant.com/s/${out.config}`);
  });

  it("round-trips: a test built here actually serves here", async () => {
    // The proof that the API is not describing a parallel universe.
    const built = (await (
      await post(toolPath("build_test"), { variants: [{ url: A }, { url: B }] })
    ).json()) as Record<string, any>;

    const serve = await app.request(`/s/${built.config}?id=r1`, {
      headers: { accept: "text/html" }
    });
    expect(serve.status).toBe(302);
    expect(serve.headers.get("location")).toMatch(/example\.com\/(a|b)/);

    const stats = await app.request(`/stats/${built.config}`, {
      headers: { authorization: `Bearer ${built.statsSecret}` }
    });
    expect(stats.status).toBe(200);
    expect(((await stats.json()) as any).totalAssignments).toBe(1);
  });

  it("reports a bad body as a 400 with the reason", async () => {
    const res = await post(toolPath("build_test"), { variants: [{ url: A }] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBe("invalid request");
    expect(JSON.stringify(body.details)).toMatch(/variants/);
  });

  it("turns a caller's mistake into a 400, not a 500", async () => {
    const res = await post(toolPath("inspect_test"), { test: "rubbish" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/not a LiveVariant test/);
  });

  it("publishes a spec describing exactly what is mounted", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    expect(Object.keys(doc.paths).sort()).toEqual(
      TOOLS.map(t => toolPath(t.name)).sort()
    );
    expect(doc.servers[0].url).toBe("https://livevariant.com");
  });

  it("serves the docs page", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger-ui");
  });

  it("stays unmounted when the deployment only serves variants", async () => {
    // livevariant.link carries email traffic; it has no business hosting
    // docs, and an unmounted API is one less surface on that domain.
    const serveOnly = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1)
    });
    expect((await serveOnly.request("/openapi.json")).status).toBe(404);
    expect(
      (await serveOnly.request(toolPath("build_test"), { method: "POST" }))
        .status
    ).toBe(404);
  });
});
