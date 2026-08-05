import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOLS,
  ToolInputError,
  type ToolContext,
  type ToolDefinition
} from "@livevariant/tools";

/**
 * The MCP surface. It registers the shared tool registry and does nothing
 * else: no tool logic lives here, so the MCP server and the REST API can
 * never answer the same question differently.
 *
 * There is no authentication, and none is missing. A test is its config,
 * and reading results needs the stats secret that is checked against the
 * hash inside that config, so authority travels in the arguments. Nothing
 * a client could authenticate as would grant it more.
 */

export const SERVER_NAME = "livevariant";
export const SERVER_VERSION = "0.0.1";

/** Default public deployment; self-hosters override it. */
export const DEFAULT_SERVER_URL = "https://livevariant.link";

export interface McpServerOptions {
  serverUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Account-scoped capability. Absent (a stdio server, a self-host
   * without accounts) means account-scoped tools are not registered at
   * all, so an agent never sees a tool the deployment cannot serve.
   */
  accounts?: ToolContext["accounts"];
}

export function toolContext(options: McpServerOptions = {}): ToolContext {
  return {
    serverUrl: options.serverUrl ?? DEFAULT_SERVER_URL,
    fetch: options.fetch ?? globalThis.fetch,
    accounts: options.accounts
  };
}

/**
 * A tool's result, in both the shapes the protocol wants: `structuredContent`
 * for clients that read the output schema, and a JSON `content` block for
 * those that only render text.
 */
function ok(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

/**
 * A failure the caller can fix, returned as a tool error rather than
 * thrown. A thrown error becomes a protocol fault the model cannot read;
 * this way it sees the message and can correct its own arguments.
 */
function failed(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerTools(
  server: McpServer,
  options: McpServerOptions = {}
): string[] {
  const context = toolContext(options);
  const available = (TOOLS as readonly ToolDefinition[]).filter(
    tool => tool.scope !== "account" || context.accounts !== undefined
  );
  for (const tool of available) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          idempotentHint: tool.readOnly,
          openWorldHint: tool.reachesNetwork
        }
      },
      (async (input: unknown) => {
        try {
          return ok(await tool.handler(input, context));
        } catch (err) {
          if (err instanceof ToolInputError) {
            return failed(err.message);
          }
          throw err;
        }
      }) as never
    );
  }
  return available.map(tool => tool.name);
}

export function createServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "LiveVariant runs A/B tests with multi-armed bandits, so traffic " +
        "shifts toward the winner while the test runs instead of waiting for " +
        "a frozen split to reach significance.\n\n" +
        "There are no accounts. A test IS its config, encoded into its own " +
        "URLs, and its identity is a hash of that config, so editing a " +
        "variant produces a different test with its own empty history. " +
        "build_test returns a stats secret exactly once; without it a test's " +
        "results can never be read by anyone.\n\n" +
        "Typical flow: variant_brief to learn the constraints, draft the " +
        "variants yourself, build_test for the URLs, optionally " +
        "generate_priors to warm-start from what you expect, then get_stats " +
        "to read results. Trust get_stats's win probabilities over comparing " +
        "conversion rates by eye."
    }
  );
  registerTools(server, options);
  return server;
}

export { TOOLS } from "@livevariant/tools";
