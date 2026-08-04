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
  app = createApp({ store: new MemoryStore(), rng: mulberry32(42) });
});

async function post(path: string, body: unknown) {
  return app.request(`https://livevariant.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("the tool API", () => {
  it("mounts every open tool; account tools need the capability", async () => {
    for (const tool of TOOLS) {
      const res = await post(toolPath(tool.name), {});
      if (tool.scope === "account") {
        // No accounts on this deployment: the tool does not exist, so
        // an agent is never shown something the server cannot answer.
        expect(res.status).toBe(404);
      } else {
        // Present, whatever it thinks of an empty body.
        expect(res.status).not.toBe(404);
      }
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
    const res = await app.request("https://livevariant.com/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    expect(Object.keys(doc.paths).sort()).toEqual(
      TOOLS.map(t => toolPath(t.name)).sort()
    );
    expect(doc.servers[0].url).toBe("https://livevariant.com");
  });

  it("treats a blank serving domain as no serving domain", async () => {
    // The deploy button offers LV_SERVE_URL empty and tells people to leave
    // it that way unless they run a second domain, so "" is expected input.
    // Passed through it built "/s/<config>", which in an email resolves
    // against the mail client and serves nothing.
    const blank = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "   "
    });
    const res = await blank.request("https://ab.internal/api/v1/build-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toBe(`https://ab.internal/s/${out.config}`);
    // And the dashboard is told the same thing, or the builder would show
    // whitespace as the serving server.
    const config = await blank.request("https://ab.internal/config");
    expect(await config.json()).toEqual({
      serveUrl: "https://ab.internal",
      region: null
    });
  });

  it("tells the dashboard where its links should point", async () => {
    // The builder is a static build and cannot know this at compile time,
    // so a hardcoded default would be wrong for the hosted service or for
    // every self-hoster, depending which way it was written.
    const res = await app.request("https://ab.internal/config");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      serveUrl: "https://ab.internal",
      region: null
    });

    const split = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "https://livevariant.link"
    });
    const res2 = await split.request("https://livevariant.com/config");
    expect(await res2.json()).toEqual({
      serveUrl: "https://livevariant.link",
      region: null
    });
  });

  it("serves the docs page", async () => {
    const res = await app.request("https://livevariant.com/docs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("swagger-ui");
  });

  it("builds every URL from the origin the caller reached", async () => {
    // One domain doing everything is the default and needs no
    // configuration: deploy anywhere and the links are right, because they
    // are made from the request itself.
    const res = await app.request("https://ab.internal/api/v1/build-test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toBe(`https://ab.internal/s/${out.config}`);
    expect(out.urls.manage).toContain("https://ab.internal/manage/");
  });

  it("puts visitor links on the serving domain when there is one", async () => {
    // The only thing a separate serving domain changes is where visitors
    // are sent; the creator still manages the test where they found it.
    const split = createApp({
      store: new MemoryStore(),
      rng: mulberry32(1),
      serveUrl: "https://livevariant.link"
    });
    const res = await split.request(
      "https://livevariant.com/api/v1/build-test",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
      }
    );
    const out = (await res.json()) as Record<string, any>;
    expect(out.urls.serve).toContain("https://livevariant.link/s/");
    expect(out.emailTemplate.main.imageSrc).toContain(
      "https://livevariant.link/s?"
    );
    expect(out.urls.manage).toContain("https://livevariant.com/manage/");
  });

  it("reads its own stats without leaving the process", async () => {
    // The bug this pins: get_stats fetches /stats, and a Worker cannot
    // fetch its own hostname, so the injected fetch has to route back into
    // this same app. In production this surfaced as a 500.
    const built = (await (
      await post(toolPath("build_test"), { variants: [{ url: A }, { url: B }] })
    ).json()) as Record<string, any>;
    await app.request(`https://livevariant.com/s/${built.config}?id=r1`, {
      headers: { accept: "text/html" }
    });
    const res = await post(toolPath("get_stats"), {
      test: built.config,
      statsSecret: built.statsSecret
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).totalAssignments).toBe(1);
  });
});

describe("the API token gate", () => {
  const gated = () =>
    createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      apiToken: "0".repeat(64)
    });

  it("401s tools and /mcp without the token, and answers with it", async () => {
    const app = gated();
    const anon = await app.request(`https://x.test${toolPath("build_test")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
    });
    expect(anon.status).toBe(401);
    const anonMcp = await app.request("https://x.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    expect(anonMcp.status).toBe(401);
    const authed = await app.request(
      `https://x.test${toolPath("build_test")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${"0".repeat(64)}`
        },
        body: JSON.stringify({ variants: [{ url: A }, { url: B }] })
      }
    );
    expect(authed.status).toBe(200);
  });

  it("leaves discovery and serving open", async () => {
    const app = gated();
    expect((await app.request("https://x.test/config")).status).toBe(200);
    expect((await app.request("https://x.test/openapi.json")).status).toBe(200);
    expect((await app.request("https://x.test/health")).status).toBe(200);
  });
});

describe("account-scoped tools with a provider", () => {
  const provider = {
    sessionOrgIds: async (req: Request) =>
      req.headers.get("cookie")?.includes("session=yes") ? ["org-1"] : [],
    keyPolicy: async () => null,
    testOrg: async () => null,
    listTests: async () => ({
      tests: [
        {
          testId: "t".repeat(64),
          name: "claimed test",
          encoded: "enc",
          region: null,
          addedAt: 1
        }
      ],
      nextCursor: null
    })
  };

  const withAccounts = () =>
    createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      provider
    });

  it("mounts list_tests and resolves identity per call", async () => {
    const app = withAccounts();
    const anon = await app.request(`https://x.test${toolPath("list_tests")}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    // Listed but unanswerable without identity: a clear 401, never an
    // empty list pretending to be an answer.
    expect(anon.status).toBe(401);
    const signed = await app.request(
      `https://x.test${toolPath("list_tests")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: "session=yes"
        },
        body: "{}"
      }
    );
    expect(signed.status).toBe(200);
    const body = (await signed.json()) as { tests: Array<{ name: string }> };
    expect(body.tests[0].name).toBe("claimed test");
  });
});
