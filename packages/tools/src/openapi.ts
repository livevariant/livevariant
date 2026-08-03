import { z } from "zod";
import { TOOLS } from "./tools.js";
import { toolPath } from "./types.js";

/**
 * The OpenAPI document, generated from the same definitions the MCP server
 * registers. It exists because an agent that has a SKILL installed cannot
 * necessarily install an MCP server too, and then plain HTTP is the only
 * way in. Writing the document by hand would guarantee it drifts from the
 * tools within a week.
 *
 * Every operation is POST with a JSON body, including the read-only ones.
 * Configs are long enough to run into URL length limits and awkward enough
 * to percent-encode by hand that query parameters would be a worse API
 * than an honest body.
 */

export interface OpenApiOptions {
  /** Public origin of the API, for the servers block. */
  serverUrl: string;
  version?: string;
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    target: "draft-2020-12"
  }) as Record<string, unknown>;
}

export function buildOpenApiDocument(
  options: OpenApiOptions
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const tool of TOOLS) {
    paths[toolPath(tool.name)] = {
      post: {
        operationId: tool.name,
        summary: tool.summary,
        description: tool.description,
        tags: [tool.reachesNetwork ? "results" : "authoring"],
        requestBody: {
          required: true,
          content: { "application/json": { schema: jsonSchema(tool.input) } }
        },
        responses: {
          "200": {
            description: tool.summary,
            content: { "application/json": { schema: jsonSchema(tool.output) } }
          },
          "400": {
            description: "The request could not be used as given.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" }
              }
            }
          },
          "401": {
            description: "The stats secret did not match this test.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" }
              }
            }
          }
        }
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "LiveVariant API",
      version: options.version ?? "1.0.0",
      description:
        "Build, inspect and read bandit-driven A/B tests.\n\n" +
        "There are no accounts and no API keys. A test is its config, " +
        "encoded into its own URLs, and its identity is a hash of that " +
        "config. Reading results needs the stats secret generated when the " +
        "test was built, sent in the request body; the server checks it " +
        "against the hash stored inside the config itself.\n\n" +
        "These endpoints mirror the MCP tools of the same names exactly. Use " +
        "MCP if your client supports it; use this if it does not.",
      license: {
        name: "AGPL-3.0",
        url: "https://www.gnu.org/licenses/agpl-3.0.html"
      }
    },
    servers: [{ url: options.serverUrl }],
    tags: [
      {
        name: "authoring",
        description: "Build and check tests. No network, no state."
      },
      {
        name: "results",
        description: "Read a running test. Needs its stats secret."
      }
    ],
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" } }
        }
      }
    }
  };
}

/**
 * Swagger UI as a single self-contained page. Loaded from a CDN rather
 * than vendored: it is documentation, it is not on any serving path, and
 * shipping a megabyte of bundled UI into a Worker to avoid one script tag
 * is a poor trade.
 */
export function swaggerPage(specUrl: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LiveVariant API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  </head>
  <body>
    <div id="ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.SwaggerUIBundle({
        url: ${JSON.stringify(specUrl)},
        dom_id: "#ui",
        deepLinking: true
      });
    </script>
  </body>
</html>
`;
}
