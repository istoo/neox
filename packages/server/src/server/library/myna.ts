import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LibraryPaths, LibraryTransport, StoredLibrary, StoredMcpServer } from "./store.js";
import { mkdir } from "node:fs/promises";
import { checkMcpServer } from "./mcp.js";
import { librarySkillPath } from "./skills.js";
import { copyTree } from "./store.js";
import type { FoundMcpServer, FoundSkill } from "./discover.js";

/**
 * myna keeps its library at `~/.config/myna/library.json`, with skill
 * folders beside it under `library/skills`. Neolix reads those files and
 * never writes them: importing copies what it needs.
 */
export interface MynaLibraryView {
  dir: string;
  available: boolean;
  servers: FoundMcpServer[];
  skills: FoundSkill[];
}

interface MynaRecord {
  name?: unknown;
  transport?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  agents?: unknown;
  source?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      out[key] = entry;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function defaultMynaDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homeDir, ".config"), "myna");
}

function mynaServer(record: MynaRecord, agents: readonly string[]): FoundMcpServer | null {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length === 0) {
    return null;
  }
  let transport: LibraryTransport = "stdio";
  if (record.transport === "sse") {
    transport = "sse";
  } else if (record.transport === "http") {
    transport = "http";
  }
  const wanted = new Set(strings(record.agents));
  const matched = agents.filter((agent) => wanted.has(agent));
  if (transport === "stdio") {
    if (typeof record.command !== "string" || record.command.length === 0) {
      return null;
    }
    return {
      name,
      transport,
      command: record.command,
      args: strings(record.args),
      env: stringRecord(record.env),
      agents: matched,
      otherAgents: [],
    };
  }
  if (typeof record.url !== "string" || record.url.length === 0) {
    return null;
  }
  return {
    name,
    transport,
    url: record.url,
    headers: stringRecord(record.headers),
    agents: matched,
    otherAgents: [],
  };
}

function skillDescription(raw: string): string {
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

async function readSkill(dir: string): Promise<string> {
  try {
    return skillDescription(await readFile(path.join(dir, "SKILL.md"), "utf8"));
  } catch {
    return "";
  }
}

export async function readMynaLibrary(options: {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  agents: readonly string[];
}): Promise<MynaLibraryView> {
  const dir = defaultMynaDir(options.homeDir, options.env);
  const dataFile = path.join(dir, "library.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(dataFile, "utf8"));
  } catch {
    return { dir, available: false, servers: [], skills: [] };
  }
  if (!isRecord(parsed)) {
    return { dir, available: false, servers: [], skills: [] };
  }
  const rawServers = Array.isArray(parsed.mcp) ? parsed.mcp : [];
  const servers: FoundMcpServer[] = [];
  for (const entry of rawServers) {
    if (!isRecord(entry)) {
      continue;
    }
    const server = mynaServer(entry, options.agents);
    if (server) {
      servers.push(server);
    }
  }
  const rawSkills = Array.isArray(parsed.skills) ? parsed.skills : [];
  const skills: FoundSkill[] = [];
  for (const entry of rawSkills) {
    if (!isRecord(entry) || typeof entry.name !== "string") {
      continue;
    }
    const name = entry.name.trim();
    if (name.length === 0 || name.includes("/") || name.includes("\\")) {
      continue;
    }
    const folder = path.join(dir, "library", "skills", name);
    const present = await stat(folder)
      .then((info) => info.isDirectory())
      .catch(() => false);
    if (!present) {
      continue;
    }
    const wanted = new Set(strings(entry.agents));
    skills.push({
      name,
      description: await readSkill(folder),
      path: folder,
      agents: options.agents.filter((agent) => wanted.has(agent)),
      otherAgents: [],
    });
  }
  return {
    dir,
    available: true,
    servers: servers.sort((left, right) => left.name.localeCompare(right.name)),
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Copies the ticked myna entries into the Neolix library. */
export async function importFromMynaLibrary(
  library: StoredLibrary,
  paths: LibraryPaths,
  view: MynaLibraryView,
  selection: { servers: string[]; skills: string[] },
): Promise<void> {
  for (const name of selection.servers) {
    const found = view.servers.find((server) => server.name === name);
    if (!found) {
      throw new Error(`myna has no server called ${name}`);
    }
    if (library.mcp.some((server) => server.name === name)) {
      continue;
    }
    const server: StoredMcpServer = {
      name,
      transport: found.transport,
      agents: [...found.agents],
      ...(found.command ? { command: found.command } : {}),
      ...(found.args ? { args: [...found.args] } : {}),
      ...(found.env ? { env: { ...found.env } } : {}),
      ...(found.url ? { url: found.url } : {}),
      ...(found.headers ? { headers: { ...found.headers } } : {}),
    };
    library.mcp.push(checkMcpServer(server));
  }
  library.mcp.sort((left, right) => left.name.localeCompare(right.name));

  for (const name of selection.skills) {
    const found = view.skills.find((skill) => skill.name === name);
    if (!found) {
      throw new Error(`myna has no skill called ${name}`);
    }
    if (library.skills.some((skill) => skill.name === name)) {
      continue;
    }
    await mkdir(paths.skillsDir, { recursive: true });
    await copyTree(found.path, librarySkillPath(paths, name));
    library.skills.push({ name, agents: [...found.agents] });
  }
  library.skills.sort((left, right) => left.name.localeCompare(right.name));
}
