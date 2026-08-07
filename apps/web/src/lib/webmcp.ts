/**
 * WebMCP (navigator.modelContext): exposes this site's key actions as
 * tools to browser-driven agents. Feature-detected, so browsers without
 * the API skip everything silently. The tools call the same public REST
 * endpoints the docs describe, with the same authority model: nothing
 * registered here grants anything a plain fetch could not.
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

async function call(tool: string, body: unknown): Promise<unknown> {
  const res = await fetch(`/api/v1/${tool}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

export function registerWebMcpTools(): void {
  const modelContext = (navigator as { modelContext?: ModelContext })
    .modelContext;
  if (typeof modelContext?.provideContext !== "function") {
    return;
  }
  modelContext.provideContext({
    tools: [
      {
        name: "build_ab_test",
        description:
          "Build a LiveVariant A/B test from two or more variant URLs " +
          "(first is the control). Returns ready-made serve/click/manage " +
          "URLs and a stats secret that is shown exactly once: relay the " +
          "manage URL to the human.",
        inputSchema: {
          type: "object",
          properties: {
            variants: {
              type: "array",
              minItems: 2,
              items: {
                type: "string",
                description: "Variant target URL"
              }
            },
            name: { type: "string", description: "Human label for the test" }
          },
          required: ["variants"]
        },
        execute: input =>
          call("build-test", {
            variants: (input.variants as string[]).map(url => ({ url })),
            ...(input.name ? { name: input.name } : {})
          })
      },
      {
        name: "inspect_test",
        description:
          "Explain what a LiveVariant URL or config does, and lint it " +
          "for the mistakes that only surface once a campaign is out.",
        inputSchema: {
          type: "object",
          properties: {
            test: {
              type: "string",
              description: "Any LiveVariant URL or encoded config"
            }
          },
          required: ["test"]
        },
        execute: input => call("inspect-test", { test: input.test })
      },
      {
        name: "get_stats",
        description:
          "Read a test's results: per-combination win probabilities and " +
          "an honest stop/continue call. Requires the stats secret the " +
          "test was built with.",
        inputSchema: {
          type: "object",
          properties: {
            test: { type: "string" },
            statsSecret: { type: "string" }
          },
          required: ["test", "statsSecret"]
        },
        execute: input =>
          call("get-stats", {
            test: input.test,
            statsSecret: input.statsSecret
          })
      }
    ]
  });
}
