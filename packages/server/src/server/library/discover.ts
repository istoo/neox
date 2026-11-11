import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { LibraryAgentTarget } from "./paths.js";
import type { LibraryPaths, StoredLibrary } from "./store.js";
import { copyTree } from "./store.js";
import { readAgentMcpServers, type DiscoveredMcpServer } from "./mcp.js";
import { librarySkillPath } from "./skills.js";

/** One MCP server an agent already has, ready to bring into the library. */
export interface FoundMcpServer {
  name: string;
  transport: DiscoveredMcpServer["transport"];
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Agents that have exactly this server. */
  agents: string[];
  /** Agents that have a server by this name but configured differently. */
  otherAgents: string[];
  /** The agent's app writes this server itself on every start (myna's Own). */
  own?: boolean;
}

/** One skill folder an agent already has. */
export interface FoundSkill {
  name: string;
  description: string;
  /** The folder the library copies from. */
  path: string;
  agents: string[];
  /** Agents that have a folder by this name, with different content. */
  otherAgents: string[];
}

export interface DiscoverView {
  servers: FoundMcpServer[];
  skills: FoundSkill[];
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

async function readSkillDescription(dir: string): Promise<string> {
  try {
    return skillDescription(await readFile(path.join(dir, "SKILL.md"), "utf8"));
  } catch {
    return "";
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function skillFolders(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const folder = path.join(dir, entry.name);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    try {
      if ((await stat(path.join(folder, "SKILL.md"))).isFile()) {
        names.push(folder);
      }
    } catch {
      // no SKILL.md: not a skill folder
    }
  }
  return names;
}

async function isLibraryLink(paths: LibraryPaths, folder: string): Promise<boolean> {
  try {
    const resolved = await realpath(folder);
    return resolved === paths.skillsDir || isInside(paths.skillsDir, resolved);
  } catch {
    return false;
  }
}

/**
 * myna's appOwned (library/mcp.go:1641): a server run from inside the agent's
 * own app bundle (Codex.app, WindowsApps/OpenAI.Codex_…) is written by that
 * app on each start, so bringing it into the library would only fight it.
 * Codex's bundled runtimes count as its app's too.
 */
function appOwned(target: LibraryAgentTarget, entry: DiscoveredMcpServer): boolean {
  if (entry.transport !== "stdio" || entry.command === undefined) {
    return false;
  }
  const command = entry.command.replaceAll("\\", "/").toLowerCase();
  const id = target.id.toLowerCase();
  if (
    id === "codex" &&
    (command.includes("/cua_node/") || command.includes("/openai/codex/runtimes/"))
  ) {
    return true;
  }
  const name = target.name.toLowerCase();
  const names = [id, name];
  const dash = id.indexOf("-");
  if (dash > 0) names.push(id.slice(0, dash));
  const space = name.indexOf(" ");
  if (space > 0) names.push(name.slice(0, space));
  const segments = command.split("/");
  return segments.some((segment, index) => {
    const bundle = segment.endsWith(".app") && segments[index + 1] === "contents";
    const store = index > 0 && segments[index - 1] === "windowsapps" && index + 1 < segments.length;
    return (
      (bundle || store) &&
      names.some((candidate) => candidate !== "" && segment.includes(candidate))
    );
  });
}

async function discoverServers(
  library: StoredLibrary,
  targets: readonly LibraryAgentTarget[],
): Promise<FoundMcpServer[]> {
  const known = new Set(library.mcp.map((server) => server.name));
  const groups = new Map<
    string,
    { entry: DiscoveredMcpServer; agents: string[]; others: string[]; own?: boolean }
  >();
  for (const target of targets) {
    let servers;
    try {
      servers = await readAgentMcpServers(target);
    } catch {
      continue; // an unreadable config is not an import source
    }
    for (const [name, entry] of servers) {
      if (known.has(name) || name === "neox") {
        continue;
      }
      const group = groups.get(name);
      if (!group) {
        groups.set(name, { entry, agents: [target.id], others: [], own: appOwned(target, entry) });
      } else if (JSON.stringify(group.entry) === JSON.stringify(entry)) {
        group.agents.push(target.id);
      } else {
        group.others.push(target.id);
      }
    }
  }
  const found: FoundMcpServer[] = [];
  for (const { entry, agents, others, own } of groups.values()) {
    found.push({
      ...entry,
      agents: agents.sort(),
      otherAgents: others.sort(),
      ...(own === true ? { own: true } : {}),
    });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverSkills(
  library: StoredLibrary,
  paths: LibraryPaths,
  targets: readonly LibraryAgentTarget[],
): Promise<FoundSkill[]> {
  const known = new Set(library.skills.map((skill) => skill.name));
  const groups = new Map<
    string,
    { folder: string; real: string; description: string; agents: string[]; others: string[] }
  >();
  for (const target of targets) {
    if (!target.skillsDir) {
      continue;
    }
    for (const folder of await skillFolders(target.skillsDir)) {
      const name = path.basename(folder);
      if (known.has(name) || (await isLibraryLink(paths, folder))) {
        continue;
      }
      const real = await realpath(folder).catch(() => folder);
      const group = groups.get(name);
      if (!group) {
        groups.set(name, {
          folder,
          real,
          description: await readSkillDescription(folder),
          agents: [target.id],
          others: [],
        });
        continue;
      }
      if (group.real === real) {
        group.agents.push(target.id);
      } else {
        group.others.push(target.id);
      }
    }
  }
  return [...groups.entries()]
    .map(([name, group]) => ({
      name,
      description: group.description,
      path: group.folder,
      agents: group.agents.sort(),
      otherAgents: group.others.sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * What each agent already has that the library does not manage. Read-only:
 * nothing is written until the user picks entries to import.
 */
export async function discoverFromAgents(
  library: StoredLibrary,
  paths: LibraryPaths,
  targets: readonly LibraryAgentTarget[],
): Promise<DiscoverView> {
  return {
    servers: await discoverServers(library, targets),
    skills: await discoverSkills(library, paths, targets),
  };
}

export interface ImportSelection {
  servers: string[];
  skills: string[];
}

/** Copies the picked entries into the library; the caller then syncs. */
export async function importDiscovered(
  library: StoredLibrary,
  paths: LibraryPaths,
  targets: readonly LibraryAgentTarget[],
  view: DiscoverView,
  selection: ImportSelection,
): Promise<void> {
  for (const name of selection.servers) {
    const found = view.servers.find((server) => server.name === name);
    if (!found) {
      throw new Error(`There is no server called ${name} to import`);
    }
    if (library.mcp.some((server) => server.name === name)) {
      continue;
    }
    library.mcp.push({
      name,
      transport: found.transport,
      agents: [...found.agents],
      ...(found.command ? { command: found.command } : {}),
      ...(found.args ? { args: [...found.args] } : {}),
      ...(found.env ? { env: { ...found.env } } : {}),
      ...(found.url ? { url: found.url } : {}),
      ...(found.headers ? { headers: { ...found.headers } } : {}),
    });
  }
  library.mcp.sort((left, right) => left.name.localeCompare(right.name));

  for (const name of selection.skills) {
    const found = view.skills.find((skill) => skill.name === name);
    if (!found) {
      throw new Error(`There is no skill called ${name} to import`);
    }
    if (library.skills.some((skill) => skill.name === name)) {
      continue;
    }
    const destination = librarySkillPath(paths, name);
    const real = await realpath(found.path).catch(() => found.path);
    if (real !== destination) {
      await mkdir(paths.skillsDir, { recursive: true });
      await copyTree(found.path, destination);
    }
    // An agent holding this very folder already has the skill, so the
    // library leaves it alone until the user ticks that agent.
    const agents: string[] = [];
    for (const target of targets) {
      if (!target.skillsDir || !found.agents.includes(target.id)) {
        continue;
      }
      const own = path.join(target.skillsDir, name);
      const ownReal = await realpath(own).catch(() => own);
      if (ownReal !== real) {
        agents.push(target.id);
      }
    }
    library.skills.push({ name, agents });
  }
  library.skills.sort((left, right) => left.name.localeCompare(right.name));
}
