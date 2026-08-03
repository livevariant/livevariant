import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, swaggerPage } from "./openapi.js";
import { TOOLS } from "./tools.js";
import { toolPath } from "./types.js";

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument({ serverUrl: "https://livevariant.com" });
  const paths = doc.paths as Record<string, any>;

  it("documents exactly the tools that exist, and no others", () => {
    // The document is generated from the registry precisely so it cannot
    // describe an endpoint the server does not serve.
    expect(Object.keys(paths).sort()).toEqual(
      TOOLS.map(t => toolPath(t.name)).sort()
    );
  });

  it("carries each tool's own description into the operation", () => {
    for (const tool of TOOLS) {
      const op = paths[toolPath(tool.name)].post;
      expect(op.operationId).toBe(tool.name);
      expect(op.summary).toBe(tool.summary);
      expect(op.description).toBe(tool.description);
    }
  });

  it("turns the zod schemas into real JSON Schema", () => {
    const build = paths["/api/v1/build-test"].post;
    const schema = build.requestBody.content["application/json"].schema;
    expect(schema.type).toBe("object");
    // Neither spelling is individually required (exactly one of the two).
    expect(schema.required ?? []).not.toContain("variants");
    expect(schema.properties.variants.type).toBe("array");
    expect(schema.properties.slots.type).toBe("object");
    // Field descriptions have to survive: they are how a caller learns
    // what a variant may contain without reading our source.
    expect(schema.properties.variants.items.properties.url.description).toMatch(
      /redirect/i
    );
  });

  it("declares no security, because there is none to declare", () => {
    // A test's authority is its config and its stats secret, both passed
    // in the body. There is no key to put in a header.
    expect(doc.security).toBeUndefined();
    expect((doc.components as any).securitySchemes).toBeUndefined();
  });

  it("renders a docs page pointed at the spec", () => {
    const page = swaggerPage("/openapi.json");
    expect(page).toContain('url: "/openapi.json"');
    expect(page).toContain("swagger-ui");
  });
});
