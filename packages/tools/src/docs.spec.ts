import { describe, expect, it } from "vitest";
import { renderLlmsTxt, renderMcpInstructions, renderSkillMd } from "./docs.js";
import { TOOLS } from "./tools.js";
import { IDENTITY_EXCLUDED } from "@livevariant/core";

/**
 * The single source of truth renders complete and origin-correct: every
 * agent-facing surface (SKILL.md, /llms.txt, MCP instructions) comes
 * from these functions, so what is pinned here is pinned everywhere.
 */
describe("the agent docs source", () => {
  it("renders the skill with every tool and no unfilled placeholders", () => {
    const skill = renderSkillMd("https://self.example");
    for (const tool of TOOLS) {
      expect(skill).toContain(`\`${tool.name}\``);
    }
    // Origin substitution reached every templated section.
    expect(skill).toContain("https://self.example/api/v1/");
    expect(skill).toContain("https://self.example/sdk.js");
    expect(skill).not.toContain("{origin}");
    expect(skill).not.toContain("{{API_URL}}");
    // The sections agents most need exist.
    for (const heading of [
      "## The three shapes of a test",
      "## Every config parameter",
      "## Creating a test with nothing but a URL",
      "## Running a test on a website",
      "## No image variants yet? Make them",
      "## Saving a test to an account"
    ]) {
      expect(skill).toContain(heading);
    }
  });

  it("renders llms.txt against the deployment's own origin", () => {
    const txt = renderLlmsTxt("https://self.example/");
    expect(txt).toContain("https://self.example/skills/livevariant/SKILL.md");
    expect(txt).toContain("https://self.example/mcp");
    expect(txt).toContain(
      "https://self.example/llms.txt".replace("/llms.txt", "/openapi.json")
    );
    expect(txt).not.toContain("self.example//");
  });

  it("keeps the MCP instructions aligned with the skill's core claims", () => {
    const instructions = renderMcpInstructions();
    expect(instructions).toContain("stats secret exactly once");
    expect(instructions).toContain("manage URL");
    expect(instructions).toContain("upload_image");
  });

  it("points an MCP-only client at the full skill, per deployment", () => {
    // Someone who installed nothing but the MCP server must still be
    // able to find the recipes: the resource, the URL, the skill install.
    const instructions = renderMcpInstructions("https://self.example/");
    expect(instructions).toContain(
      "https://self.example/skills/livevariant/SKILL.md"
    );
    expect(instructions).toContain("`skill` resource");
    expect(instructions).toContain("npx skills add livevariant/livevariant");
    expect(instructions).toContain(
      "https://github.com/livevariant/livevariant"
    );
    expect(instructions).not.toContain("self.example//");
  });

  it("tells the agent to propose the template spelling on its own", () => {
    // The human will not know to ask: when newsletter templates are in
    // play, the emailTemplate deliverable and its three-link shape must
    // be offered unprompted, on every surface.
    const skill = renderSkillMd();
    expect(skill).toMatch(/Propose this\s+unprompted/);
    expect(skill).toMatch(/Propose it\s+unprompted/);
    expect(skill).toMatch(/three links|wires THREE/i);
    const instructions = renderMcpInstructions();
    expect(instructions).toContain("emailTemplate spelling unprompted");
    expect(instructions).toContain("three links");
  });

  it("tells an agent without network access to ask for an install", () => {
    // The skill's fallback ladder must end with every install route, not
    // with a silent dead end.
    const skill = renderSkillMd("https://self.example");
    expect(skill).toContain("Ask for an install");
    expect(skill).toContain("/plugin marketplace add livevariant/livevariant");
    expect(skill).toContain("/plugin install livevariant@livevariant");
    expect(skill).toContain("codex plugin marketplace add");
    expect(skill).toContain("https://self.example/mcp");
    expect(skill).toContain("npx -y @livevariant/mcp");
    expect(skill).toContain("npx skills add livevariant/livevariant");
    expect(skill).toContain("https://self.example/builder");
    // Open source: reading the code is always an option, via the README.
    expect(skill).toContain("https://github.com/livevariant/livevariant");
  });
});

describe("the parameter table matches the identity hash", () => {
  it("agrees with core's IDENTITY_EXCLUDED about every listed field", () => {
    const skill = renderSkillMd();
    const row = (field: string) => {
      const match = skill.match(
        // The priors row bolds its "no"; asterisks are cosmetic.
        new RegExp(`^\\| \`${field}[^|]*\` \\| \\**(yes|no)\\** \\|`, "m")
      );
      expect(match, `table row for ${field}`).not.toBeNull();
      return match![1];
    };
    for (const excluded of IDENTITY_EXCLUDED) {
      if (skill.includes(`\`${excluded}\``)) {
        expect(row(excluded), `${excluded} is identity-excluded`).toBe("no");
      }
    }
    // Spot checks on the identity side, where a wrong "no" would cost
    // an agent a test's history.
    for (const identity of ["rewardEvents", "region", "name"]) {
      expect(row(identity), `${identity} is in the identity hash`).toBe("yes");
    }
  });
});
