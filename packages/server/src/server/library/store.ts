import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { writeFileAtomic, writeFileAtomicKeepingLastGood } from "../atomic-file.js";
import { lockClaudeConfig } from "../claude-lock.js";
import { isValidJson } from "../last-good.js";
import { readFileSteady } from "../steady.js";
import path from "node:path";

export const LIBRARY_VERSION = 1;

export type LibraryTransport = "stdio" | "http" | "sse";

export interface StoredMcpServer {
  name: string;
  transport: LibraryTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  agents: string[];
  /** Tools the agent leaves out, by the names the server gives them. */
  disabledTools?: string[];
  /** An OAuth app of the user's own; never given to an agent. */
  oauth?: { clientId: string; clientSecret?: string; callbackPort?: number };
  /** Codex's startup_timeout_sec, in seconds. */
  startupTimeout?: number;
  /** The user's own note; only the library keeps it. */
  note?: string;
  /** The market's icon for this server, when it has one. */
  icon?: string;
  /** Kept to this computer: a sync or a backup never carries it. */
  local?: boolean;
  /** With the hub on, give each agent the server's own entry instead. */
  router?: "shared" | "direct";
}

export interface StoredSkillSource {
  kind: "folder" | "git" | "github";
  /** owner/repo for github, the address for git. */
  repo?: string;
  ref?: string;
  path?: string;
  dir?: string;
}

export interface StoredSkill {
  name: string;
  agents: string[];
  source?: StoredSkillSource;
  /** Hash of the skill's files as last fetched, and the commit that had it. */
  hash?: string;
  commit?: string;
  /** The source no longer has it. */
  gone?: boolean;
  /** Turned off on this computer alone; every other computer keeps it. */
  offHere?: boolean;
  note?: string;
}

export interface StoredHook {
  name: string;
  description?: string;
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  agents: string[];
}

export interface StoredSubagent {
  name: string;
  description: string;
  prompt: string;
  skills?: string[];
  mcp?: string[];
  agents: string[];
}

export interface StoredInstructionSet {
  id: string;
  name: string;
}

export interface StoredInstructions {
  agents: string[];
  sets: StoredInstructionSet[];
  active: string;
}

export interface AppliedHookEntry {
  name: string;
  event: string;
  entry: unknown;
}

export interface AppliedSubagentFile {
  name: string;
  path: string;
  hash: string;
}

/**
 * What the library last wrote into one agent. It is how a write takes back
 * only its own entries: one the user changed since is the user's.
 */
export interface AppliedToAgent {
  instructions?: boolean;
  instrHash?: string;
  mcp?: string[];
  skills?: string[];
  hooks?: AppliedHookEntry[];
  subagents?: AppliedSubagentFile[];
  /** Tools the library turned off in each server's entry. */
  toolsOff?: Record<string, string[]>;
  /** Rules the library added beside the servers (Claude's deny rules). */
  toolRules?: string[];
  /** The startup timeout the library wrote in each server's entry. */
  startup?: Record<string, number>;
  rtk?: boolean;
}

export interface StoredLibrary {
  version: number;
  instructions: StoredInstructions;
  mcp: StoredMcpServer[];
  skills: StoredSkill[];
  hooks: StoredHook[];
  subagents: StoredSubagent[];
  applied: Record<string, AppliedToAgent>;
  /** Give agents copies of their skills rather than links. */
  copySkills?: boolean;
  /** Per agent's own way over copySkills: link or copy. */
  skillHow?: Record<string, "link" | "copy">;
  /** Link every skill into ~/.agents/skills too. */
  sharedSkills?: boolean;
  /** Skills a repository check already offered, by "owner/repo@ref". */
  seenSkills?: Record<string, string[]>;
  /** Give each agent Neolix's MCP hub in place of its servers. */
  mcpHub?: boolean;
  /**
   * Other computers' servers by the name of one kept local here (myna's
   * Away): given to no agent here, and carried on so a sync from here
   * doesn't take them from the computers that have them.
   */
  away?: StoredMcpServer[];
}

export function createEmptyLibrary(): StoredLibrary {
  return {
    version: LIBRARY_VERSION,
    instructions: { agents: [], sets: [], active: "" },
    mcp: [],
    skills: [],
    hooks: [],
    subagents: [],
    applied: {},
  };
}

export interface LibraryPaths {
  /** `$NEOLIX_HOME/library`: everything the library keeps is here. */
  dir: string;
  dataFile: string;
  backupsDir: string;
  skillsDir: string;
  instructionsDir: string;
  instructionSetsDir: string;
}

export function resolveLibraryPaths(neolixHome: string): LibraryPaths {
  const dir = path.join(neolixHome, "library");
  return {
    dir,
    dataFile: path.join(dir, "library.json"),
    backupsDir: path.join(dir, "backups"),
    skillsDir: path.join(dir, "skills"),
    instructionsDir: path.join(dir, "instructions"),
    instructionSetsDir: path.join(dir, "instruction-sets"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringPairs(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pairs = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return Object.keys(pairs).length > 0 ? pairs : undefined;
}

function normalizeOauth(value: unknown): StoredMcpServer["oauth"] {
  if (!isRecord(value) || typeof value.clientId !== "string") {
    return undefined;
  }
  return {
    clientId: value.clientId,
    ...(typeof value.clientSecret === "string" ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.callbackPort === "number" ? { callbackPort: value.callbackPort } : {}),
  };
}

function normalizeServer(value: unknown): StoredMcpServer | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  const transport = value.transport;
  if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
    return null;
  }
  const env = stringPairs(value.env);
  const headers = stringPairs(value.headers);
  const oauth = normalizeOauth(value.oauth);
  return {
    name: value.name,
    transport,
    ...(typeof value.command === "string" ? { command: value.command } : {}),
    ...(Array.isArray(value.args) ? { args: stringArray(value.args) } : {}),
    ...(env ? { env } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(headers ? { headers } : {}),
    agents: stringArray(value.agents),
    ...(Array.isArray(value.disabledTools)
      ? { disabledTools: stringArray(value.disabledTools) }
      : {}),
    ...(oauth ? { oauth } : {}),
    ...(typeof value.startupTimeout === "number" ? { startupTimeout: value.startupTimeout } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.icon === "string" && value.icon.length > 0 ? { icon: value.icon } : {}),
    ...(value.local === true ? { local: true } : {}),
    ...(value.router === "direct" ? { router: "direct" as const } : {}),
  };
}

function normalizeSkillSource(value: unknown): StoredSkillSource | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }
  if (value.kind !== "folder" && value.kind !== "git" && value.kind !== "github") {
    return undefined;
  }
  return {
    kind: value.kind,
    ...(typeof value.repo === "string" ? { repo: value.repo } : {}),
    ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(typeof value.dir === "string" ? { dir: value.dir } : {}),
  };
}

function normalizeSkill(value: unknown): StoredSkill | null {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    return null;
  }
  const source = normalizeSkillSource(value.source);
  return {
    name: value.name,
    agents: stringArray(value.agents),
    ...(source ? { source } : {}),
    ...(typeof value.hash === "string" ? { hash: value.hash } : {}),
    ...(typeof value.commit === "string" ? { commit: value.commit } : {}),
    ...(value.gone === true ? { gone: true } : {}),
    ...(value.offHere === true ? { offHere: true } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
  };
}

function normalizeHook(value: unknown): StoredHook | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.event !== "string" ||
    typeof value.command !== "string"
  ) {
    return null;
  }
  return {
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    event: value.event,
    ...(typeof value.matcher === "string" ? { matcher: value.matcher } : {}),
    command: value.command,
    ...(typeof value.timeout === "number" ? { timeout: value.timeout } : {}),
    agents: stringArray(value.agents),
  };
}

function normalizeSubagent(value: unknown): StoredSubagent | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.prompt !== "string"
  ) {
    return null;
  }
  return {
    name: value.name,
    description: value.description,
    prompt: value.prompt,
    skills: stringArray(value.skills),
    mcp: stringArray(value.mcp),
    agents: stringArray(value.agents),
  };
}

function normalizeApplied(value: unknown): Record<string, AppliedToAgent> {
  if (!isRecord(value)) {
    return {};
  }
  const applied: Record<string, AppliedToAgent> = {};
  for (const [agent, record] of Object.entries(value)) {
    if (!isRecord(record)) {
      continue;
    }
    applied[agent] = {
      ...(record.instructions === true ? { instructions: true } : {}),
      ...(typeof record.instrHash === "string" ? { instrHash: record.instrHash } : {}),
      ...(Array.isArray(record.mcp) ? { mcp: stringArray(record.mcp) } : {}),
      ...(Array.isArray(record.skills) ? { skills: stringArray(record.skills) } : {}),
      ...(Array.isArray(record.hooks)
        ? {
            hooks: record.hooks.filter(
              (entry): entry is AppliedHookEntry =>
                isRecord(entry) &&
                typeof entry.name === "string" &&
                typeof entry.event === "string",
            ),
          }
        : {}),
      ...(Array.isArray(record.subagents)
        ? {
            subagents: record.subagents.filter(
              (entry): entry is AppliedSubagentFile =>
                isRecord(entry) &&
                typeof entry.name === "string" &&
                typeof entry.path === "string" &&
                typeof entry.hash === "string",
            ),
          }
        : {}),
      ...(isRecord(record.toolsOff)
        ? {
            toolsOff: Object.fromEntries(
              Object.entries(record.toolsOff).map(([key, list]) => [key, stringArray(list)]),
            ),
          }
        : {}),
      ...(Array.isArray(record.toolRules) ? { toolRules: stringArray(record.toolRules) } : {}),
      ...(isRecord(record.startup)
        ? {
            startup: Object.fromEntries(
              Object.entries(record.startup).filter(
                (entry): entry is [string, number] => typeof entry[1] === "number",
              ),
            ),
          }
        : {}),
      ...(record.rtk === true ? { rtk: true } : {}),
    };
  }
  return applied;
}

export function normalizeLibrary(value: unknown): StoredLibrary {
  const empty = createEmptyLibrary();
  if (!isRecord(value)) {
    return empty;
  }
  const instructions = isRecord(value.instructions) ? value.instructions : {};
  const sets = Array.isArray(instructions.sets)
    ? instructions.sets
        .filter(
          (entry): entry is StoredInstructionSet =>
            isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string",
        )
        .map((entry) => ({ id: entry.id, name: entry.name }))
    : [];
  return {
    version: LIBRARY_VERSION,
    instructions: {
      agents: stringArray(instructions.agents),
      sets,
      active: typeof instructions.active === "string" ? instructions.active : "",
    },
    mcp: (Array.isArray(value.mcp) ? value.mcp : [])
      .map(normalizeServer)
      .filter((entry): entry is StoredMcpServer => entry !== null),
    skills: (Array.isArray(value.skills) ? value.skills : [])
      .map(normalizeSkill)
      .filter((entry): entry is StoredSkill => entry !== null),
    hooks: (Array.isArray(value.hooks) ? value.hooks : [])
      .map(normalizeHook)
      .filter((entry): entry is StoredHook => entry !== null),
    subagents: (Array.isArray(value.subagents) ? value.subagents : [])
      .map(normalizeSubagent)
      .filter((entry): entry is StoredSubagent => entry !== null),
    applied: normalizeApplied(value.applied),
    ...(value.copySkills === true ? { copySkills: true } : {}),
    ...(isRecord(value.skillHow)
      ? {
          skillHow: Object.fromEntries(
            Object.entries(value.skillHow).filter(
              (entry): entry is [string, "link" | "copy"] =>
                entry[1] === "link" || entry[1] === "copy",
            ),
          ),
        }
      : {}),
    ...(value.sharedSkills === true ? { sharedSkills: true } : {}),
    ...(value.mcpHub === true ? { mcpHub: true } : {}),
    ...(Array.isArray(value.away)
      ? {
          away: value.away
            .map(normalizeServer)
            .filter((entry): entry is StoredMcpServer => entry !== null),
        }
      : {}),
    ...(isRecord(value.seenSkills)
      ? {
          seenSkills: Object.fromEntries(
            Object.entries(value.seenSkills).map(([key, list]) => [key, stringArray(list)]),
          ),
        }
      : {}),
  };
}

export async function readLibrary(file: string): Promise<StoredLibrary | null> {
  try {
    const raw = (await readFileSteady(file)).toString("utf8");
    if (raw.trim().length === 0) {
      return createEmptyLibrary();
    }
    return normalizeLibrary(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Writes a file the agent owns, keeping the permissions it had: a temp file
 * renamed over it lands 0644, and ~/.claude.json is usually 0600.
 */
export async function writeManagedFile(file: string, contents: string): Promise<void> {
  // ~/.claude.json is Claude Code's file too: its mkdir lock is taken as
  // Claude Code takes it, so a save of ours never lands mid-write
  // (myna provider/claude_lock.go, claudelock.Config).
  const lock = path.basename(file) === ".claude.json" ? await lockClaudeConfig(file) : null;
  try {
    let mode: number | undefined;
    try {
      mode = (await stat(file)).mode & 0o777;
    } catch {
      // a new file: the umask decides
    }
    await writeFileAtomic(file, contents);
    if (mode !== undefined) {
      await chmod(file, mode).catch(() => undefined);
    }
  } finally {
    await lock?.release();
  }
}

export async function writeLibrary(file: string, library: StoredLibrary): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // The Library is Neolix's own state: keep its last good generation.
  await writeFileAtomicKeepingLastGood(file, `${JSON.stringify(library, null, 2)}\n`, isValidJson);
  await chmod(file, 0o600).catch(() => undefined);
}

export interface LibraryBackup {
  dir: string | null;
  /** Copy `file` aside once per session, before the change writes it. */
  keep(agent: string, file: string): Promise<void>;
  /** Copy a skill folder aside, for a folder no library entry owns. */
  keepTree(agent: string, source: string, name: string): Promise<void>;
  done(): string | null;
}

const KEEP_BACKUPS = 30;

export function createBackupSession(backupsDir: string, now = new Date()): LibraryBackup {
  const seen = new Set<string>();
  let dir: string | null = null;

  const ensureDir = async (): Promise<string> => {
    if (dir) {
      return dir;
    }
    await mkdir(backupsDir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
    let candidate = path.join(backupsDir, stamp);
    for (let index = 2; ; index += 1) {
      try {
        await mkdir(candidate, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        candidate = path.join(backupsDir, `${stamp}-${index}`);
      }
    }
    dir = candidate;
    return candidate;
  };

  return {
    get dir() {
      return dir;
    },
    async keep(agent, file) {
      if (seen.has(file)) {
        return;
      }
      seen.add(file);
      let contents: Buffer;
      try {
        const info = await stat(file);
        if (!info.isFile()) {
          return;
        }
        contents = await readFile(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return;
        }
        throw error;
      }
      const targetDir = path.join(await ensureDir(), agent);
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      const target = path.join(targetDir, path.basename(file));
      await writeFile(target, contents, { mode: 0o600 });
    },
    async keepTree(agent, source, name) {
      const info = await stat(source).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (!info?.isDirectory()) {
        return;
      }
      const target = path.join(await ensureDir(), agent, "skills", name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyTree(source, target);
    },
    done() {
      return dir;
    },
  };
}

async function holdsSkillFolder(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry === "skills") {
      return true;
    }
    try {
      await stat(path.join(dir, entry, "skills"));
      return true;
    } catch {
      // not a folder with a skills copy
    }
  }
  return false;
}

/**
 * The newest 30 backup folders stay; older ones go. A folder holding a skill
 * copy is never removed: for a skill taken out of the library it is the only
 * copy left.
 */
export async function pruneBackups(backupsDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(backupsDir);
  } catch {
    return;
  }
  const folders = entries.filter((entry) => !entry.startsWith(".")).sort();
  const prunable: string[] = [];
  for (const folder of folders) {
    if (!(await holdsSkillFolder(path.join(backupsDir, folder)))) {
      prunable.push(folder);
    }
  }
  const excess = prunable.slice(0, Math.max(0, prunable.length - KEEP_BACKUPS));
  await Promise.all(
    excess.map((entry) => rm(path.join(backupsDir, entry), { recursive: true, force: true })),
  );
}

export async function copyTree(source: string, destination: string): Promise<void> {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(
      entries.map((entry) =>
        copyTree(path.join(source, entry.name), path.join(destination, entry.name)),
      ),
    );
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
}
