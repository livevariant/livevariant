import packageJson from "@livevariant/mcp/package.json" with { type: "json" };
import { renderMcpInstructions, renderSkillMd } from "@livevariant/tools";
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
/**
 * Read from package.json rather than typed here: releases version all
 * five packages in lockstep, and a hardcoded string meant the MCP
 * handshake told every client 0.0.1 forever while the server card next
 * door reported the truth.
 */
export const SERVER_VERSION: string = packageJson.version;

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
  const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      // Hosted URLs on purpose: this server also runs as a local stdio
      // process (npx), where a relative path would resolve to nothing.
      // The SVG follows the client's theme by itself; the PNGs are the
      // explicit pair, light first, our one-slot default.
      icons: [
        {
          src: "https://livevariant.com/icon.svg",
          mimeType: "image/svg+xml",
          sizes: ["any"]
        },
        {
          src: "https://livevariant.com/icon-512.png",
          mimeType: "image/png",
          sizes: ["512x512"],
          theme: "light"
        },
        {
          src: "https://livevariant.com/icon-512-dark.png",
          mimeType: "image/png",
          sizes: ["512x512"],
          theme: "dark"
        }
      ]
    },
    {
      capabilities: { tools: {} },
      // One source of truth: the same overview every other surface
      // renders from (packages/tools/src/docs.ts).
      instructions: renderMcpInstructions(serverUrl)
    }
  );
  registerTools(server, options);
  // The full skill, readable over the protocol itself. An MCP-only
  // install (no plugin, no skills directory, maybe no way to fetch a
  // URL) still gets the complete recipe document the instructions
  // point at, rendered against this deployment so a self-host
  // describes itself.
  const skillUri = `${serverUrl.replace(/\/+$/, "")}/skills/livevariant/SKILL.md`;
  server.registerResource(
    "skill",
    skillUri,
    {
      title: "LiveVariant agent skill",
      description:
        "The full LiveVariant skill: recipes and pitfalls for building " +
        "and reading A/B tests with these tools. Read this before your " +
        "first build_test call.",
      mimeType: "text/markdown"
    },
    uri => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: renderSkillMd(serverUrl)
        }
      ]
    })
  );
  return server;
}

export { TOOLS } from "@livevariant/tools";
