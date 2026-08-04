import type { z } from "zod";
import type { TestRegion } from "@livevariant/core";

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
  /**
   * This deployment's own origin: where the dashboard lives, and the only
   * place a stats secret is ever sent.
   */
  serverUrl: string;
  /**
   * Origin to put in the links visitors follow. Defaults to serverUrl, so
   * a self-hoster needs one domain and no configuration; set it only when
   * serving has its own domain to keep bulk email traffic away from the
   * dashboard's reputation.
   */
  serveUrl?: string;
  /**
   * The calling creator's region, when the host can tell (the hosted
   * API derives it from the request's geography). build_test uses it to
   * default a new test's region, so state is born near the creator
   * instead of near whichever mail proxy fetches first.
   */
  region?: TestRegion;
  /** Injected so tests need no network and hosts can supply their own. */
  fetch: typeof globalThis.fetch;
  /**
   * Account-scoped capability, present only on deployments that HAVE
   * accounts. Its absence is meaningful: hosts do not register
   * account-scoped tools without it, so an agent never sees a tool the
   * deployment cannot serve. The host resolves the caller's identity
   * (session, API token) before answering; a call without one rejects
   * with a ToolInputError naming how to authenticate.
   */
  accounts?: AccountTools;
}

/** What account-scoped tools can ask of the host. */
export interface AccountTools {
  listTests(options: { q?: string; cursor?: string; limit?: number }): Promise<{
    tests: Array<{
      testId: string;
      name: string | null;
      encoded: string;
      region: string | null;
      addedAt: number;
    }>;
    nextCursor: string | null;
  }>;
}

/**
 * Every OPEN tool carries its authority in its arguments: a test is its
 * config, and reading results needs the stats secret, which the server
 * checks against the hash inside that config. Only tools that ask
 * "which tests are MINE" need a caller, and they declare scope
 * "account" and are registered only where ToolContext.accounts exists.
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
  /**
   * "open" (default): authorized entirely by its arguments, callable on
   * any deployment. "account": needs an identified caller and the
   * ToolContext.accounts capability; unregistered where accounts are
   * absent.
   */
  scope?: "open" | "account";
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
