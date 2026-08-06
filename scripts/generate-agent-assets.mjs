#!/usr/bin/env node
/**
 * Generates every agent-facing artifact from two sources and nothing else:
 * the tool registry in @livevariant/tools, and skill/SKILL.template.md.
 *
 * Output (all committed, because this repository is public and therefore IS
 * the skill repository people install from):
 *   skills/livevariant/SKILL.md       the skill itself (its own directory,
 *                                     so `npx skills add` copies just that)
 *   plugins/{claude,chatgpt,copilot}/ one bundle per platform
 *   .claude-plugin/marketplace.json   so `/plugin marketplace add` works here
 *   .agents/plugins/marketplace.json  the same for Codex
 *
 * Run `npm run generate` after touching the registry or the template. CI
 * regenerates and fails on any diff, so a tool added without regenerating
 * cannot reach a release with a SKILL that fails to mention it.
 *
 * Reads the registry from the BUILT package, so `npm run build` comes first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "@livevariant/tools";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_NAME = "livevariant";
const TEMPLATE = path.join(root, "skill", "SKILL.template.md");
const SKILL = path.join(root, "skills", PLUGIN_NAME, "SKILL.md");
const TOOLS_MARKER = "<!-- TOOLS_TABLE -->";

export const PLUGIN = {
  name: PLUGIN_NAME,
  displayName: "LiveVariant",
  // The npm packages' lockstep version, read rather than written so a
  // release bump (scripts/release.mjs regenerates after versioning) flows
  // into every manifest without a second place to edit.
  version: JSON.parse(
    fs.readFileSync(path.join(root, "packages", "mcp", "package.json"), "utf8")
  ).version,
  description:
    "Run A/B tests that pick their own winner. Build tests from a set of " +
    "variants, get URLs for email or web, and read results with real win " +
    "probabilities instead of eyeballed conversion rates.",
  homepage: "https://livevariant.com",
  repository: "https://github.com/livevariant/livevariant",
  author: "LiveVariant",
  category: "Productivity",
  license: "AGPL-3.0",
  apiUrl: "https://livevariant.com",
  mcpUrl: "https://livevariant.com/mcp",
  // Directory listings ask for these; they describe the HOSTED service
  // the bundled MCP endpoint points at (apps/web/src/pages/Terms.tsx).
  termsUrl: "https://livevariant.com/terms",
  privacyUrl: "https://livevariant.com/privacy",
  supportEmail: "hi@livevariant.com"
};

/**
 * The hosted endpoint rather than a local stdio process: it needs nothing
 * installed, works in clients that cannot spawn one, and there is no
 * account to connect because every tool carries its own authority in its
 * arguments. `npx -y @livevariant/mcp` remains available for anyone who
 * would rather run it themselves or point at a self-hosted deployment.
 */
function mcpServersConfig() {
  return {
    mcpServers: {
      [PLUGIN.name]: {
        type: "http",
        url: PLUGIN.mcpUrl
      }
    }
  };
}

/** Left-aligned GFM table, padded so the committed file is stable. */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i].length))
  );
  const line = cells =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map(w => "-".repeat(w)).join(" | ")} |`,
    ...rows.map(line)
  ].join("\n");
}

export function renderToolsTable() {
  return renderTable(
    ["Tool", "What it does"],
    TOOLS.map(tool => [`\`${tool.name}\``, tool.summary])
  );
}

export function renderSkill(template) {
  if (!template.includes(TOOLS_MARKER)) {
    throw new Error(`SKILL.template.md is missing the ${TOOLS_MARKER} marker`);
  }
  return template
    .replace(TOOLS_MARKER, `## Tools\n\n${renderToolsTable()}`)
    .replaceAll("{{API_URL}}", PLUGIN.apiUrl);
}

export function generateSkill() {
  return renderSkill(fs.readFileSync(TEMPLATE, "utf8"));
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function writeJson(file, data) {
  writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeSkillInto(dir, skill) {
  writeFile(path.join(dir, "skills", PLUGIN.name, "SKILL.md"), skill);
}

function buildClaude(dir, skill) {
  writeJson(path.join(dir, ".claude-plugin", "plugin.json"), {
    name: PLUGIN.name,
    description: PLUGIN.description,
    version: PLUGIN.version,
    author: { name: PLUGIN.author },
    homepage: PLUGIN.homepage,
    license: PLUGIN.license
  });
  writeJson(path.join(dir, ".mcp.json"), mcpServersConfig());
  writeSkillInto(dir, skill);
}

function buildChatgpt(dir, skill) {
  writeJson(path.join(dir, ".codex-plugin", "plugin.json"), {
    name: PLUGIN.name,
    description: PLUGIN.description,
    version: PLUGIN.version,
    author: { name: PLUGIN.author },
    homepage: PLUGIN.homepage,
    repository: PLUGIN.repository,
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: PLUGIN.displayName,
      shortDescription: "A/B tests that pick their own winner.",
      longDescription:
        "Build bandit-driven A/B tests from a set of variants, get ready-made " +
        "URLs for email and web, warm-start them from what you expect, and " +
        "read results with genuine win probabilities and a stop/continue " +
        "call rather than eyeballed conversion rates.",
      developerName: PLUGIN.author,
      category: PLUGIN.category,
      capabilities: ["MCP", "Analytics", "Experimentation"],
      websiteURL: PLUGIN.homepage,
      termsOfServiceURL: PLUGIN.termsUrl,
      privacyPolicyURL: PLUGIN.privacyUrl,
      supportEmail: PLUGIN.supportEmail,
      defaultPrompt: [
        "Set up an A/B test for two email hero images.",
        "What does this LiveVariant link do?",
        "Which variant is winning, and can I call it yet?"
      ]
    }
  });
  writeJson(path.join(dir, ".mcp.json"), mcpServersConfig());
  writeSkillInto(dir, skill);
}

function buildCopilot(dir, skill) {
  writeJson(path.join(dir, "manifest.json"), {
    name: PLUGIN.displayName,
    version: PLUGIN.version,
    description: PLUGIN.description,
    agentSkills: [`skills/${PLUGIN.name}`]
  });
  writeSkillInto(dir, skill);
}

const PLATFORMS = [
  ["claude", buildClaude],
  ["chatgpt", buildChatgpt],
  ["copilot", buildCopilot]
];

export function generateAll() {
  const skill = generateSkill();
  writeFile(SKILL, skill);

  for (const [platform, build] of PLATFORMS) {
    const dir = path.join(root, "plugins", platform);
    fs.rmSync(dir, { recursive: true, force: true });
    build(dir, skill);
  }

  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: PLUGIN.name,
    owner: { name: PLUGIN.author, url: PLUGIN.homepage },
    plugins: [
      {
        name: PLUGIN.name,
        source: "./plugins/claude",
        description: PLUGIN.description,
        version: PLUGIN.version,
        author: { name: PLUGIN.author },
        homepage: PLUGIN.homepage
      }
    ]
  });

  writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
    name: PLUGIN.name,
    interface: { displayName: PLUGIN.displayName },
    plugins: [
      {
        name: PLUGIN.name,
        source: { source: "local", path: "./plugins/chatgpt" },
        policy: { installation: "AVAILABLE", authentication: "NONE" },
        category: PLUGIN.category
      }
    ]
  });

  return { tools: TOOLS.length, platforms: PLATFORMS.map(([p]) => p) };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { tools, platforms } = generateAll();
  console.log(
    `[generate-agent-assets] ${tools} tools -> skills/livevariant/SKILL.md + plugins/{${platforms.join(",")}}`
  );
}
