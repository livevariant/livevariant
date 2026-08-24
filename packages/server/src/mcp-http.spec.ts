import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TOOLS } from "@livevariant/tools";

// This app has no accounts provider, so the account-scoped tools are
// deliberately absent from every surface.
const OPEN_TOOLS = TOOLS.filter(t => t.scope !== "account");
import { mulberry32 } from "@livevariant/core";
import { createApp } from "./app.js";
import { MemoryAssetStore } from "./assets/types.js";
import { MemoryStore } from "./store/memory.js";
import type { AccountsProvider } from "./accounts-port.js";

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

function appWithAccounts() {
  const provider: AccountsProvider = {
    sessionOrgIds: async req =>
      req.headers.get("cookie")?.includes("session=yes") ? ["org-1"] : [],
    keyPolicy: async () => null,
    testOrg: async () => null,
    listTests: async () => ({ tests: [], nextCursor: null }),
    registerWithSecret: async () => ({
      ok: true,
      org: "Example Org",
      testId: "a".repeat(64)
    }),
    testStatusWithSecret: async () => ({
      ok: true,
      testId: "a".repeat(64),
      claimed: false,
      org: null,
      destinations: []
    })
  };
  return createApp({
    store: new MemoryStore(),
    rng: mulberry32(42),
    provider
  });
}

describe("MCP over HTTP", () => {
  it("completes a real handshake and lists the registry", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      OPEN_TOOLS.map(t => t.name).sort()
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
    expect(ta.tools).toHaveLength(OPEN_TOOLS.length);
    expect(tb.tools).toHaveLength(OPEN_TOOLS.length);
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
    expect(tools).toHaveLength(OPEN_TOOLS.length);
  });

  it("uses the configured asset upload token on HTTP MCP uploads", async () => {
    const store = new MemoryAssetStore();
    app = createApp({
      store: new MemoryStore(),
      rng: mulberry32(42),
      assets: {
        store,
        signingSecret: "secret",
        uploadToken: "upload-secret"
      }
    });
    const client = await connect();
    const { tools } = await client.listTools();
    const uploadImage = tools.find(t => t.name === "upload_image");
    expect(uploadImage?.inputSchema.properties).not.toHaveProperty(
      "uploadToken"
    );

    const result = await client.callTool({
      name: "upload_image",
      arguments: {
        data: btoa("fake"),
        contentType: "image/png"
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      size: 4,
      contentType: "image/png"
    });
  });

  it("advertises account-scoped tools when the deployment has accounts", async () => {
    app = appWithAccounts();
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      TOOLS.map(t => t.name).sort()
    );
  });
});
