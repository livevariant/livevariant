#!/usr/bin/env node
/**
 * Releases every publishable package in lockstep: one version for the
 * whole group, every one of them published on every release, changed or
 * not. That is deliberate. The packages pin each other exactly, so a
 * partial publish would leave npm with combinations that never existed
 * in git, and "which versions work together" becomes a question nobody
 * should ever have to ask.
 *
 *   npm run release patch -- --otp=123456     or minor / major / x.y.z
 *   npm run release -- --otp=123456           interactive version prompt
 *   npm run release -- --continue --otp=…     resume after a failed publish
 *   npm run release:dry                       walk the whole flow, write nothing
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
 *   5. git push --follow-tags, so the release commit and tag never sit
 *      local-only after a successful publish.
 *
 * A failed publish (an expired OTP, usually) leaves the commit and tag
 * in place and needs no re-versioning: `--continue` picks the release
 * back up from the v{version} tag on HEAD and reruns steps 4 and 5.
 * nx checks the registry per package and skips versions that already
 * exist, so continuing after a partial publish only sends what is
 * missing.
 *
 * Publishing needs `npm login` (or NPM_TOKEN in CI) with rights on the
 * @livevariant org, plus a fresh one-time password when the account has
 * 2FA on writes. Both are checked before anything happens: discovering
 * an auth problem only at the publish step would leave a commit and tag
 * already cut. A dry run needs neither.
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
const continueRelease = args.includes("--continue");
const specifier = args.find(a => !a.startsWith("--"));
// npm accounts with 2FA on writes need a fresh one-time password at the
// publish step: `npm run release patch -- --otp=123456`. Without it npm
// answers EOTP only after the commit and tag exist, so a real release
// refuses to start without one (NPM_TOKEN covers CI, where automation
// tokens bypass 2FA).
const otp = args.find(a => a.startsWith("--otp="))?.slice("--otp=".length);

const run = cmd => execSync(cmd, { stdio: "inherit" });
const out = cmd => execSync(cmd, { encoding: "utf8" }).trim();

/**
 * Fails before the version bump on anything that would otherwise only
 * fail at the publish step, where the commit and tag have already been
 * cut and the failure leaves the release half-done.
 */
function assertReadyToPublish() {
  if (!otp && !process.env.NPM_TOKEN) {
    console.error(
      "release: --otp is required (npm 2FA on writes rejects the publish " +
        "without it, after the commit and tag already exist):\n" +
        "  npm run release patch -- --otp=123456"
    );
    process.exit(1);
  }
  let user;
  try {
    user = execSync("npm whoami", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    console.error(
      "release: not logged in to npm (`npm whoami` failed); run `npm login` " +
        "first"
    );
    process.exit(1);
  }
  console.log(`release: publishing as npm user ${user}`);
}

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

/**
 * The MCP registry manifest (server.json) advertises the published
 * @livevariant/mcp version in two places: the manifest's own version and
 * the npm package entry. Both must track the lockstep release version or
 * the registry describes a package that does not exist.
 */
function syncServerJsonVersion(version) {
  const manifest = parseJson(readFileSync("server.json", "utf8"));
  manifest.version = version;
  for (const pkg of manifest.packages ?? []) {
    pkg.version = version;
  }
  writeFileSync("server.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Publishes the group and pushes the release commit + tag: the last two
 * steps of a release, shared by the normal flow and --continue. nx skips
 * any package whose version already exists on the registry, so rerunning
 * this after a partial publish only sends what is missing.
 */
async function publishAndPush(version, firstRelease) {
  const results = await releasePublish({ dryRun, verbose, firstRelease, otp });
  const failed = Object.values(results).filter(r => r.code !== 0).length;
  if (failed > 0) {
    console.error(
      `release: ${failed} package(s) failed to publish. The commit and tag ` +
        "exist and were NOT pushed; nothing needs re-versioning. Fix the " +
        "npm problem (an expired OTP is the usual one) and continue with a " +
        "fresh OTP:\n" +
        "  npm run release -- --continue --otp=123456\n" +
        "It publishes only the packages still missing from npm, then pushes " +
        "the commit and tag."
    );
    process.exit(1);
  }

  // The packages are live on npm at this point, so the commit and tag must
  // not stay local: --follow-tags pushes both (the tag is annotated for
  // exactly this reason). Explicit refspec, so a stray push.default or
  // upstream config cannot fail the last step of a successful release.
  try {
    run("git push --follow-tags origin main");
  } catch {
    console.error(
      `release: v${version} is PUBLISHED on npm but the push failed; run ` +
        "`git push --follow-tags origin main` yourself so the release " +
        "commit and tag reach the remote."
    );
    process.exit(1);
  }
  console.log(`release: v${version} published and pushed.`);
}

// A dry run stops before the publish step, so it alone runs without npm
// auth or an OTP.
if (!dryRun) {
  assertReadyToPublish();
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

// Resumes a release whose publish (or push) failed: the version bump,
// commit and tag already happened, so the only work left is publish +
// push, keyed off the v{version} tag the failed run left on HEAD.
if (continueRelease) {
  if (dryRun || specifier) {
    console.error(
      "release: --continue takes no version specifier and no --dry-run; it " +
        "republishes exactly what the tag on HEAD says"
    );
    process.exit(1);
  }
  const tags = out("git tag --points-at HEAD --list 'v*'")
    .split("\n")
    .filter(Boolean);
  if (tags.length !== 1) {
    console.error(
      tags.length === 0
        ? "release: --continue expects HEAD to be a release commit, but it " +
            "carries no v* tag; run a normal release instead"
        : `release: HEAD carries ${tags.length} v* tags (${tags.join(", ")}); ` +
            "cannot tell which release to continue"
    );
    process.exit(1);
  }
  const version = tags[0].slice(1);
  // firstRelease matters to nx's registry lookup; "the tag on HEAD is the
  // only v* tag" means the failed run was itself a first release.
  await publishAndPush(version, out("git tag --list 'v*'") === tags[0]);
  process.exit(0);
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
syncServerJsonVersion(workspaceVersion);
run("git add package-lock.json server.json");

// The generated manifests embed the version, so they are part of the
// release commit or the drift check fails on it.
run("npm run generate");
run("git add skills plugins .claude-plugin .agents");

run(`git commit -m "release: v${workspaceVersion}"`);
// Annotated, not lightweight: `git push --follow-tags` only pushes
// annotated tags, and a tag that stays local defeats its purpose.
run(`git tag -a v${workspaceVersion} -m "v${workspaceVersion}"`);

await publishAndPush(workspaceVersion, firstRelease);
