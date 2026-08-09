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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Refuses to release a lockfile that has already lost its platform
 * variants, because publishing one is how a green laptop hands CI a tree
 * it cannot build.
 *
 * npm has a standing bug (npm/cli#7961, #4828): an install with a
 * node_modules present prunes the os/cpu variants that machine does not
 * use. A Mac therefore drops every linux binary, silently, with no error
 * and no warning. It has bitten this repo twice, once through nx's
 * lock-file step during a release and once through a manual `npm install`
 * meant to repair the first one, which took all eleven non-darwin
 * @tailwindcss/oxide binaries with it and left Linux unable to load
 * tailwind at all.
 *
 * The invariant is simple: a package that declares optional dependencies
 * has an entry for every one of them. That is what a complete lockfile
 * looks like, and a pruned one fails it immediately.
 */
function assertLockIsCrossPlatform() {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const installed = new Set(
    Object.keys(lock.packages)
      .filter(key => key.includes("node_modules/"))
      .map(key =>
        key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length)
      )
  );
  const missing = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (!installed.has(name)) {
        missing.push(
          `${name} (optional dependency of ${key || "the workspace root"})`
        );
      }
    }
  }
  if (missing.length === 0) {
    return;
  }
  console.error(
    `release: package-lock.json is missing ${missing.length} optional ` +
      "dependency entries, which is what a lockfile pruned on one platform " +
      "looks like:\n  " +
      missing.slice(0, 10).join("\n  ") +
      (missing.length > 10 ? `\n  ...and ${missing.length - 10} more` : "") +
      "\n\nRebuild it from scratch, never by rerunning npm install over it:\n" +
      "  rm -rf node_modules package-lock.json && npm install\n" +
      "Commit that on its own, then release."
  );
  process.exit(1);
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

/**
 * Writes the version bump into package-lock.json by hand, because a
 * version bump does not need a resolver and running one is what breaks
 * the lockfile.
 *
 * npm's install is the wrong tool here twice over. It re-derives a whole
 * dependency tree to change some numbers it was already told, and while
 * doing so it prunes the platform variants this machine does not use
 * (see assertLockIsCrossPlatform). nx's own lock-file step is that same
 * install, which is why it is turned off in nx.json.
 *
 * What actually changes is small and knowable: each workspace package's
 * own `version`, and the specifier its siblings use for it, since the
 * group pins itself exactly. Third-party specifiers are never touched,
 * so no entry can appear or vanish, which is exactly the property that
 * makes this safe where an install is not.
 */
function syncLockToManifests() {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const workspaceNames = new Set();
  const dirs = [];
  for (const dir of Object.keys(lock.packages)) {
    if (dir === "" || dir.includes("node_modules/")) {
      continue;
    }
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    dirs.push([dir, manifest]);
    if (manifest.name) {
      workspaceNames.add(manifest.name);
    }
  }
  const DEP_FIELDS = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies"
  ];
  for (const [dir, manifest] of dirs) {
    const entry = lock.packages[dir];
    entry.version = manifest.version;
    for (const field of DEP_FIELDS) {
      const declared = manifest[field];
      const locked = entry[field];
      if (!declared || !locked) {
        continue;
      }
      for (const [name, spec] of Object.entries(declared)) {
        // Only our own packages. A third-party specifier that changed
        // would need a resolved entry to go with it, which is a real
        // install, not a release.
        if (workspaceNames.has(name) && locked[name] !== undefined) {
          locked[name] = spec;
        }
      }
    }
  }
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
}

assertReleaseGroupComplete();
assertLockIsCrossPlatform();

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

// nx wrote the new versions into every package.json; this puts the same
// numbers in the lockfile without running an install. The check before it
// is the belt to that braces: nx's own lock-file step is disabled in
// nx.json, and if a future nx ignores that flag and installs anyway, the
// pruning shows up here as a hard failure instead of as a red CI on the
// release commit.
assertNothingPruned(lockedPackagesBefore);
syncLockToManifests();
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
