import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "./tools.js";

/**
 * The SKILL and the plugin bundles are generated from the tool registry, so
 * the guard that matters is that the committed files still match a fresh
 * render. `npm run generate` is the fix when this fails.
 *
 * The generator is checked in a separate CI step (regenerate, then fail on
 * any git diff), which covers the plugin manifests too. This test covers
 * the part a person is most likely to break: adding a tool and shipping a
 * SKILL that does not mention it.
 */
const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);
const skill = fs.readFileSync(
  path.join(root, "skills", "livevariant", "SKILL.md"),
  "utf8"
);

describe("the generated SKILL", () => {
  it("documents every tool and invents none", () => {
    for (const tool of TOOLS) {
      expect(skill).toContain(`\`${tool.name}\``);
      expect(skill).toContain(tool.summary);
    }
    // Only the Tools table: the parameter reference also has code-styled
    // first columns, and those are config fields, not tools.
    const toolsSection = skill.split("## Tools")[1].split("\n## ")[0];
    const documented = [...toolsSection.matchAll(/^\| `([a-z_]+)`/gm)].map(
      m => m[1]
    );
    expect(documented.sort()).toEqual(TOOLS.map(t => t.name).sort());
  });

  it("still carries the parts an agent must not miss", () => {
    // Everything downstream fails confusingly if these go unsaid.
    expect(skill).toMatch(/stats secret is shown exactly once/i);
    expect(skill).toMatch(/editing a variant creates a different test/i);
    expect(skill).toMatch(/distinct `\?id=`/);
    // The HTTP fallback exists precisely for agents that cannot install MCP.
    expect(skill).toMatch(/api\/v1\//);
    // And below that, the no-network-at-all rung: ask the human to
    // install, with every route listed.
    expect(skill).toMatch(/Ask for an install/);
    expect(skill).toMatch(/plugin install livevariant@livevariant/);
    expect(skill).toMatch(/npx -y @livevariant\/mcp/);
    expect(skill).toMatch(/npx skills add livevariant\/livevariant/);
  });

  it("is shipped to every platform bundle unchanged", () => {
    for (const platform of ["claude", "chatgpt", "copilot"]) {
      const bundled = fs.readFileSync(
        path.join(
          root,
          "plugins",
          platform,
          "skills",
          "livevariant",
          "SKILL.md"
        ),
        "utf8"
      );
      expect(bundled).toBe(skill);
    }
  });

  it("wires each bundle to the hosted MCP endpoint", () => {
    // Hosted rather than a local process: an installed plugin has to work
    // without the user first publishing or installing anything.
    for (const platform of ["claude", "chatgpt"]) {
      const config = JSON.parse(
        fs.readFileSync(
          path.join(root, "plugins", platform, ".mcp.json"),
          "utf8"
        )
      );
      expect(config.mcpServers.livevariant.type).toBe("http");
      expect(config.mcpServers.livevariant.url).toMatch(/^https:\/\/.+\/mcp$/);
    }
  });
});
