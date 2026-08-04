import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOLS } from "@livevariant/tools";
import { createServer } from "./index.js";

/**
 * Driven through a real MCP client over an in-memory transport, so what is
 * asserted is what a client actually sees: the advertised schemas, the
 * structured results, and the error shape.
 */
async function connect(fetchImpl?: typeof globalThis.fetch) {
  const server = createServer({
    serverUrl: "https://livevariant.link",
    fetch:
      fetchImpl ??
      ((() => {
        throw new Error("unexpected network call");
      }) as unknown as typeof globalThis.fetch)
  });
  const client = new Client({ name: "test", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
}

const A = "https://cdn.example.com/a.jpg";
const B = "https://cdn.example.com/b.jpg";

describe("the MCP server", () => {
  it("advertises exactly the shared registry", async () => {
    // If these ever diverge, the SKILL and the OpenAPI document are
    // documenting a server that does not exist.
    const client = await connect();
    const { tools } = await client.listTools();
    // No accounts capability on this server, so account-scoped tools
    // are deliberately absent.
    expect(tools.map(t => t.name).sort()).toEqual(
      TOOLS.filter(t => t.scope !== "account")
        .map(t => t.name)
        .sort()
    );
  });

  it("gives every tool a title, description and schemas", async () => {
    // Connector directories reject tools without a title, and a model
    // picks tools on the description alone.
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title ?? tool.annotations?.title).toBeTruthy();
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema).toBeTruthy();
    }
  });

  it("marks the read-only tools read-only and the rest honestly", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    expect(byName.get("build_test")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("build_test")?.annotations?.openWorldHint).toBe(false);
    // get_stats is the only one that leaves the process.
    expect(byName.get("get_stats")?.annotations?.openWorldHint).toBe(true);
  });

  it("returns a usable test through a real tool call", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "build_test",
      arguments: { variants: [{ url: A }, { url: B }] }
    });
    const out = result.structuredContent as Record<string, any>;
    expect(out.testId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.urls.serve).toContain("https://livevariant.link/s/");
    expect(out.statsSecret).toBeTruthy();
    // Text content too, for clients that do not read structured output.
    expect((result.content as Array<{ text: string }>)[0].text).toContain(
      "testId"
    );
  });

  it("rejects arguments that do not fit the schema", async () => {
    const client = await connect();
    // One variant is not a test; the schema says min 2. The SDK reports
    // this as an error result rather than a thrown fault, which is what
    // lets the model read the complaint and fix its own call.
    const result = await client.callTool({
      name: "build_test",
      arguments: { variants: [{ url: A }] }
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /expected array to have >=2 items/
    );
  });

  it("hands a fixable mistake back as a readable error, not a fault", async () => {
    // The model must be able to read this and correct itself, which a
    // thrown protocol error would not allow.
    const client = await connect();
    const result = await client.callTool({
      name: "inspect_test",
      arguments: { test: "definitely-not-a-config" }
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(
      /not a LiveVariant test/
    );
  });

  it("carries a stats fetch all the way through", async () => {
    const body = {
      testId: "a".repeat(64),
      totalAssignments: 4000,
      combinations: [
        {
          cell: 0,
          choice: ["control"],
          pulls: 2000,
          conversions: 100,
          rewardTotal: 100,
          conversionRate: 0.05
        },
        {
          cell: 1,
          choice: ["variant"],
          pulls: 2000,
          conversions: 180,
          rewardTotal: 180,
          conversionRate: 0.09
        }
      ],
      slots: {
        main: [
          {
            name: "control",
            pulls: 2000,
            conversions: 100,
            conversionRate: 0.05
          },
          {
            name: "variant",
            pulls: 2000,
            conversions: 180,
            conversionRate: 0.09
          }
        ]
      },
      buckets: {},
      bySignal: {},
      excluded: { total: 0, bySource: 0, byWindow: 0 }
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" }
      })) as unknown as typeof globalThis.fetch;
    const client = await connect(fetchImpl);

    const built = (
      await client.callTool({
        name: "build_test",
        arguments: { variants: [{ url: A }, { url: B }] }
      })
    ).structuredContent as Record<string, any>;

    const stats = (
      await client.callTool({
        name: "get_stats",
        arguments: { test: built.config, statsSecret: built.statsSecret }
      })
    ).structuredContent as Record<string, any>;

    expect(stats.decision.leader).toBe("variant");
    expect(stats.combinations[1].probabilityBest).toBeGreaterThan(0.99);
  });
});
