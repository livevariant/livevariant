import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "@livevariant/mcp";
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
  const contextFor = (url: string): ToolContext => {
    const origin = new URL(url).origin;
    return {
      serverUrl: origin,
      serveUrl: serveUrl ?? origin,
      fetch: options.fetch
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

  for (const tool of TOOLS as readonly ToolDefinition[]) {
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
        return c.json(await tool.handler(parsed.data, contextFor(c.req.url)));
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
    c.json({ serveUrl: serveUrl ?? new URL(c.req.url).origin })
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
