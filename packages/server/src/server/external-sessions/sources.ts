import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionFile, SessionRoots } from "./types.js";

/** Agents this page reads, in the order their tabs appear when counts tie. */
export const EXTERNAL_SESSION_AGENTS = ["claude", "codex", "pi", "opencode", "agy"] as const;

export type ExternalSessionAgentId = (typeof EXTERNAL_SESSION_AGENTS)[number];

/**
 * Where each agent keeps its session files. The environment overrides are the
 * same ones each CLI honours, so a moved config folder is still found.
 */
export function resolveSessionRoots(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): SessionRoots {
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
  const codex = env.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
  const piAgent = env.PI_CODING_AGENT_DIR?.trim() || path.join(homeDir, ".pi", "agent");
  const pi = env.PI_CODING_AGENT_SESSION_DIR?.trim() || path.join(piAgent, "sessions");
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(homeDir, ".local", "share");
  const opencodeData = path.join(dataHome, "opencode");
  const opencode = resolveOpenCodeDb(opencodeData, env.OPENCODE_DB?.trim());
  const agy = env.AGY_DIR?.trim() || path.join(homeDir, ".gemini", "antigravity-cli");
  return { claude, codex, pi, opencode, agy };
}

function resolveOpenCodeDb(dataDir: string, configured: string | undefined): string {
  if (configured === undefined || configured.length === 0) {
    return path.join(dataDir, "opencode.db");
  }
  return path.isAbsolute(configured) ? configured : path.join(dataDir, configured);
}

const WALK_DEPTH = 8;
const MAX_FILES = 4000;

/** Every session file an agent keeps, newest modification first. */
export async function listSessionFiles(
  agent: ExternalSessionAgentId,
  roots: SessionRoots,
): Promise<SessionFile[]> {
  if (agent === "claude") {
    return listClaudeFiles(roots.claude);
  }
  if (agent === "codex") {
    const files = await walkJsonl(path.join(roots.codex, "sessions"), "codex", true);
    return files.sort(byMtimeDesc).slice(0, MAX_FILES);
  }
  if (agent === "opencode") {
    // Its sessions are rows of one database, read by the service.
    return [];
  }
  if (agent === "agy") {
    return listAgyFiles(roots.agy);
  }
  const files = await walkJsonl(roots.pi, "pi");
  return files.sort(byMtimeDesc).slice(0, MAX_FILES);
}

async function listClaudeFiles(configDir: string): Promise<SessionFile[]> {
  const projectsRoot = path.join(configDir, "projects");
  const projects = await readDirs(projectsRoot);
  const files: SessionFile[] = [];
  for (const project of projects) {
    const projectPath = path.join(projectsRoot, project);
    const entries = await readEntries(projectPath);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const file = await toSessionFile(path.join(projectPath, entry.name), "claude");
      if (file !== null) {
        files.push({ ...file, id: entry.name.slice(0, -".jsonl".length) });
      }
    }
  }
  return files.sort(byMtimeDesc).slice(0, MAX_FILES);
}

async function walkJsonl(
  root: string,
  agent: "codex" | "pi",
  packed = false,
): Promise<SessionFile[]> {
  const out: SessionFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WALK_DEPTH || out.length >= MAX_FILES) {
      return;
    }
    const entries = await readEntries(dir);
    for (const entry of entries) {
      if (out.length >= MAX_FILES) {
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSessionName(entry.name, packed)) {
        continue;
      }
      const file = await toSessionFile(full, agent);
      if (file !== null) {
        out.push(file);
      }
    }
  };
  await walk(root, 0);
  return out;
}

async function toSessionFile(
  filePath: string,
  agent: "claude" | "codex" | "pi" | "agy",
): Promise<SessionFile | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) {
      return null;
    }
    return {
      agent,
      id: idFromName(agent, path.basename(filePath)),
      path: filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

function isSessionName(name: string, packed: boolean): boolean {
  if (name.endsWith(".jsonl")) {
    return true;
  }
  return packed && name.endsWith(".jsonl.zst");
}

function idFromName(agent: "claude" | "codex" | "pi" | "agy", name: string): string {
  const plain = name.endsWith(".zst") ? name.slice(0, -".zst".length) : name;
  const base = plain.endsWith(".jsonl") ? plain.slice(0, -".jsonl".length) : plain;
  if (agent === "codex") {
    // rollout-2026-09-20T15-48-28-<uuid>
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(base);
    return match?.[1] ?? base;
  }
  if (agent === "pi") {
    // 2026-09-24T08-00-00-000Z_<uuid>
    const at = base.indexOf("_");
    return at >= 0 ? base.slice(at + 1) : base;
  }
  return base;
}

/** Antigravity's conversations: one transcript folder each, and row-only ones. */
async function listAgyFiles(dir: string): Promise<SessionFile[]> {
  const brain = path.join(dir, "brain");
  const entries = await readEntries(brain);
  const files: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const file = path.join(brain, entry.name, ".system_generated", "logs", "transcript_full.jsonl");
    const parsed = await toSessionFile(file, "agy");
    if (parsed !== null) {
      files.push({ ...parsed, id: entry.name });
    }
  }
  const known = new Set(files.map((file) => file.id));
  const conversations = await readEntries(path.join(dir, "conversations"));
  for (const entry of conversations) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) {
      continue;
    }
    const id = entry.name.slice(0, -".db".length);
    if (known.has(id)) {
      continue;
    }
    const parsed = await toSessionFile(path.join(dir, "conversations", entry.name), "agy");
    if (parsed !== null) {
      files.push({ ...parsed, id });
    }
  }
  return files.sort(byMtimeDesc).slice(0, MAX_FILES);
}

async function readDirs(dir: string): Promise<string[]> {
  const entries = await readEntries(dir);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function readEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function byMtimeDesc(a: SessionFile, b: SessionFile): number {
  return b.mtimeMs - a.mtimeMs;
}

/** The command that opens a session again, matching each CLI's own flag. */
export function resumeCommand(
  agent: string,
  id: string,
  options: { cwd?: string; wsl?: string } = {},
): string {
  if (!/^[0-9A-Za-z_-]+$/u.test(id)) {
    return "";
  }
  const run = runCommandOf(agent, id);
  if (run.length === 0) {
    return "";
  }
  if (options.wsl !== undefined && options.wsl.length > 0) {
    return wslResume(options.wsl, options.cwd ?? "", run);
  }
  // Antigravity starts a conversation from any folder, and its command is
  // copied rather than run by Neolix; the others are imported as agents.
  if (agent === "agy" && options.cwd !== undefined && options.cwd.length > 0) {
    return withCwd(run, options.cwd);
  }
  return run;
}

function runCommandOf(agent: string, id: string): string {
  switch (agent) {
    case "claude":
      return `claude --resume ${id}`;
    case "codex":
      return `codex resume ${id}`;
    case "pi":
      return `pi --session ${id}`;
    case "opencode":
      return `opencode --session ${id}`;
    case "agy":
      return `agy --conversation ${id}`;
    default:
      return "";
  }
}

function withCwd(run: string, cwd: string): string {
  if (process.platform === "win32") {
    return `Set-Location -LiteralPath '${cwd.replace(/'/gu, "''")}'; ${run}`;
  }
  return `cd '${cwd.replace(/'/gu, "'\\''")}' && ${run}`;
}

/** myna's line for a distro: wsl.exe -d <distro> --cd <cwd> -e sh -lc <run>. */
function wslResume(distro: string, cwd: string, run: string): string {
  const quote = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
  const cd = cwd.startsWith("/") ? ` --cd ${quote(cwd)}` : "";
  return `wsl.exe -d ${quote(distro)}${cd} -e sh -lc ${quote(`exec \${SHELL:-sh} -lic '${run}'`)}`;
}

/** Whether Neolix can move this agent's session data to its trash. */
export function canDelete(agent: string): boolean {
  return agent === "claude" || agent === "codex" || agent === "pi" || agent === "agy";
}

export function agentLabel(agent: string): string {
  switch (agent) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
    case "opencode":
      return "OpenCode";
    case "agy":
      return "Antigravity";
    default:
      return agent;
  }
}
