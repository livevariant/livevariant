import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "@livevariant/mcp";
import { regionHint, sha256Hex, type CloudflareGeo } from "@livevariant/core";
import type { AccountsProvider } from "./accounts-port.js";
import {
  TOOLS,
  ToolInputError,
  buildOpenApiDocument,
  swaggerPage,
  toolPath,
  type ToolContext,
  type ToolDefinition
} from "@livevariant/tools";

/**
 * The REST face of the same tool registry the MCP server exposes. It
 * exists because an agent handed our SKILL cannot always install an MCP
 * server, and then plain HTTP is the only way in. Both surfaces call the
 * identical handler, so they cannot answer the same question differently.
 *
 * The document at /openapi.json is generated from those definitions too,
 * which is what stops the docs describing an API we do not serve.
 *
 * /mcp is the same registry a third time, over the protocol itself, so a
 * client that speaks MCP needs nothing installed locally. It is stateless
 * by construction: every tool is a pure function of its arguments, so
 * there is no session worth keeping and a fresh server per request costs
 * nothing while removing every question about session affinity across
 * Worker isolates.
 */

export interface ApiOptions {
  /**
   * Origin to put in the links visitors follow. Unset means "wherever this
   * request arrived", which is what lets a one-domain self-host work with
   * no configuration at all; set it only when serving has its own domain.
   */
  serveUrl?: string;
  /**
   * Dispatches the tools' own HTTP calls. The host passes one that routes
   * back into this app in-process: a Worker cannot fetch its own hostname,
   * and even where it can, a round trip to yourself is pure latency.
   */
  fetch: typeof globalThis.fetch;
  /**
   * When set, the tool API and /mcp require `Authorization: Bearer` with
   * exactly this value: the self-hoster's server-to-server credential
   * (LV_API_TOKEN), one deployment-wide identity meaning "the operator".
   * Unset keeps both surfaces open, which is the account-free default.
   * The hosted deployment must never set it: "operator" is the wrong
   * granularity for a multi-tenant service.
   */
  apiToken?: string;
  /**
   * The accounts read side. Its presence is what registers the
   * account-scoped tools (list_tests); a deployment without it never
   * shows an agent a tool it cannot serve.
   */
  provider?: AccountsProvider;
  /**
   * Google Tag Manager container id (GTM-XXXXXXX) for the DASHBOARD
   * pages themselves (LV_GOOGLE_TAG_MANAGER). Served through /config;
   * the SPA injects the container when present. Unset means no GTM,
   * which is the default and the self-host norm.
   */
  gtmId?: string;
}

export function createApi(options: ApiOptions): Hono {
  const app = new Hono();

  /**
   * Built per request, so every generated URL points at whatever origin
   * the caller actually reached. That is what makes the single-domain
   * deployment need no configuration.
   */
  // Blank counts as unset. The deploy button offers LV_SERVE_URL with an
  // empty default and tells people to leave it alone unless they run a
  // second domain, so an empty string is the expected input, not a typo.
  // Passed through, it built origin-less URLs like "/s/<config>", which in
  // an email resolve against the mail client and serve nothing.
  const serveUrl = options.serveUrl?.trim() || undefined;
  const provider = options.provider;
  const contextFor = (url: string, raw?: Request): ToolContext => {
    const origin = new URL(url).origin;
    // The caller's own geography, so build_test can default a new
    // test's region to its CREATOR's location rather than to wherever
    // the first serve later comes from (in email: a mail proxy).
    const cf = (raw as (Request & { cf?: CloudflareGeo }) | undefined)?.cf;
    return {
      serverUrl: origin,
      serveUrl: serveUrl ?? origin,
      region: regionHint(cf) ?? undefined,
      fetch: options.fetch,
      // Identity resolves lazily per call: a session cookie on the
      // same-origin dashboard identifies the caller; without one the
      // tool rejects with instructions instead of listing nothing.
      accounts:
        provider && raw
          ? {
              listTests: async listOptions => {
                const orgIds = await provider.sessionOrgIds(raw);
                if (orgIds.length === 0) {
                  throw new ToolInputError(
                    "sign in required: call this from a signed-in " +
                      "dashboard session",
                    401
                  );
                }
                return provider.listTests(orgIds, listOptions);
              }
            }
          : undefined
    };
  };

  // Open CORS, for the same reason the serving endpoints are: there are no
  // cookies anywhere, and a stats secret in the body authorizes itself, so
  // the origin proves nothing worth checking.
  const openCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["content-type", "mcp-session-id", "mcp-protocol-version"],
    exposeHeaders: ["mcp-session-id"]
  });
  app.use("/api/*", openCors);
  app.use("/mcp", openCors);

  const apiToken = options.apiToken?.trim() || undefined;
  if (apiToken) {
    const gate = async (
      c: Parameters<Parameters<Hono["use"]>[1]>[0],
      next: () => Promise<void>
    ): Promise<Response | undefined> => {
      const header = c.req.header("authorization");
      const token = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
      // Hash both sides before comparing: constant-time by construction.
      if (!token || (await sha256Hex(token)) !== (await sha256Hex(apiToken))) {
        return c.json({ error: "api token required" }, 401);
      }
      await next();
      return undefined;
    };
    // Discovery stays open (/config, /openapi.json, /docs describe the
    // API without granting anything); the tools and MCP need the token.
    app.use("/api/v1/*", gate);
    app.use("/mcp", gate);
  }

  const availableTools = (TOOLS as readonly ToolDefinition[]).filter(
    tool => tool.scope !== "account" || provider !== undefined
  );
  for (const tool of availableTools) {
    app.post(toolPath(tool.name), async c => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = tool.input.safeParse(body ?? {});
      if (!parsed.success) {
        return c.json(
          { error: "invalid request", details: parsed.error.issues },
          400
        );
      }
      try {
        return c.json(
          await tool.handler(parsed.data, contextFor(c.req.url, c.req.raw))
        );
      } catch (err) {
        if (err instanceof ToolInputError) {
          return c.json({ error: err.message }, err.status);
        }
        throw err;
      }
    });
  }

  // The dashboard is a static build, so it cannot read the deployment's
  // configuration at compile time. It asks here instead, which is what
  // makes the builder default to livevariant.link on the hosted service
  // and to a self-hoster's own origin on theirs, with nothing baked in.
  app.get("/config", c =>
    c.json({
      serveUrl: serveUrl ?? new URL(c.req.url).origin,
      // The dashboard defaults a new test's region to its creator's.
      region: regionHint(
        (c.req.raw as Request & { cf?: CloudflareGeo }).cf ?? null
      ),
      gtmId: options.gtmId?.trim() || null
    })
  );

  app.get("/openapi.json", c =>
    c.json(buildOpenApiDocument({ serverUrl: new URL(c.req.url).origin }))
  );
  app.get("/docs", c => c.html(swaggerPage("/openapi.json")));

  // MCP over HTTP. No authentication, for the same reason the rest of this
  // has none: a test is its config, and reading results needs the stats
  // secret checked against the hash inside that config, so authority
  // travels in the arguments and there is nothing to log in to.
  app.all("/mcp", async c => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Plain JSON rather than an SSE stream: nothing here ever pushes a
      // server-initiated message, and a Worker billed for wall-clock has
      // no reason to hold a stream open for a request/response exchange.
      enableJsonResponse: true
    });
    const server = createServer(contextFor(c.req.url));
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // A per-request server holds no state worth keeping, and leaving it
      // connected would leak a transport per call.
      await server.close();
    }
  });

  return app;
}
