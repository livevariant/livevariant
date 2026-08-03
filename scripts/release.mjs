#!/usr/bin/env node
/**
 * Releases every publishable package in lockstep: one version for the
 * whole group, all five published on every release, changed or not. That
 * is deliberate. The packages pin each other exactly, so a partial
 * publish would leave npm with combinations that never existed in git,
 * and "which versions work together" becomes a question nobody should
 * ever have to ask.
 *
 *   npm run release            interactive version prompt
 *   npm run release patch      or minor / major / an exact x.y.z
 *   npm run release:dry        walk the whole flow, write nothing
 *
 * Steps, and why the order matters:
 *   1. nx release version: bumps all five package.jsons and every
 *      inter-package dependency (fixed group), building first via
 *      preVersionCommand.
 *   2. regenerate the agent assets: the plugin manifests carry the
 *      version, and regenerating after the bump is what keeps CI's
 *      drift check green on the release commit.
 *   3. one commit, one v{version} tag.
 *   4. nx release publish, all five packages.
 *
 * Publishing needs `npm login` (or NPM_TOKEN in CI) with rights on the
 * @livevariant org; everything before the publish step works without it.
 */
import { execSync } from "node:child_process";
import { releasePublish, releaseVersion } from "nx/release";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");
const specifier = args.find(a => !a.startsWith("--"));
// npm accounts with 2FA on writes need a fresh one-time password at the
// publish step: `npm run release patch -- --otp=123456`. Without it npm
// answers EOTP and the retry is `npx nx release publish --otp=...`.
const otp = args.find(a => a.startsWith("--otp="))?.slice("--otp=".length);

const run = cmd => execSync(cmd, { stdio: "inherit" });
const out = cmd => execSync(cmd, { encoding: "utf8" }).trim();

if (out("git status --porcelain") !== "") {
  console.error("release: working tree is not clean; commit or stash first");
  process.exit(1);
}
if (out("git branch --show-current") !== "main" && !dryRun) {
  console.error("release: releases are cut from main");
  process.exit(1);
}

// No v* tag yet means nx has no previous release to diff against.
const firstRelease = out("git tag --list 'v*'") === "";

const { workspaceVersion } = await releaseVersion({
  specifier,
  dryRun,
  verbose,
  firstRelease,
  stageChanges: true,
  gitCommit: false,
  gitTag: false
});

// nx reports null when it decides no bump is needed; without this guard
// the script would happily commit and tag "vnull".
if (!workspaceVersion) {
  console.error("release: no version was determined; nothing to release");
  process.exit(1);
}

if (dryRun) {
  console.log(`release: dry run complete (would release v${workspaceVersion})`);
  process.exit(0);
}

// The generated manifests embed the version, so they are part of the
// release commit or the drift check fails on it.
run("npm run generate");
run("git add SKILL.md plugins .claude-plugin .agents");

run(`git commit -m "release: v${workspaceVersion}"`);
run(`git tag v${workspaceVersion}`);

const results = await releasePublish({ dryRun, verbose, firstRelease, otp });
const failed = Object.values(results).filter(r => r.code !== 0).length;
if (failed > 0) {
  console.error(
    `release: ${failed} package(s) failed to publish. The commit and tag ` +
      "exist; fix the npm problem (usually auth: npm login) and run " +
      "`npx nx release publish` to retry publishing without re-versioning."
  );
  process.exit(1);
}
console.log(
  `release: v${workspaceVersion} published. Push it: git push --follow-tags`
);
