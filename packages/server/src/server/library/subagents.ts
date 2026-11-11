import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeManagedFile } from "./store.js";
import type { LibraryAgentTarget, LibrarySubagentKind } from "./paths.js";
import type { AppliedSubagentFile, StoredLibrary, StoredSubagent } from "./store.js";
import { fail, markChanged, type AgentSyncContext } from "./result.js";

const subagentNamePattern = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const reservedNames = new Set([
  "self",
  "system",
  "user",
  "model",
  "tool",
  "config",
  "default",
  "main",
]);
const MAX_DESCRIPTION = 1000;
const MAX_PROMPT = 100_000;

export function checkSubagent(subagent: StoredSubagent): StoredSubagent {
  const name = subagent.name.trim();
  if (!subagentNamePattern.test(name)) {
    throw new Error(
      `Subagent name ${JSON.stringify(name)}: use 2 to 50 lowercase letters, digits and -, not starting or ending with -`,
    );
  }
  if (reservedNames.has(name)) {
    throw new Error(`${name} is a name agents keep for themselves`);
  }
  const description = subagent.description.trim();
  if (description.length === 0) {
    throw new Error(
      "A subagent needs a description: it is how the main agent knows when to use it",
    );
  }
  if (description.length > MAX_DESCRIPTION) {
    throw new Error(`A subagent's description is at most ${MAX_DESCRIPTION} characters`);
  }
  const prompt = subagent.prompt.replace(/\r\n/g, "\n").replace(/[ \t\n]+$/, "");
  if (prompt.trim().length === 0) {
    throw new Error("A subagent needs a prompt");
  }
  if (prompt.length > MAX_PROMPT) {
    throw new Error(`A subagent's prompt is at most ${MAX_PROMPT} bytes`);
  }
  return {
    name,
    description,
    prompt,
    skills: [...new Set(subagent.skills ?? [])].sort(),
    mcp: [...new Set(subagent.mcp ?? [])].sort(),
    agents: [...new Set(subagent.agents)].sort(),
  };
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: readonly string[]): string {
  return `[${values.map(yamlString).join(", ")}]`;
}

function frontmatter(pairs: [string, string][], body: string): string {
  const header = pairs.map(([key, value]) => `${key}: ${value}`).join("\n");
  return `---\n${header}\n---\n\n${body.trimEnd()}\n`;
}

function renderSubagent(
  kind: LibrarySubagentKind,
  subagent: StoredSubagent,
  skills: string[],
  mcp: string[],
): string {
  if (kind === "codex") {
    return [
      `name = ${yamlString(subagent.name)}`,
      `description = ${yamlString(subagent.description)}`,
      `developer_instructions = ${yamlString(`${subagent.prompt.trimEnd()}\n`)}`,
      "",
    ].join("\n");
  }
  if (kind === "opencode") {
    // OpenCode names a subagent by its file, not by a frontmatter name.
    return frontmatter(
      [
        ["description", yamlString(subagent.description)],
        ["mode", "subagent"],
      ],
      subagent.prompt,
    );
  }
  const pairs: [string, string][] = [
    ["name", yamlString(subagent.name)],
    ["description", yamlString(subagent.description)],
  ];
  if (kind === "claude" && skills.length > 0) {
    pairs.push(["skills", yamlList(skills)]);
  }
  if ((kind === "claude" || kind === "droid") && mcp.length > 0) {
    pairs.push(["mcpServers", yamlList(mcp)]);
  }
  return frontmatter(pairs, subagent.prompt);
}

function extensionFor(kind: LibrarySubagentKind): string {
  switch (kind) {
    case "copilot":
      return ".agent.md";
    case "codex":
      return ".toml";
    case "opencode":
    case "claude":
    case "gemini":
    case "qwen":
    case "droid":
    case "grok":
    case "cursor":
      return ".md";
  }
}

function fileHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function subagentContent(
  library: StoredLibrary,
  target: LibraryAgentTarget,
  name: string,
): string | null {
  const subagent = library.subagents.find((entry) => entry.name === name);
  if (!subagent || !target.subagentKind) {
    return null;
  }
  const skills = (subagent.skills ?? []).filter((skill) =>
    library.skills.some((entry) => entry.name === skill),
  );
  const mcp = (subagent.mcp ?? []).filter((server) =>
    library.mcp.some((entry) => entry.name === server),
  );
  return renderSubagent(target.subagentKind, subagent, skills, mcp);
}

interface SubagentSyncState {
  kept: AppliedSubagentFile[];
  handled: Set<string>;
  changed: boolean;
}

async function refreshPreviousFiles(
  library: StoredLibrary,
  context: AgentSyncContext,
  wanted: Map<string, StoredSubagent>,
  previous: AppliedSubagentFile[],
  state: SubagentSyncState,
): Promise<void> {
  const { target, backup, result } = context;
  const agent = target.id;
  for (const entry of previous) {
    let current: string;
    try {
      current = await readFile(entry.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      fail(result, agent, `subagent:${entry.name}`, error);
      state.kept.push(entry);
      state.handled.add(entry.path);
      continue;
    }
    if (fileHash(current) !== entry.hash) {
      continue; // changed since: the user's from now on
    }
    const subagent = wanted.get(entry.path);
    if (!subagent) {
      try {
        await backup.keep(agent, entry.path);
        await rm(entry.path, { force: true });
        state.changed = true;
      } catch (error) {
        fail(result, agent, `subagent:${entry.name}`, error);
        state.kept.push(entry);
      }
      continue;
    }
    state.handled.add(entry.path);
    const contents = subagentContent(library, target, subagent.name);
    if (contents === null) {
      continue;
    }
    if (current !== contents) {
      try {
        await backup.keep(agent, entry.path);
        await writeManagedFile(entry.path, contents);
        state.changed = true;
      } catch (error) {
        fail(result, agent, `subagent:${subagent.name}`, error);
        state.kept.push(entry);
        continue;
      }
    }
    state.kept.push({ name: subagent.name, path: entry.path, hash: fileHash(contents) });
  }
}

async function writeNewFiles(
  library: StoredLibrary,
  context: AgentSyncContext,
  wanted: Map<string, StoredSubagent>,
  state: SubagentSyncState,
): Promise<void> {
  const { target, result } = context;
  const agent = target.id;
  for (const [file, subagent] of wanted) {
    if (state.handled.has(file)) {
      continue;
    }
    const contents = subagentContent(library, target, subagent.name);
    if (contents === null) {
      continue;
    }
    let current: string | null = null;
    try {
      current = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail(result, agent, `subagent:${subagent.name}`, error);
        continue;
      }
    }
    if (current !== null) {
      if (current === contents) {
        state.kept.push({ name: subagent.name, path: file, hash: fileHash(contents) });
      } else {
        fail(
          result,
          agent,
          `subagent:${subagent.name}`,
          new Error(
            `${target.name} has a subagent of its own at ${file}, which the library leaves as it is`,
          ),
        );
      }
      continue;
    }
    try {
      await context.backup.keep(agent, file);
      await mkdir(path.dirname(file), { recursive: true });
      await writeManagedFile(file, contents);
      state.changed = true;
      state.kept.push({ name: subagent.name, path: file, hash: fileHash(contents) });
    } catch (error) {
      fail(result, agent, `subagent:${subagent.name}`, error);
    }
  }
}

export async function syncSubagents(
  library: StoredLibrary,
  context: AgentSyncContext,
): Promise<void> {
  const { target, result } = context;
  const agent = target.id;
  if (!target.subagentsDir || !target.subagentKind) {
    return;
  }
  const desired = library.subagents.filter((subagent) => subagent.agents.includes(agent));
  const applied = (library.applied[agent] ??= {});
  const previous = applied.subagents ?? [];
  if (previous.length === 0 && desired.length === 0) {
    return;
  }
  const wanted = new Map<string, StoredSubagent>();
  for (const subagent of desired) {
    wanted.set(
      path.join(target.subagentsDir, `${subagent.name}${extensionFor(target.subagentKind)}`),
      subagent,
    );
  }
  const state: SubagentSyncState = { kept: [], handled: new Set(), changed: false };
  await refreshPreviousFiles(library, context, wanted, previous, state);
  await writeNewFiles(library, context, wanted, state);
  const kept = state.kept.sort((left, right) => left.path.localeCompare(right.path));
  if (kept.length > 0) {
    applied.subagents = kept;
  } else {
    delete applied.subagents;
  }
  if (state.changed) {
    markChanged(result, agent);
  }
}

export function subagentsView(library: StoredLibrary): StoredSubagent[] {
  return library.subagents.map((subagent) => ({
    ...subagent,
    skills: [...(subagent.skills ?? [])],
    mcp: [...(subagent.mcp ?? [])],
    agents: [...subagent.agents],
  }));
}

export function subagentAgents(targets: readonly LibraryAgentTarget[]): LibraryAgentTarget[] {
  return targets.filter((target) => target.subagentsDir !== undefined);
}
