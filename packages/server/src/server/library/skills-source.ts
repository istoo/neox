import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { LibraryPaths, StoredLibrary, StoredSkill, StoredSkillSource } from "./store.js";
import { copyTree } from "./store.js";
import { librarySkillPath } from "./skills.js";
import { hashSkillTree } from "./skill-tree.js";

export interface SkillCandidate {
  name: string;
  description: string;
  /** The folder holding SKILL.md. */
  dir: string;
  /** Where it sits inside the source root. */
  relative: string;
  hash: string;
}

export interface SkillSourceInput {
  kind: "folder" | "git" | "github";
  /** A local folder for kind "folder". */
  dir?: string;
  /** owner/repo for GitHub, a git URL otherwise. */
  repo?: string;
  ref?: string;
  /** A subfolder of the source to look in. */
  path?: string;
}

export interface SkillCheckView {
  name: string;
  /** A newer commit or different content is upstream. */
  available: boolean;
  /** The upstream folder is gone. */
  gone: boolean;
}

const MAX_FIND_DEPTH = 3;
const CLONE_TIMEOUT_MS = 60_000;

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

function descriptionFrom(raw: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) {
    return "";
  }
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry));
  if (!line) {
    return "";
  }
  return line
    .slice(line.indexOf(":") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

async function findUnder(root: string, current: string, depth: number): Promise<SkillCandidate[]> {
  const found: SkillCandidate[] = [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return found;
  }
  let hasSkill = false;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") {
      hasSkill = true;
    }
  }
  if (hasSkill) {
    const name = path.basename(current);
    const description = descriptionFrom(
      await readFile(path.join(current, "SKILL.md"), "utf8").catch(() => ""),
    );
    found.push({
      name,
      description,
      dir: current,
      relative: path.relative(root, current),
      hash: await hashSkillTree(current),
    });
    return found;
  }
  if (depth >= MAX_FIND_DEPTH) {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
      continue;
    }
    found.push(...(await findUnder(root, path.join(current, entry.name), depth + 1)));
  }
  return found;
}

/** Every skill folder in a source folder, for the install sheet's picker. */
export async function findSkillsIn(root: string): Promise<SkillCandidate[]> {
  const candidates = await findUnder(root, root, 0);
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.name)) {
      return false;
    }
    seen.add(candidate.name);
    return true;
  });
}

async function gitClone(
  url: string,
  ref: string | undefined,
  destination: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const args = ["clone", "--depth", "1", "--quiet"];
  if (ref && ref.length > 0) {
    args.push("--branch", ref);
  }
  args.push(url, destination);
  const result = await run("git", args, { env, timeoutMs: CLONE_TIMEOUT_MS });
  if (result.timedOut) {
    throw new Error("Cloning the skill's repository timed out");
  }
  if (result.code !== 0) {
    throw new Error(result.output.trim() || `git clone exited with ${result.code}`);
  }
  const head = await run("git", ["rev-parse", "HEAD"], {
    cwd: destination,
    env,
    timeoutMs: 10_000,
  });
  return head.code === 0 ? head.output.trim() : "";
}

export interface ResolvedSkillSource {
  root: string;
  commit?: string;
  candidates: SkillCandidate[];
  cleanup: () => Promise<void>;
}

/**
 * Makes the source readable once: a clone goes to a temporary folder under
 * the library, a local folder is read where it is. Clone output is removed
 * after use.
 */
export async function resolveSkillSource(
  input: SkillSourceInput,
  options: { paths: LibraryPaths; env: NodeJS.ProcessEnv },
): Promise<ResolvedSkillSource> {
  let root: string;
  let commit: string | undefined;
  let temp: string | null = null;
  if (input.kind === "folder") {
    if (!input.dir || input.dir.trim().length === 0) {
      throw new Error("A folder is needed");
    }
    root = input.dir.trim();
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) {
      throw new Error(`${root} is not a folder`);
    }
  } else {
    const repo = input.repo?.trim();
    if (!repo) {
      throw new Error("A repository is needed");
    }
    const url =
      input.kind === "github" && !repo.includes("://")
        ? `https://github.com/${repo.replace(/^\/+|\/+$/g, "")}.git`
        : repo;
    const tempRoot = path.join(options.paths.dir, "tmp");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    temp = await mkdtemp(path.join(tempRoot, "skill-"));
    const cloneDir = path.join(temp, "repo");
    commit = await gitClone(url, input.ref, cloneDir, options.env);
    root = input.path ? path.join(cloneDir, input.path) : cloneDir;
  }
  const candidates = await findSkillsIn(root);
  return {
    root,
    commit,
    candidates,
    cleanup: async () => {
      if (temp) {
        await rm(temp, { recursive: true, force: true });
      }
    },
  };
}

/** Stores the picked candidates as library skills, with their source. */
export async function installSkillCandidates(
  library: StoredLibrary,
  paths: LibraryPaths,
  source: StoredSkillSource,
  commit: string | undefined,
  candidates: readonly SkillCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    if (library.skills.some((skill) => skill.name === candidate.name)) {
      throw new Error(`The library already has a skill called ${candidate.name}`);
    }
    await mkdir(paths.skillsDir, { recursive: true });
    await copyTree(candidate.dir, librarySkillPath(paths, candidate.name));
    const stored: StoredSkill = {
      name: candidate.name,
      agents: [],
      source: { ...source, path: candidate.relative },
      hash: candidate.hash,
      ...(commit ? { commit } : {}),
    };
    library.skills.push(stored);
  }
  library.skills.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Checks each skill's source once. A clone is made per repository, so the
 * whole library costs one clone per distinct source.
 */
export async function checkSkillSources(
  library: StoredLibrary,
  options: { paths: LibraryPaths; env: NodeJS.ProcessEnv },
): Promise<SkillCheckView[]> {
  const checks: SkillCheckView[] = [];
  const cache = new Map<string, ResolvedSkillSource>();
  for (const skill of library.skills) {
    const source = skill.source;
    if (!source) {
      continue;
    }
    const key = `${source.kind}:${source.dir ?? source.repo ?? ""}@${source.ref ?? ""}`;
    let resolved = cache.get(key);
    if (!resolved) {
      try {
        resolved = await resolveSkillSource(
          {
            kind: source.kind,
            ...(source.dir ? { dir: source.dir } : {}),
            ...(source.repo ? { repo: source.repo } : {}),
            ...(source.ref ? { ref: source.ref } : {}),
          },
          options,
        );
        cache.set(key, resolved);
      } catch {
        checks.push({ name: skill.name, available: false, gone: true });
        continue;
      }
    }
    const candidate = resolved.candidates.find((entry) => entry.name === skill.name);
    if (!candidate) {
      checks.push({ name: skill.name, available: false, gone: true });
      continue;
    }
    const commitChanged = Boolean(
      resolved.commit && skill.commit && resolved.commit !== skill.commit,
    );
    const contentChanged = Boolean(skill.hash && candidate.hash !== skill.hash);
    checks.push({
      name: skill.name,
      available: commitChanged || contentChanged,
      gone: false,
    });
  }
  await Promise.all([...cache.values()].map((resolved) => resolved.cleanup()));
  return checks;
}

/** Replaces a skill's folder with the source's current copy. */
export async function updateSkillsFromSources(
  library: StoredLibrary,
  paths: LibraryPaths,
  names: readonly string[],
  options: { paths: LibraryPaths; env: NodeJS.ProcessEnv },
): Promise<void> {
  const wanted = new Set(names);
  const cache = new Map<string, ResolvedSkillSource>();
  try {
    for (const skill of library.skills) {
      if (!wanted.has(skill.name) || !skill.source) {
        continue;
      }
      const source = skill.source;
      const key = `${source.kind}:${source.dir ?? source.repo ?? ""}@${source.ref ?? ""}`;
      let resolved = cache.get(key);
      if (!resolved) {
        // A source that cannot be read is not a skill that disappeared: let
        // the failure surface instead of marking the skill gone.
        resolved = await resolveSkillSource(
          {
            kind: source.kind,
            ...(source.dir ? { dir: source.dir } : {}),
            ...(source.repo ? { repo: source.repo } : {}),
            ...(source.ref ? { ref: source.ref } : {}),
          },
          options,
        );
        cache.set(key, resolved);
      }
      const candidate = resolved.candidates.find((entry) => entry.name === skill.name);
      if (!candidate) {
        skill.gone = true;
        continue;
      }
      const destination = librarySkillPath(paths, skill.name);
      // Copy beside the old folder first, so a failed copy leaves the old one.
      const staging = `${destination}.${randomUUID()}.tmp`;
      try {
        await copyTree(candidate.dir, staging);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
      await replaceSkillDirectory(staging, destination);
      skill.hash = candidate.hash;
      if (resolved.commit) {
        skill.commit = resolved.commit;
      }
      skill.gone = false;
    }
  } finally {
    await Promise.all([...cache.values()].map((resolved) => resolved.cleanup()));
  }
}

/** Moves the finished copy into place, putting the old folder back on failure. */
async function replaceSkillDirectory(staging: string, destination: string): Promise<void> {
  const retired = `${destination}.${randomUUID()}.old`;
  let hadPrevious = false;
  try {
    await rename(destination, retired);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (hadPrevious) {
      await rename(retired, destination).catch(() => undefined);
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (hadPrevious) {
    await rm(retired, { recursive: true, force: true });
  }
}

/** The path inside a clone or folder the skill came from. */
export function sourceForCandidate(
  source: SkillSourceInput,
  candidate: SkillCandidate,
): StoredSkillSource {
  if (source.kind === "folder") {
    return { kind: "folder", dir: path.resolve(source.dir ?? ""), path: candidate.relative };
  }
  return {
    kind: source.kind,
    repo: source.repo,
    ...(source.ref ? { ref: source.ref } : {}),
    path: candidate.relative,
  };
}

/** Where the shared skills folder lives, when the user asked for it. */
export function sharedSkillsDir(homeDir = homedir()): string {
  return path.join(homeDir, ".agents", "skills");
}
