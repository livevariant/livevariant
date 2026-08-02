import { Hono } from "hono";
import { cors } from "hono/cors";
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
 */

export interface ApiOptions {
  /** Origin the built URLs point at, and the one advertised in the spec. */
  serverUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createApi(options: ApiOptions): Hono {
  const app = new Hono();
  const context: ToolContext = {
    serverUrl: options.serverUrl,
    fetch: options.fetch ?? globalThis.fetch
  };

  // Open CORS, for the same reason the serving endpoints are: there are no
  // cookies anywhere, and a stats secret in the body authorizes itself, so
  // the origin proves nothing worth checking.
  app.use(
    "/api/*",
    cors({
      origin: "*",
      allowMethods: ["POST", "OPTIONS"],
      allowHeaders: ["content-type"]
    })
  );

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
        return c.json(await tool.handler(parsed.data, context));
      } catch (err) {
        if (err instanceof ToolInputError) {
          return c.json({ error: err.message }, err.status as 400);
        }
        throw err;
      }
    });
  }

  app.get("/openapi.json", c =>
    c.json(buildOpenApiDocument({ serverUrl: options.serverUrl }))
  );
  app.get("/docs", c => c.html(swaggerPage("/openapi.json")));

  return app;
}
