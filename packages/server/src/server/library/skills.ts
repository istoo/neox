import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { LibraryAgentTarget } from "./paths.js";
import path from "node:path";
import {
  copyTree,
  type LibraryBackup,
  type LibraryPaths,
  type StoredLibrary,
  type StoredSkillSource,
} from "./store.js";
import { fail, markChanged, type AgentSyncContext } from "./result.js";
import { SKILL_MARKER, hashSkillTree, isOwnedCopy, markerFor } from "./skill-tree.js";
import { sharedSkillsDir } from "./skills-source.js";

const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface SkillView {
  name: string;
  description: string;
  agents: string[];
  path: string;
  note: string;
  source?: StoredSkillSource;
  hash?: string;
  commit?: string;
  gone?: boolean;
  /** Turned off on this computer alone; every other computer keeps it. */
  offHere?: boolean;
  /** Its entry in ~/.agents/skills when the library's folder is kept there. */
  shared?: string;
  /** That entry only links to a folder kept elsewhere; only the link goes. */
  sharedElsewhere?: boolean;
  /** Agents that read ~/.agents/skills themselves, so they have it anyway. */
  always?: string[];
  /** The library's copy differs from what was installed. */
  modified: boolean;
}

/**
 * Agents that read ~/.agents/skills besides their own folder (myna
 * internal/library/targets.go:956 `readsShared`), so a skill kept there
 * reaches them whatever the library ticks.
 */
const AGENTS_READING_SHARED = new Set([
  "codex",
  "gemini",
  "opencode",
  "crush",
  "devin",
  "droid",
  "grok",
  "kimi",
]);

function within(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function sharedState(
  dir: string,
  name: string,
  homeDir: string,
  sharedSkills: boolean,
): Promise<Pick<SkillView, "shared" | "sharedElsewhere" | "always">> {
  const sharedDir = sharedSkillsDir(homeDir);
  const entry = path.join(sharedDir, name);
  const info = await lstat(entry).catch(() => null);
  if (info === null) {
    return {};
  }
  const [realEntry, realLibrary] = await Promise.all([
    realpath(entry).catch(() => entry),
    realpath(dir).catch(() => dir),
  ]);
  if (realEntry !== realLibrary) {
    return {};
  }
  // The link the sharedSkills setting writes is Neolix's own, not the
  // user's copy in ~/.agents/skills.
  const link = info.isSymbolicLink() ? await readlink(entry).catch(() => null) : null;
  if (sharedSkills && link !== null && path.resolve(link) === path.resolve(dir)) {
    return {};
  }
  const realShared = await realpath(sharedDir).catch(() => sharedDir);
  return {
    shared: entry,
    ...(within(realLibrary, realShared) ? {} : { sharedElsewhere: true }),
  };
}

function sharedReaders(homeDir: string, targets: readonly LibraryAgentTarget[]): string[] {
  const sharedDir = sharedSkillsDir(homeDir);
  return targets
    .filter((target) => {
      // An uninstalled or desktop-only agent has no folder the library
      // writes (myna skill_handover.go:84).
      if (!target.skillsDir || target.gone === true || target.desktop === true) {
        return false;
      }
      return (
        target.sharedToo === true ||
        AGENTS_READING_SHARED.has(target.id) ||
        path.resolve(target.skillsDir) === path.resolve(sharedDir)
      );
    })
    .map((target) => target.id)
    .sort();
}

function frontmatterDescription(raw: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) {
    return "";
  }
  const line = match[1].split(/\r?\n/).find((entry) => /^description\s*:/.test(entry));
  if (!line) {
    return "";
  }
  const value = line.slice(line.indexOf(":") + 1).trim();
  return value.replace(/^["']|["']$/g, "").trim();
}

export function librarySkillPath(paths: LibraryPaths, name: string): string {
  return path.join(paths.skillsDir, name);
}

export async function listLibrarySkills(
  library: StoredLibrary,
  paths: LibraryPaths,
  options: {
    targets?: readonly LibraryAgentTarget[];
    homeDir?: string;
    sharedSkills?: boolean;
  } = {},
): Promise<SkillView[]> {
  const targets = options.targets ?? [];
  const views: SkillView[] = [];
  for (const skill of library.skills) {
    const dir = librarySkillPath(paths, skill.name);
    let description = "";
    try {
      description = frontmatterDescription(await readFile(path.join(dir, "SKILL.md"), "utf8"));
    } catch {
      // A skill folder without SKILL.md is still listed; its description is empty.
    }
    const localHash = await hashSkillTree(dir).catch(() => "");
    const shared =
      options.homeDir === undefined
        ? {}
        : await sharedState(dir, skill.name, options.homeDir, options.sharedSkills === true);
    views.push({
      name: skill.name,
      description,
      agents: [...skill.agents],
      path: dir,
      note: skill.note ?? "",
      ...(skill.source ? { source: { ...skill.source } } : {}),
      ...(skill.hash ? { hash: skill.hash } : {}),
      ...(skill.commit ? { commit: skill.commit } : {}),
      ...(skill.gone ? { gone: true } : {}),
      ...(skill.offHere ? { offHere: true } : {}),
      ...shared,
      ...(shared.shared !== undefined && options.homeDir !== undefined
        ? { always: sharedReaders(options.homeDir, targets) }
        : {}),
      modified: Boolean(skill.hash && localHash && localHash !== skill.hash),
    });
  }
  return views;
}

/** Adds the skill folder at `source` to the library, under its own name. */
export async function importSkill(
  library: StoredLibrary,
  paths: LibraryPaths,
  source: string,
): Promise<void> {
  const name = path.basename(source.replace(/[\\/]+$/, ""));
  if (!skillNamePattern.test(name)) {
    throw new Error(`Skill name ${JSON.stringify(name)}: use letters, digits, - and _ only`);
  }
  if (library.skills.some((skill) => skill.name === name)) {
    throw new Error(`The library already has a skill called ${name}`);
  }
  const info = await lstat(source);
  if (!info.isDirectory()) {
    throw new Error(`${source} is not a folder`);
  }
  const destination = librarySkillPath(paths, name);
  await mkdir(paths.skillsDir, { recursive: true });
  await copyTree(source, destination);
  library.skills.push({ name, agents: [] });
}

export async function removeSkill(
  library: StoredLibrary,
  paths: LibraryPaths,
  name: string,
  backup: LibraryBackup | null,
): Promise<void> {
  const index = library.skills.findIndex((skill) => skill.name === name);
  if (index < 0) {
    throw new Error(`There is no skill called ${name}`);
  }
  const dir = librarySkillPath(paths, name);
  if (backup) {
    // A failed copy throws, and the folder is not removed.
    await backup.keepTree("library", dir, name);
  }
  await rm(dir, { recursive: true, force: true });
  library.skills.splice(index, 1);
}

async function linkSkill(source: string, destination: string): Promise<void> {
  await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
}

async function linkTarget(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isSymbolicLink()) {
      return null;
    }
    return await readlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function removeManaged(destination: string, name: string, source: string): Promise<boolean> {
  const link = await linkTarget(destination).catch(() => null);
  if (link !== null) {
    if (path.resolve(link) === path.resolve(source)) {
      await rm(destination, { recursive: true, force: true });
      return true;
    }
    return false;
  }
  const exists = await lstat(destination)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return true;
  }
  if (await isOwnedCopy(destination, name)) {
    await rm(destination, { recursive: true, force: true });
    return true;
  }
  return false;
}

interface SingleSkillSync {
  present: boolean;
  changed: boolean;
  problem?: Error;
  /** The agent's own folder by that name is in the way (not a failure). */
  own?: boolean;
}

async function syncOneSkill(input: {
  skill: { name: string };
  target: { name: string };
  source: string;
  destination: string;
  how: "link" | "copy";
}): Promise<SingleSkillSync> {
  const { skill, target, source, destination, how } = input;
  const own = new Error(
    `${target.name} has a skill of its own by that name, which the library leaves as it is`,
  );
  const link = await linkTarget(destination).catch(() => null);
  try {
    if (link !== null) {
      if (path.resolve(link) !== path.resolve(source)) {
        return { present: false, changed: false, problem: own, own: true };
      }
      if (how === "link") {
        return { present: true, changed: false };
      }
      await copySkill(source, destination, skill.name);
      return { present: true, changed: true };
    }
    const exists = await lstat(destination)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      if (!(await isOwnedCopy(destination, skill.name))) {
        return { present: false, changed: false, problem: own, own: true };
      }
      if (how === "link") {
        await rm(destination, { recursive: true, force: true });
        await linkSkill(source, destination);
        return { present: true, changed: true };
      }
      const same =
        (await hashSkillTree(destination).catch(() => "")) ===
        (await hashSkillTree(source).catch(() => ""));
      if (!same) {
        await copySkill(source, destination, skill.name);
        return { present: true, changed: true };
      }
      return { present: true, changed: false };
    }
    if (how === "link") {
      await linkSkill(source, destination);
    } else {
      await copySkill(source, destination, skill.name);
    }
    return { present: true, changed: true };
  } catch (error) {
    return {
      present: false,
      changed: false,
      problem: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function copySkill(source: string, destination: string, name: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await copyTree(source, destination);
  await writeFile(path.join(destination, SKILL_MARKER), markerFor(name));
}

export async function syncSkills(
  library: StoredLibrary,
  paths: LibraryPaths,
  context: AgentSyncContext,
): Promise<void> {
  const { target, result } = context;
  const agent = target.id;
  if (!target.skillsDir) {
    return;
  }
  const desired = library.skills.filter(
    (skill) => skill.agents.includes(agent) && skill.offHere !== true,
  );
  const applied = (library.applied[agent] ??= {});
  const previous = applied.skills ?? [];
  if (previous.length === 0 && desired.length === 0) {
    return;
  }
  try {
    await mkdir(target.skillsDir, { recursive: true });
  } catch (error) {
    fail(result, agent, "skill", error);
    return;
  }
  const present: string[] = [];
  let changed = false;

  const how = library.skillHow?.[agent] ?? (library.copySkills ? "copy" : "link");

  for (const name of previous) {
    if (desired.some((skill) => skill.name === name)) {
      continue;
    }
    try {
      if (
        await removeManaged(path.join(target.skillsDir, name), name, librarySkillPath(paths, name))
      ) {
        changed = true;
      }
    } catch {
      // a folder already gone: nothing to remove
    }
  }

  for (const skill of desired) {
    const outcome = await syncOneSkill({
      skill,
      target,
      source: librarySkillPath(paths, skill.name),
      destination: path.join(target.skillsDir, skill.name),
      how,
    });
    if (outcome.problem) {
      fail(result, agent, `skill:${skill.name}`, outcome.problem, outcome.own === true);
      continue;
    }
    if (outcome.present) {
      present.push(skill.name);
    }
    changed ||= outcome.changed;
  }

  const nextApplied = present.sort();
  if (nextApplied.length > 0) {
    applied.skills = nextApplied;
  } else {
    delete applied.skills;
  }
  if (changed) {
    markChanged(result, agent);
  }
}

/** Skill folders that exist in the library but have no entry in library.json. */
export async function discoverSkillFolders(paths: LibraryPaths): Promise<string[]> {
  try {
    const entries = await readdir(paths.skillsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The optional `~/.agents/skills` folder: one link per library skill, so
 * agents that read that shared folder see them too. Turning it off removes
 * only links that point at the library.
 */
export async function syncSharedSkills(
  library: StoredLibrary,
  paths: LibraryPaths,
  homeDir: string,
  result: AgentSyncContext["result"],
): Promise<void> {
  const dir = sharedSkillsDir(homeDir);
  const wanted = new Set(
    library.sharedSkills
      ? library.skills.filter((skill) => skill.offHere !== true).map((skill) => skill.name)
      : [],
  );
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || wanted.has(entry)) {
      continue;
    }
    const target = path.join(dir, entry);
    const link = await linkTarget(target).catch(() => null);
    if (link === null) {
      continue;
    }
    if (path.resolve(link) === path.resolve(librarySkillPath(paths, entry))) {
      await rm(target, { recursive: true, force: true });
    }
  }
  if (!library.sharedSkills) {
    return;
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    fail(result, "shared", "skill", error);
    return;
  }
  for (const skill of library.skills) {
    const target = path.join(dir, skill.name);
    const link = await linkTarget(target).catch(() => null);
    if (link !== null) {
      continue;
    }
    const exists = await lstat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      continue;
    }
    try {
      await linkSkill(librarySkillPath(paths, skill.name), target);
    } catch (error) {
      fail(result, "shared", `skill:${skill.name}`, error);
    }
  }
}

/** Turns a skill off or on here alone; its agents stay as they are. */
export function setSkillHere(library: StoredLibrary, name: string, on: boolean): void {
  const skill = library.skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`There is no skill called ${name}`);
  }
  if (on) {
    delete skill.offHere;
  } else {
    skill.offHere = true;
  }
}

function agentReadsShared(target: LibraryAgentTarget, sharedDir: string): boolean {
  return (
    Boolean(target.skillsDir) && path.resolve(target.skillsDir ?? "") === path.resolve(sharedDir)
  );
}

/**
 * Moves skills kept in `~/.agents/skills` into the library, ticking every
 * agent that reads that folder (myna's skill hand-over). A skill already in
 * the library only has its shared entry taken away.
 */
export async function handOverSkills(
  library: StoredLibrary,
  paths: LibraryPaths,
  homeDir: string,
  names: string[] | null,
  targets: LibraryAgentTarget[],
): Promise<void> {
  const sharedDir = sharedSkillsDir(homeDir);
  const picked = (names ?? library.skills.map((skill) => skill.name)).slice().sort();
  if (picked.length === 0) {
    throw new Error("no skills to hand over");
  }
  for (const name of picked) {
    const source = path.join(sharedDir, name);
    const destination = librarySkillPath(paths, name);
    let skill = library.skills.find((entry) => entry.name === name);
    if (!skill) {
      const info = await lstat(source).catch(() => null);
      if (info === null) {
        throw new Error(`no skill called ${name} in ${sharedDir}`);
      }
      // debt: a shared entry that only links elsewhere is not followed; such
      // a skill has to be handed over from the folder it links to.
      if (info.isSymbolicLink()) {
        const link = await readlink(source).catch(() => "");
        throw new Error(`${name} in ${sharedDir} links to ${link}; import that folder instead`);
      }
      if (!info.isDirectory()) {
        throw new Error(`${source} is not a folder`);
      }
      await mkdir(paths.skillsDir, { recursive: true });
      await copyTree(source, destination);
      skill = { name, agents: [] };
      library.skills.push(skill);
    }
    const entry = await lstat(source).catch(() => null);
    if (entry !== null) {
      // A link pointing at the library's own folder is the one syncSharedSkills
      // made; taking it away is the hand-over.
      const link = entry.isSymbolicLink() ? await readlink(source).catch(() => null) : null;
      if (
        entry.isDirectory() ||
        (link !== null && path.resolve(link) === path.resolve(destination))
      ) {
        await rm(source, { recursive: true, force: true });
      } else if (entry.isSymbolicLink()) {
        throw new Error(
          `${name} in ${sharedDir} links to ${link ?? "elsewhere"}; the library doesn't copy it`,
        );
      }
    }
    for (const target of targets) {
      if (agentReadsShared(target, sharedDir) && !skill.agents.includes(target.id)) {
        skill.agents.push(target.id);
      }
    }
  }
}

/**
 * Puts a skill back into `~/.agents/skills`, leaving the library a link to
 * it (myna's HandBackSkill). Which agents it is ticked for stays as it is.
 */
export async function handBackSkill(
  library: StoredLibrary,
  paths: LibraryPaths,
  homeDir: string,
  name: string,
): Promise<void> {
  const skill = library.skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`There is no skill called ${name}`);
  }
  const libraryDir = librarySkillPath(paths, name);
  const info = await lstat(libraryDir).catch(() => null);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${name} isn't kept in the library's folder`);
  }
  const sharedDir = sharedSkillsDir(homeDir);
  const destination = path.join(sharedDir, name);
  const existing = await lstat(destination).catch(() => null);
  if (existing !== null) {
    const link = existing.isSymbolicLink() ? await readlink(destination).catch(() => null) : null;
    if (link === null || path.resolve(link) !== path.resolve(libraryDir)) {
      throw new Error(`${sharedDir} has a ${name} of its own`);
    }
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(sharedDir, { recursive: true });
  await copyTree(libraryDir, destination);
  await rm(libraryDir, { recursive: true, force: true });
  await linkSkill(destination, libraryDir);
  skill.source = { kind: "folder", dir: destination };
}

/**
 * Settles an agent's own skill that stands in the way of the library's.
 * `useLibrary` sets the agent's folder aside and ticks it for the library's;
 * otherwise the agent keeps its own and is taken off the library's.
 */
export async function settleAgentSkill(
  library: StoredLibrary,
  paths: LibraryPaths,
  target: LibraryAgentTarget,
  name: string,
  keepOwn: boolean,
): Promise<void> {
  const skill = library.skills.find((entry) => entry.name === name);
  if (!skill) {
    throw new Error(`There is no skill called ${name}`);
  }
  if (!target.skillsDir) {
    throw new Error(`${target.name} has no skills folder Neox knows of`);
  }
  if (keepOwn) {
    skill.agents = skill.agents.filter((agent) => agent !== target.id);
    return;
  }
  const own = path.join(target.skillsDir, name);
  const libraryDir = librarySkillPath(paths, name);
  const info = await lstat(own).catch(() => null);
  const link = info?.isSymbolicLink() ? await readlink(own).catch(() => null) : null;
  if (info !== null && (link === null || path.resolve(link) !== path.resolve(libraryDir))) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    const aside = path.join(paths.backupsDir, "set-aside", stamp, target.id, name);
    await mkdir(path.dirname(aside), { recursive: true, mode: 0o700 });
    await copyTree(own, aside);
    await rm(own, { recursive: true, force: true });
  }
  if (!skill.agents.includes(target.id)) {
    skill.agents.push(target.id);
    skill.agents.sort();
  }
}
