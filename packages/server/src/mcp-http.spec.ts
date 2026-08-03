import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS } from "@livevariant/tools";
import { mulberry32 } from "@livevariant/core";
import { createApp } from "./app.js";
import { MemoryStore } from "./store/memory.js";

/**
 * The hosted MCP endpoint, driven by the real MCP client over real HTTP
 * semantics. Hand-rolling the protocol would have been the easy mistake
 * here; this asserts an actual client can talk to it.
 */
let app: Hono;

beforeEach(() => {
  app = createApp({ store: new MemoryStore(), rng: mulberry32(42) });
});

/** Routes the client's fetch into the Hono app, no socket involved. */
async function connect() {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://livevariant.com/mcp"), {
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(String(input), init)) as unknown as typeof globalThis.fetch
    })
  );
  return client;
}

describe("MCP over HTTP", () => {
  it("completes a real handshake and lists the registry", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      TOOLS.map(t => t.name).sort()
    );
  });

  it("runs a tool and returns structured output", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "build_test",
      arguments: {
        variants: [
          { url: "https://example.com/a" },
          { url: "https://example.com/b" }
        ]
      }
    });
    const out = result.structuredContent as Record<string, any>;
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    // Built against the API origin, which is where this is hosted.
    expect(out.urls.serve).toContain("https://livevariant.com/s/");
  });

  it("serves every request independently", async () => {
    // Stateless by construction: two clients share nothing, which is what
    // makes this safe across Worker isolates.
    const [a, b] = await Promise.all([connect(), connect()]);
    const [ta, tb] = await Promise.all([a.listTools(), b.listTools()]);
    expect(ta.tools).toHaveLength(TOOLS.length);
    expect(tb.tools).toHaveLength(TOOLS.length);
  });

  it("answers on whatever domain the deployment runs on", async () => {
    // One domain doing everything is the default shape, so this is not
    // gated on configuration.
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://ab.internal/mcp"), {
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          app.request(
            String(input),
            init
          )) as unknown as typeof globalThis.fetch
      })
    );
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOLS.length);
  });
});
