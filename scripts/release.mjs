#!/usr/bin/env node
/**
 * Releases every publishable package in lockstep: one version for the
 * whole group, every one of them published on every release, changed or
 * not. That is deliberate. The packages pin each other exactly, so a
 * partial publish would leave npm with combinations that never existed
 * in git, and "which versions work together" becomes a question nobody
 * should ever have to ask.
 *
 *   npm run release            interactive version prompt
 *   npm run release patch      or minor / major / an exact x.y.z
 *   npm run release:dry        walk the whole flow, write nothing
 *
 * Steps, and why the order matters:
 *   1. nx release version: bumps every package.json in the group and
 *      every inter-package dependency (fixed group), building first via
 *      preVersionCommand.
 *
 *      A package missing from `release.projects` in nx.json is missing
 *      from all of this: it keeps its old version, never publishes, and
 *      nothing fails. Adding a package means adding it there too.
 *   2. regenerate the agent assets: the plugin manifests carry the
 *      version, and regenerating after the bump is what keeps CI's
 *      drift check green on the release commit.
 *   3. one commit, one v{version} tag.
 *   4. nx release publish, every package in the group.
 *
 * Publishing needs `npm login` (or NPM_TOKEN in CI) with rights on the
 * @livevariant org; everything before the publish step works without it.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// nx.json carries comments, so it needs nx's own tolerant parser rather
// than JSON.parse.
import { parseJson } from "@nx/devkit";
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

/**
 * Every publishable package must be in the release group, and nothing
 * checks that but this.
 *
 * A package left out of `release.projects` does not fail anything: it
 * keeps its old version, never publishes, and the release reports
 * success. @livevariant/postgres shipped that way, sitting at 0.0.3 on
 * disk and absent from npm entirely while every other package moved to
 * 0.0.4, and the only symptom was an application that could not install
 * it. Since the packages pin each other exactly, one missing member also
 * means the versions on npm describe a combination that never existed
 * in git, which is the exact failure the lockstep group exists to
 * prevent.
 */
function assertReleaseGroupComplete() {
  const nx = parseJson(readFileSync("nx.json", "utf8"));
  const declared = new Set(nx.release?.projects ?? []);
  const missing = readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(dir => join("packages", dir.name, "package.json"))
    .filter(existsSync)
    .map(file => JSON.parse(readFileSync(file, "utf8")))
    .filter(pkg => pkg.private !== true && !declared.has(pkg.name))
    .map(pkg => pkg.name);
  if (missing.length > 0) {
    console.error(
      `release: ${missing.join(", ")} publishable but not in ` +
        "release.projects (nx.json); it would silently keep its old " +
        "version and never reach npm"
    );
    process.exit(1);
  }
}

/**
 * A release rewrites package-lock.json, so it has to run on the npm the
 * lockfile is pinned to, and only this checks that.
 *
 * npm versions disagree about what belongs in a lockfile, and each one
 * rewrites the other's answer. npm 11.6.2 wrote the v0.0.5 lock without
 * entries for the nested @emnapi/*@2.0.0-alpha.3 that
 * @rolldown/binding-wasm32-wasi pins, and the npm 11.16.0 that Node
 * 24.18.0 bundles refused to install it: "Missing:
 * @emnapi/core@2.0.0-alpha.3 from lock file". They also disagree about
 * devOptional versus dev, so releasing on the wrong one buries the real
 * change under hundreds of lines of flag churn. The same pin drives the
 * npm install step in ci.yml, which is what makes writer and reader the
 * same program.
 */
function assertPinnedNpm() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const pinned = pkg.packageManager?.match(/^npm@(.+)$/)?.[1];
  if (!pinned) {
    console.error(
      'release: package.json has no "packageManager": "npm@x.y.z"; the ' +
        "lockfile this release writes would be at the mercy of whatever " +
        "npm happens to be active"
    );
    process.exit(1);
  }
  const active = out("npm --version");
  if (active !== pinned) {
    console.error(
      `release: npm ${active} is active but package.json pins npm ` +
        `${pinned}. Run \`npm i -g npm@${pinned}\` and release again.`
    );
    process.exit(1);
  }
}

const lockedPackages = () =>
  new Set(
    Object.keys(JSON.parse(readFileSync("package-lock.json", "utf8")).packages)
  );

/**
 * A release changes version numbers, so every package the lockfile
 * listed before it must still be listed after. npm does not guarantee
 * that: rewriting a lockfile against a node_modules that only holds the
 * current machine's platform binaries can drop the other platforms'
 * entries, silently and with no error. That is how main went red twice.
 * The v0.0.5 rewrite dropped the nested @emnapi/* that
 * @rolldown/binding-wasm32-wasi pins, and the manual regeneration meant
 * to repair it dropped all eleven non-darwin @tailwindcss/oxide-*
 * binaries instead, which left Linux unable to load tailwind at all.
 *
 * Both were invisible on the releaser's machine and only failed in CI,
 * on a commit whose only intended content was the version bump.
 */
function assertNothingPruned(before) {
  const after = lockedPackages();
  const dropped = [...before].filter(name => !after.has(name));
  if (dropped.length === 0) return;
  console.error(
    `release: the lockfile rewrite dropped ${dropped.length} package(s) ` +
      "that a release has no business removing:\n  " +
      dropped.join("\n  ") +
      "\n\nNothing was committed or tagged. Reset with `git reset --hard`, " +
      "rebuild the lockfile from scratch with `rm -rf node_modules " +
      "package-lock.json && npm install`, commit that on its own, then " +
      "release again."
  );
  process.exit(1);
}

assertReleaseGroupComplete();
assertPinnedNpm();

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

const lockedPackagesBefore = lockedPackages();

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

// nx's lock-file update runs `npm install --package-lock-only`, which
// only reasons about the lockfile. This full install writes the same
// lockfile AND makes node_modules match it, so the publish step below
// packs the versions the release commit claims rather than whatever the
// tree held before the bump.
run("npm install");
assertNothingPruned(lockedPackagesBefore);
run("git add package-lock.json");

// The generated manifests embed the version, so they are part of the
// release commit or the drift check fails on it.
run("npm run generate");
run("git add skills plugins .claude-plugin .agents");

run(`git commit -m "release: v${workspaceVersion}"`);
// Annotated, not lightweight: `git push --follow-tags` only pushes
// annotated tags, and a tag that stays local defeats its purpose.
run(`git tag -a v${workspaceVersion} -m "v${workspaceVersion}"`);

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
