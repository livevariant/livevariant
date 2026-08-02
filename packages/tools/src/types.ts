import type { z } from "zod";

/**
 * One definition per operation, and every surface is generated from it:
 * the MCP server registers these, the REST API mounts these, the OpenAPI
 * document describes these, and the agent SKILL documents these. Nothing
 * about a tool is written down twice, so nothing about a tool can drift.
 *
 * The split that matters: a definition is data plus a pure-ish handler
 * taking an explicit ToolContext. It knows nothing about MCP, HTTP, Hono
 * or the SDK, which is what lets a different product embed the same tools
 * without inheriting a transport.
 */

/** Everything a handler is allowed to reach outside itself. */
export interface ToolContext {
  /** Origin serving the test URLs these tools build and read. */
  serverUrl: string;
  /** Injected so tests need no network and hosts can supply their own. */
  fetch: typeof globalThis.fetch;
}

/**
 * There is deliberately no auth field here. Every tool carries its own
 * authority in its arguments: a test is its config, and reading results
 * needs the stats secret, which the server checks against the hash inside
 * that config. Nothing a caller could authenticate AS would grant more.
 *
 * When account-scoped operations arrive ("list my tests"), which genuinely
 * cannot be authorized by an argument, this is where the requirement goes:
 * a field here, a gate in each host, no change to any existing tool.
 */
export interface ToolDefinition<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType
> {
  /** snake_case, stable: it is the MCP tool name and the REST path. */
  name: string;
  /** Human-readable label. MCP clients show it; directories require it. */
  title: string;
  /** One line for the SKILL table and the OpenAPI summary. */
  summary: string;
  /** The full description an assistant reads before choosing this tool. */
  description: string;
  input: Input;
  output: Output;
  /**
   * MCP tool annotations. `readOnly` covers everything that only computes
   * or reads; nothing here mutates a test, because tests are their configs.
   */
  readOnly: boolean;
  /** Whether the handler reaches the network (an MCP openWorldHint). */
  reachesNetwork: boolean;
  handler: (
    input: z.infer<Input>,
    context: ToolContext
  ) => Promise<z.infer<Output>>;
}

/** Convenience for building a definition without losing the generics. */
export function defineTool<Input extends z.ZodType, Output extends z.ZodType>(
  definition: ToolDefinition<Input, Output>
): ToolDefinition<Input, Output> {
  return definition;
}

/** REST path for a tool. One shape for all of them keeps clients trivial. */
export function toolPath(name: string): string {
  return `/api/v1/${name.replace(/_/g, "-")}`;
}

/**
 * A tool's failure that is the caller's fault rather than a bug: a config
 * that will not decode, a stats secret the server rejected. Hosts turn it
 * into a 400 and an MCP error result instead of a stack trace.
 */
/** The statuses a tool failure can carry, so hosts need no cast. */
export type ToolErrorStatus = 400 | 401 | 404 | 502;

export class ToolInputError extends Error {
  constructor(
    message: string,
    readonly status: ToolErrorStatus = 400
  ) {
    super(message);
    this.name = "ToolInputError";
  }
}
