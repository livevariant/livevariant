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
