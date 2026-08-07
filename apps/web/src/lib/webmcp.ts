/**
 * WebMCP (navigator.modelContext): exposes the deployment's tool
 * registry to browser-driven agents. The tools are derived at runtime
 * from /openapi.json, which is generated from the same registry as
 * MCP, REST and the SKILL, so this surface registers EVERY tool the
 * deployment publishes and can never drift from it. Feature-detected:
 * browsers without the API skip everything, and a failed spec fetch
 * registers nothing rather than a stale subset.
 */

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

interface ModelContext {
  provideContext(context: { tools: WebMcpTool[] }): void;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
  };
}

export async function registerWebMcpTools(): Promise<void> {
  const modelContext = (navigator as { modelContext?: ModelContext })
    .modelContext;
  if (typeof modelContext?.provideContext !== "function") {
    return;
  }
  let doc: { paths?: Record<string, { post?: OpenApiOperation }> };
  try {
    const res = await fetch("/openapi.json");
    if (!res.ok) {
      return;
    }
    doc = (await res.json()) as typeof doc;
  } catch {
    return;
  }
  const tools: WebMcpTool[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const op = item.post;
    if (!op?.operationId) {
      continue;
    }
    tools.push({
      name: op.operationId,
      description: op.description ?? op.summary ?? op.operationId,
      inputSchema: op.requestBody?.content?.["application/json"]?.schema ?? {
        type: "object"
      },
      execute: async input => {
        // Same-origin cookies ride along so the account-scoped tools
        // (list_tests) work for a signed-in visitor; every other tool
        // carries its authority in the arguments, like the docs say.
        const res = await fetch(path, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input ?? {})
        });
        return res.json();
      }
    });
  }
  if (tools.length > 0) {
    modelContext.provideContext({ tools });
  }
}
