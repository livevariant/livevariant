import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenApiDocument, TOOLS, toolPath } from "@livevariant/tools";
import { registerWebMcpTools } from "./lib/webmcp";

/**
 * WebMCP registration derives from /openapi.json, the document the
 * registry itself generates: every published tool registers, with the
 * registry's own descriptions and schemas, and calls land on the
 * documented REST paths. No hand-maintained subset to drift.
 */

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { modelContext?: unknown }).modelContext;
});

function stubModelContext(): { provided: () => RegisteredTool[] | null } {
  let context: { tools: RegisteredTool[] } | null = null;
  (navigator as { modelContext?: unknown }).modelContext = {
    provideContext(given: { tools: RegisteredTool[] }) {
      context = given;
    }
  };
  return { provided: () => context?.tools ?? null };
}

describe("WebMCP tools", () => {
  it("does nothing at all without navigator.modelContext", async () => {
    await expect(registerWebMcpTools()).resolves.toBeUndefined();
  });

  it("registers nothing when the spec cannot be fetched", async () => {
    const { provided } = stubModelContext();
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    await registerWebMcpTools();
    expect(provided()).toBeNull();
  });

  it("registers EVERY tool the deployment publishes, from its own spec", async () => {
    const { provided } = stubModelContext();
    const doc = buildOpenApiDocument({ serverUrl: "https://self.example" });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === "/openapi.json") {
          return Response.json(doc);
        }
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }
    );

    await registerWebMcpTools();
    const tools = provided();
    expect(tools).not.toBeNull();
    // The whole registry, not a curated subset.
    expect(tools!.map(tool => tool.name).sort()).toEqual(
      TOOLS.map(tool => tool.name).sort()
    );
    for (const tool of tools!) {
      // The registry's own long-form descriptions and object schemas.
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.inputSchema).toHaveProperty("type", "object");
    }

    // Execution posts the input to the documented path, verbatim.
    const buildTest = tools!.find(tool => tool.name === "build_test")!;
    await buildTest.execute({
      variants: [{ url: "https://a.example/x.jpg" }]
    });
    expect(calls[0].url).toBe(toolPath("build_test"));
    expect(calls[0].body).toEqual({
      variants: [{ url: "https://a.example/x.jpg" }]
    });
  });
});
