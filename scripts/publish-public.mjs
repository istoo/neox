#!/usr/bin/env node
// Publishes local `main` to the public istoo/neox repo.
//
// Local `main` keeps the full development history (so upstream merges keep working). The
// public `main` carries exactly one commit per version, titled "Neox <version>" with no
// other text: working commit messages never reach the public repo. Publishing again for a
// version that already has a public commit replaces that commit (force-with-lease) instead
// of stacking a new one on top. See docs/release.md, "Neox releases".
//
// Usage: node scripts/publish-public.mjs [--tag] [--dry-run]
//   --tag      also (re)point the annotated tag v<version> at the publish commit
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REMOTE = "origin";
const BRANCH = "main";

function parseArgs(argv) {
  const args = { tag: false, dryRun: false };
  for (const arg of argv) {
    if (arg === "--tag") args.tag = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function git(args, options = {}) {
  // With stdio "inherit" the output goes to the terminal and execFileSync returns null.
  return (execFileSync("git", args, { encoding: "utf8", ...options }) ?? "").trim();
}

function tryGit(args) {
  try {
    return git(args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));

if (git(["status", "--porcelain"]) !== "") {
  throw new Error("The working tree has uncommitted changes; commit them on main first.");
}
if (git(["rev-parse", "--abbrev-ref", "HEAD"]) !== BRANCH) {
  throw new Error(`Run this from the ${BRANCH} branch.`);
}

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const message = `Neox ${version}`;
const tag = `v${version}`;

git(["fetch", REMOTE, BRANCH], { stdio: "inherit" });
const tree = git(["rev-parse", `${BRANCH}^{tree}`]);
const remoteHead = tryGit(["rev-parse", "--verify", `${REMOTE}/${BRANCH}`]);

// A public commit for this version is replaced, so its parent is the previous version.
const remoteMessage = remoteHead === null ? null : git(["log", "-1", "--format=%B", remoteHead]);
const replacesRemoteHead = remoteMessage === message;
const parent = replacesRemoteHead
  ? tryGit(["rev-parse", "--verify", `${remoteHead}^`])
  : remoteHead;

let publishCommit = remoteHead;
if (remoteHead !== null && git(["rev-parse", `${remoteHead}^{tree}`]) === tree) {
  console.log(`${REMOTE}/${BRANCH} already has this tree; nothing new to publish.`);
} else {
  const parentArgs = parent === null ? [] : ["-p", parent];
  publishCommit = git(["commit-tree", tree, ...parentArgs, "-m", message]);
  console.log(
    `${replacesRemoteHead ? "Replace" : "Add"} public commit "${message}": ${publishCommit} (tree ${tree})`,
  );
}

if (args.dryRun) {
  console.log("Dry run: nothing pushed.");
  process.exit(0);
}

if (publishCommit !== remoteHead) {
  const lease =
    remoteHead === null
      ? `--force-with-lease=refs/heads/${BRANCH}:`
      : `--force-with-lease=refs/heads/${BRANCH}:${remoteHead}`;
  git(["push", lease, REMOTE, `${publishCommit}:refs/heads/${BRANCH}`], { stdio: "inherit" });
}
if (args.tag) {
  git(["tag", "-a", "-f", tag, publishCommit, "-m", message]);
  git(["push", "--force", REMOTE, `refs/tags/${tag}`], { stdio: "inherit" });
}
console.log("Published.");
