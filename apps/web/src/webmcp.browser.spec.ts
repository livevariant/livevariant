import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWebMcpTools } from "./lib/webmcp";

/**
 * WebMCP registration: browsers with navigator.modelContext get the
 * site's key actions as tools; the tool calls must hit the documented
 * REST endpoints with the documented shapes, because they carry no
 * authority of their own.
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

describe("WebMCP tools", () => {
  it("does nothing at all without navigator.modelContext", () => {
    expect(() => registerWebMcpTools()).not.toThrow();
  });

  it("registers the site's actions and calls the REST API", async () => {
    let provided: { tools: RegisteredTool[] } | null = null;
    (navigator as { modelContext?: unknown }).modelContext = {
      provideContext(context: { tools: RegisteredTool[] }) {
        provided = context;
      }
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json({ ok: true });
      }
    );

    registerWebMcpTools();
    expect(provided).not.toBeNull();
    const tools = provided!.tools;
    expect(tools.map(tool => tool.name)).toEqual([
      "build_ab_test",
      "inspect_test",
      "get_stats"
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toHaveProperty("type", "object");
    }

    // build_ab_test maps bare URLs into the documented variant objects.
    await tools[0].execute({
      variants: ["https://a.example/x.jpg", "https://a.example/y.jpg"],
      name: "August"
    });
    expect(calls[0].url).toBe("/api/v1/build-test");
    expect(calls[0].body).toEqual({
      variants: [
        { url: "https://a.example/x.jpg" },
        { url: "https://a.example/y.jpg" }
      ],
      name: "August"
    });

    await tools[2].execute({ test: "cfg", statsSecret: "s3cret-value" });
    expect(calls[1].url).toBe("/api/v1/get-stats");
    expect(calls[1].body).toEqual({ test: "cfg", statsSecret: "s3cret-value" });
  });
});
