import { readFileSteady } from "../steady.js";
import { writeManagedFile } from "./store.js";
import type { LibraryAgentTarget, LibraryMcpFormat } from "./paths.js";
import type { AppliedToAgent, LibraryTransport, StoredLibrary, StoredMcpServer } from "./store.js";
import { fail, markChanged, type AgentSyncContext, type LibrarySyncResult } from "./result.js";
import { wslMcpServer } from "./wsl.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function checkMcpServer(server: StoredMcpServer): StoredMcpServer {
  const name = server.name.trim();
  if (!namePattern.test(name)) {
    throw new Error(`Server name ${JSON.stringify(name)}: use letters, digits, - and _ only`);
  }
  const extras = serverExtras(server, name);
  if (server.transport === "stdio") {
    if (!server.command?.trim()) {
      throw new Error(`${name}: a command is needed`);
    }
    return {
      name,
      transport: "stdio",
      command: server.command.trim(),
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      agents: [...new Set(server.agents)].sort(),
      ...extras,
    };
  }
  if (server.transport !== "http" && server.transport !== "sse") {
    throw new Error(`${name}: unknown transport`);
  }
  if (!server.url || !/^https?:\/\//.test(server.url.trim())) {
    throw new Error(`${name}: the URL has to start with http:// or https://`);
  }
  return {
    name,
    transport: server.transport,
    url: server.url.trim(),
    ...(server.headers && Object.keys(server.headers).length > 0
      ? { headers: server.headers }
      : {}),
    agents: [...new Set(server.agents)].sort(),
    ...extras,
  };
}

function serverMetadata(server: StoredMcpServer): Partial<StoredMcpServer> {
  return {
    ...(server.disabledTools && server.disabledTools.length > 0
      ? { disabledTools: [...new Set(server.disabledTools)].sort() }
      : {}),
    ...(server.note?.trim() ? { note: server.note.trim() } : {}),
    ...(server.icon?.trim() ? { icon: server.icon.trim() } : {}),
    ...(server.local === true ? { local: true } : {}),
    ...(server.router === "direct" ? { router: "direct" as const } : {}),
  };
}

function serverExtras(server: StoredMcpServer, name: string): Partial<StoredMcpServer> {
  const extras: Partial<StoredMcpServer> = serverMetadata(server);
  if (server.startupTimeout !== undefined) {
    if (
      !Number.isInteger(server.startupTimeout) ||
      server.startupTimeout < 0 ||
      server.startupTimeout > 86400
    ) {
      throw new Error(`${name}: the startup timeout is 0 to 86400 seconds`);
    }
    if (server.startupTimeout > 0) {
      extras.startupTimeout = server.startupTimeout;
    }
  }
  if (server.oauth) {
    const clientId = server.oauth.clientId.trim();
    if (clientId.length === 0) {
      throw new Error(`${name}: the OAuth app needs its client ID`);
    }
    if (
      server.oauth.callbackPort !== undefined &&
      (!Number.isInteger(server.oauth.callbackPort) ||
        server.oauth.callbackPort < 0 ||
        server.oauth.callbackPort > 65535)
    ) {
      throw new Error(`${name}: the callback port has to be from 1 to 65535`);
    }
    extras.oauth = {
      clientId,
      ...(server.oauth.clientSecret?.trim()
        ? { clientSecret: server.oauth.clientSecret.trim() }
        : {}),
      ...(server.oauth.callbackPort ? { callbackPort: server.oauth.callbackPort } : {}),
    };
  }
  return extras;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads JSONC: a config file may carry comments the agent accepts. */
export function parseJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const withoutComments = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(withoutComments);
  }
}

interface JsonFile {
  root: Record<string, unknown>;
  raw: string;
}

async function readJsonFile(file: string): Promise<JsonFile> {
  let raw = "";
  try {
    // Another process (Claude Code) may be renaming the file; wait it out.
    raw = (await readFileSteady(file)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (raw.trim().length === 0) {
    return { root: {}, raw };
  }
  const parsed = parseJsonc(raw);
  return { root: isRecord(parsed) ? parsed : {}, raw };
}

function containerPath(format: LibraryMcpFormat): string[] {
  switch (format) {
    case "opencode":
    case "crush":
      return ["mcp"];
    case "zcode":
      return ["mcp", "servers"];
    default:
      return ["mcpServers"];
  }
}

function nestedRecord(
  root: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function withNestedRecord(
  root: Record<string, unknown>,
  keys: readonly string[],
  value: Record<string, unknown> | null,
): Record<string, unknown> {
  if (keys.length === 0) {
    return value ?? {};
  }
  const [head, ...rest] = keys;
  const next = { ...root };
  if (rest.length === 0) {
    if (value && Object.keys(value).length > 0) {
      next[head] = value;
    } else {
      delete next[head];
    }
    return next;
  }
  const child = isRecord(next[head]) ? next[head] : {};
  const childNext = withNestedRecord(child, rest, value);
  if (Object.keys(childNext).length > 0) {
    next[head] = childNext;
  } else {
    delete next[head];
  }
  return next;
}

function jsonState(file: JsonFile, format: LibraryMcpFormat) {
  const servers = nestedRecord(file.root, containerPath(format)) ?? {};
  return { root: { ...file.root }, servers: { ...servers } };
}

function encodeClaude(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        type: "stdio",
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
      }
    : {
        type: server.transport,
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
}

function encodeCopilot(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        type: "local",
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
        tools: ["*"],
      }
    : {
        type: server.transport,
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        tools: ["*"],
      };
}

function encodeOpenCode(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        type: "local",
        command: [server.command ?? "", ...(server.args ?? [])],
        ...(server.env ? { environment: server.env } : {}),
        enabled: true,
      }
    : {
        type: "remote",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        enabled: true,
      };
}

function encodeOmp(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      }
    : {
        type: server.transport,
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
}

function encodeGemini(server: StoredMcpServer): unknown {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return server.transport === "http"
    ? { httpUrl: server.url, ...(server.headers ? { headers: server.headers } : {}) }
    : { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

function encodeAntigravity(server: StoredMcpServer): unknown {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    };
  }
  return {
    ...(server.transport === "sse" ? { type: "sse" } : {}),
    serverUrl: server.url,
    ...(server.headers ? { headers: server.headers } : {}),
  };
}

function encodeCursor(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      }
    : { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
}

function encodeKimi(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      }
    : {
        url: server.url,
        transport: server.transport,
        ...(server.headers ? { headers: server.headers } : {}),
      };
}

function encodeDevin(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
        transport: "stdio",
      }
    : {
        url: server.url,
        transport: server.transport,
        ...(server.headers ? { headers: server.headers } : {}),
      };
}

// Pi's mcp.json: a URL is streamable HTTP unless it says sse.
function encodePi(server: StoredMcpServer): unknown {
  return server.transport === "stdio"
    ? {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      }
    : {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
}

function encodeJsonBase(server: StoredMcpServer, format: LibraryMcpFormat): unknown {
  switch (format) {
    case "claude":
      return encodeClaude(server);
    case "copilot":
      return encodeCopilot(server);
    case "opencode":
      return encodeOpenCode(server);
    case "omp":
      return encodeOmp(server);
    case "pi":
      return encodePi(server);
    case "gemini":
      return encodeGemini(server);
    case "antigravity":
      return encodeAntigravity(server);
    case "cursor":
      return encodeCursor(server);
    case "kimi":
      return encodeKimi(server);
    case "devin":
      return encodeDevin(server);
    case "crush":
    case "zcode":
      return encodeClaude(server);
    case "codex":
      throw new Error("Codex reads TOML, not JSON");
    case "grok":
      throw new Error("Grok reads TOML, not JSON");
    case "goose":
    case "hermes":
      throw new Error("This agent reads YAML, not JSON");
  }
}

// ---- TOML (Codex's config.toml) -------------------------------------------

function tomlQuote(value: string): string {
  return JSON.stringify(value);
}

function tomlInlineTable(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${key} = ${tomlQuote(value)}`);
  return `{ ${entries.join(", ")} }`;
}

function withDisabledTools(
  server: StoredMcpServer,
  format: LibraryMcpFormat,
  encoded: unknown,
): unknown {
  const tools = server.disabledTools;
  if (!tools || tools.length === 0 || !isRecord(encoded)) {
    return encoded;
  }
  if (format === "claude") {
    return encoded; // a deny rule goes beside the server, not inside it
  }
  if (format === "opencode") {
    const off: Record<string, boolean> = {};
    for (const tool of tools) {
      off[tool] = false;
    }
    return { ...encoded, tools: off };
  }
  return { ...encoded, disabledTools: [...tools] };
}

function encodeJsonEntry(server: StoredMcpServer, format: LibraryMcpFormat): unknown {
  return withDisabledTools(server, format, encodeJsonBase(server, format));
}

function encodeTomlEntry(server: StoredMcpServer, format: LibraryMcpFormat): string {
  const lines = [`[mcp_servers.${server.name}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlQuote(server.command ?? "")}`);
    lines.push(`args = [${(server.args ?? []).map(tomlQuote).join(", ")}]`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`env = ${tomlInlineTable(server.env)}`);
    }
  } else {
    lines.push(`url = ${tomlQuote(server.url ?? "")}`);
    if (server.headers && Object.keys(server.headers).length > 0) {
      const key = format === "codex" ? "http_headers" : "headers";
      lines.push(`${key} = ${tomlInlineTable(server.headers)}`);
    }
  }
  if (format === "codex" && server.startupTimeout) {
    lines.push(`startup_timeout_sec = ${server.startupTimeout}`);
  }
  if (server.disabledTools && server.disabledTools.length > 0) {
    lines.push(`disabled_tools = [${server.disabledTools.map(tomlQuote).join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

function tomlServerRoot(line: string): string | null {
  const match = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(line);
  return match ? match[1].trim() : null;
}

function tomlKeyName(key: string): string {
  return key.replace(/^"|"$/g, "");
}

function tomlServerBlock(text: string, name: string): string {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    const root = tomlServerRoot(line);
    if (root) {
      const parts = root.split(".").map((part) => part.trim());
      inside =
        parts[0] === "mcp_servers" && parts[1] !== undefined && tomlKeyName(parts[1]) === name;
    }
    if (inside) {
      lines.push(line.trim());
    }
  }
  return lines.join("\n").trim();
}

function tomlServerNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const root = tomlServerRoot(line);
    if (!root) {
      continue;
    }
    const parts = root.split(".").map((part) => part.trim());
    if (parts[0] === "mcp_servers" && parts[1]) {
      names.add(tomlKeyName(parts[1]));
    }
  }
  return names;
}

/** Replaces or removes one `[mcp_servers.<name>]` table, comments elsewhere kept. */
function setTomlServer(text: string, name: string, block: string | null): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const root = tomlServerRoot(line);
    if (root) {
      const parts = root.split(".").map((part) => part.trim());
      skipping =
        parts[0] === "mcp_servers" && parts[1] !== undefined && tomlKeyName(parts[1]) === name;
    }
    if (!skipping) {
      kept.push(line);
    }
  }
  if (block) {
    while (kept.length > 0 && kept[kept.length - 1].trim().length === 0) {
      kept.pop();
    }
    if (kept.length > 0) {
      kept.push("");
    }
    kept.push(...block.trimEnd().split("\n"));
  }
  const result = kept.join("\n").replace(/\n+$/, "");
  return result.length > 0 ? `${result}\n` : "";
}

// ---- sync ------------------------------------------------------------------

interface McpState {
  kind: "json" | "toml" | "yaml";
  raw: string;
  root?: Record<string, unknown>;
  servers?: Record<string, unknown>;
}

async function readRawFile(file: string): Promise<string> {
  try {
    return (await readFileSteady(file)).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readMcpState(file: string, format: LibraryMcpFormat): Promise<McpState> {
  if (format === "codex" || format === "grok") {
    return { kind: "toml", raw: await readRawFile(file) };
  }
  if (format === "goose" || format === "hermes") {
    return { kind: "yaml", raw: await readRawFile(file) };
  }
  const json = await readJsonFile(file);
  const state = jsonState(json, format);
  return { kind: "json", raw: json.raw, root: state.root, servers: state.servers };
}

function serializeMcpState(format: LibraryMcpFormat, state: McpState): string {
  if (state.kind !== "json") {
    return state.raw;
  }
  const root = withNestedRecord(state.root ?? {}, containerPath(format), state.servers ?? {});
  return `${JSON.stringify(root, null, 2)}\n`;
}

function sameEntry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The user's own fields in an entry the library manages stay as they are. */
function mergeJsonEntry(current: unknown, encoded: unknown): unknown {
  if (!isRecord(current) || !isRecord(encoded)) {
    return encoded;
  }
  return { ...current, ...encoded };
}

/** The same for a Codex TOML table: keys the library does not write stay. */
function mergeTomlContent(currentBlock: string, desired: string): string {
  if (currentBlock.length === 0) {
    return desired;
  }
  const writtenKeys = new Set(
    desired
      .split("\n")
      .slice(1)
      .map((line) => line.split("=")[0]?.trim())
      .filter((key): key is string => Boolean(key)),
  );
  const extras = currentBlock
    .split("\n")
    .slice(1)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("[")) {
        return false;
      }
      const key = trimmed.split("=")[0]?.trim();
      return Boolean(key) && !writtenKeys.has(key);
    });
  return extras.length > 0 ? `${desired.trimEnd()}\n${extras.join("\n")}\n` : desired;
}

function removeUnwanted(
  state: McpState,
  format: LibraryMcpFormat,
  desired: StoredMcpServer[],
  previouslyApplied: string[],
  existingNames: Set<string>,
): boolean {
  let changed = false;
  for (const name of previouslyApplied) {
    if (desired.some((server) => server.name === name) || !existingNames.has(name)) {
      continue;
    }
    if (state.kind === "toml") {
      state.raw = setTomlServer(state.raw, name, null);
    } else if (state.kind === "yaml") {
      state.raw = setYamlServer(state.raw, yamlRootFor(format), name, null);
    } else if (state.servers) {
      delete state.servers[name];
    }
    changed = true;
  }
  return changed;
}

interface AppliedServers {
  changed: boolean;
  written: string[];
}

function applyJsonServers(
  target: LibraryAgentTarget,
  state: McpState & { servers: Record<string, unknown> },
  desired: StoredMcpServer[],
  previouslyApplied: string[],
  result: LibrarySyncResult,
): AppliedServers {
  let changed = false;
  const written: string[] = [];
  for (const server of desired) {
    const encoded = encodeJsonEntry(server, target.mcpFormat ?? "claude");
    const current = state.servers[server.name];
    const ours = previouslyApplied.includes(server.name);
    const merged = ours ? mergeJsonEntry(current, encoded) : encoded;
    if (current !== undefined && !ours && !sameEntry(current, encoded)) {
      fail(
        result,
        target.id,
        `mcp:${server.name}`,
        new Error(
          `${target.name} has a server of its own by that name, which the library leaves as it is`,
        ),
      );
      continue;
    }
    if (current === undefined || !sameEntry(current, merged)) {
      state.servers[server.name] = merged;
      changed = true;
    }
    written.push(server.name);
  }
  return { changed, written };
}

function applyTomlServers(
  target: LibraryAgentTarget,
  state: McpState,
  desired: StoredMcpServer[],
  previouslyApplied: string[],
  result: LibrarySyncResult,
): AppliedServers {
  let changed = false;
  const written: string[] = [];
  for (const server of desired) {
    const content = encodeTomlEntry(server, target.mcpFormat ?? "codex");
    if (server.transport === "sse" && target.mcpFormat === "codex") {
      fail(result, target.id, `mcp:${server.name}`, new Error("Codex has no SSE servers"));
      continue;
    }
    const current = state.raw.includes(`[mcp_servers.${server.name}]`);
    const ours = previouslyApplied.includes(server.name);
    if (current && !ours) {
      fail(
        result,
        target.id,
        `mcp:${server.name}`,
        new Error(
          `${target.name} has a server of its own by that name, which the library leaves as it is`,
        ),
      );
      continue;
    }
    const currentBlock = tomlServerBlock(state.raw, server.name);
    const merged = ours ? mergeTomlContent(currentBlock, content) : content;
    if (currentBlock !== merged.trim()) {
      state.raw = setTomlServer(state.raw, server.name, merged);
      changed = true;
    }
    written.push(server.name);
  }
  return { changed, written };
}

// ---- YAML (Goose's and Hermes' config.yaml) -------------------------------

function yamlRootFor(format: LibraryMcpFormat): string {
  return format === "goose" ? "extensions" : "mcp_servers";
}

function yamlInline(values: Record<string, string>): string {
  const entries = Object.entries(values).map(([key, value]) => `${key}: ${tomlQuote(value)}`);
  return `{ ${entries.join(", ")} }`;
}

function encodeGooseYaml(server: StoredMcpServer): string {
  const lines = [`  ${server.name}:`, "    enabled: true", `    name: ${tomlQuote(server.name)}`];
  if (server.transport === "stdio") {
    lines.push("    type: stdio", `    cmd: ${tomlQuote(server.command ?? "")}`);
    lines.push(`    args: [${(server.args ?? []).map(tomlQuote).join(", ")}]`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`    envs: ${yamlInline(server.env)}`);
    }
  } else {
    lines.push(
      server.transport === "http" ? "    type: streamable_http" : "    type: sse",
      `    uri: ${tomlQuote(server.url ?? "")}`,
    );
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`    headers: ${yamlInline(server.headers)}`);
    }
  }
  if (server.disabledTools && server.disabledTools.length > 0) {
    lines.push(`    disabledTools: [${server.disabledTools.map(tomlQuote).join(", ")}]`);
  }
  lines.push("    timeout: 300");
  return `${lines.join("\n")}\n`;
}

function encodeHermesYaml(server: StoredMcpServer): string {
  const lines = [`  ${server.name}:`];
  if (server.transport === "stdio") {
    lines.push(`    command: ${tomlQuote(server.command ?? "")}`);
    lines.push(`    args: [${(server.args ?? []).map(tomlQuote).join(", ")}]`);
    if (server.env && Object.keys(server.env).length > 0) {
      lines.push(`    env: ${yamlInline(server.env)}`);
    }
  } else {
    lines.push(`    url: ${tomlQuote(server.url ?? "")}`);
    if (server.headers && Object.keys(server.headers).length > 0) {
      lines.push(`    headers: ${yamlInline(server.headers)}`);
    }
    if (server.transport === "sse") {
      lines.push("    transport: sse");
    }
  }
  if (server.disabledTools && server.disabledTools.length > 0) {
    lines.push(`    disabledTools: [${server.disabledTools.map(tomlQuote).join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

function encodeYamlEntry(format: LibraryMcpFormat, server: StoredMcpServer): string {
  return format === "goose" ? encodeGooseYaml(server) : encodeHermesYaml(server);
}

function yamlEntryName(line: string): string | null {
  const match = /^ {2}"?([^":\s][^":]*)"?:\s*$/.exec(line);
  return match ? match[1].trim() : null;
}

function yamlRootStart(lines: readonly string[], root: string): number {
  return lines.findIndex((line) => new RegExp(`^${root}:\\s*(#.*)?$`).test(line));
}

function yamlRootEnd(lines: readonly string[], root: string): number {
  const start = yamlRootStart(lines, root);
  if (start < 0) {
    return -1;
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) {
      continue;
    }
    if (!line.startsWith(" ")) {
      return index;
    }
  }
  return lines.length;
}

function yamlServerNames(raw: string, root: string): Set<string> {
  const names = new Set<string>();
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = yamlRootStart(lines, root);
  const end = yamlRootEnd(lines, root);
  if (start < 0) {
    return names;
  }
  for (let index = start + 1; index < end; index += 1) {
    const name = yamlEntryName(lines[index]);
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function yamlServerBlock(raw: string, root: string, name: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = yamlRootStart(lines, root);
  const end = yamlRootEnd(lines, root);
  if (start < 0) {
    return "";
  }
  const out: string[] = [];
  let inside = false;
  for (let index = start + 1; index < end; index += 1) {
    const line = lines[index];
    const entry = yamlEntryName(line);
    if (entry) {
      inside = entry === name;
    }
    if (inside) {
      out.push(line.trimEnd());
    }
  }
  return out.join("\n").trimEnd();
}

function setYamlServer(raw: string, root: string, name: string, block: string | null): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const start = yamlRootStart(lines, root);
  if (start < 0) {
    if (!block) {
      return raw;
    }
    const base = raw.replace(/\n+$/, "");
    return `${base.length > 0 ? `${base}\n` : ""}${root}:\n${block}`;
  }
  const end = yamlRootEnd(lines, root);
  const kept: string[] = [];
  let skipping = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (index > start && index < end) {
      const entry = yamlEntryName(lines[index]);
      if (entry) {
        skipping = entry === name;
      }
      if (skipping) {
        continue;
      }
    }
    kept.push(lines[index]);
  }
  if (block) {
    const newStart = yamlRootStart(kept, root);
    let insertAt = yamlRootEnd(kept, root);
    if (insertAt < 0 || newStart < 0) {
      return raw;
    }
    while (insertAt > newStart + 1 && kept[insertAt - 1]?.trim().length === 0) {
      insertAt -= 1;
    }
    kept.splice(insertAt, 0, ...block.trimEnd().split("\n"));
  }
  return kept.join("\n").replace(/\n+$/, "\n");
}

function mergeYamlContent(currentBlock: string, desired: string): string {
  if (currentBlock.length === 0) {
    return desired;
  }
  const writtenKeys = new Set(
    desired
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(":")[0])
      .filter((key): key is string => Boolean(key)),
  );
  const extras = currentBlock
    .split("\n")
    .slice(1)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        return false;
      }
      const key = trimmed.split(":")[0];
      return Boolean(key) && !writtenKeys.has(key);
    });
  // YAML keeps the user's indentation: a key nested under the entry stays nested.
  return extras.length > 0 ? `${desired.trimEnd()}\n${extras.join("\n")}\n` : desired;
}

function applyYamlServers(
  target: LibraryAgentTarget,
  state: McpState,
  desired: StoredMcpServer[],
  previouslyApplied: string[],
  result: LibrarySyncResult,
): AppliedServers {
  const format = target.mcpFormat ?? "hermes";
  const root = yamlRootFor(format);
  let changed = false;
  const written: string[] = [];
  for (const server of desired) {
    const content = encodeYamlEntry(format, server);
    const currentBlock = yamlServerBlock(state.raw, root, server.name);
    const ours = previouslyApplied.includes(server.name);
    if (currentBlock.length > 0 && !ours) {
      fail(
        result,
        target.id,
        `mcp:${server.name}`,
        new Error(
          `${target.name} has a server of its own by that name, which the library leaves as it is`,
        ),
      );
      continue;
    }
    const merged = ours ? mergeYamlContent(currentBlock, content) : content;
    if (currentBlock !== merged.trimEnd()) {
      state.raw = setYamlServer(state.raw, root, server.name, merged);
      changed = true;
    }
    written.push(server.name);
  }
  return { changed, written };
}

/** Claude turns a tool off with a deny rule, so the rules live beside the entry. */
function applyClaudeToolRules(
  state: McpState & { servers: Record<string, unknown> },
  desired: readonly StoredMcpServer[],
  applied: AppliedToAgent,
): boolean {
  const wanted = new Set<string>();
  for (const server of desired) {
    for (const tool of server.disabledTools ?? []) {
      wanted.add(`mcp__${server.name}__${tool}`);
    }
  }
  const root = state.root;
  if (!root) {
    return false;
  }
  const permissions = isRecord(root.permissions) ? { ...root.permissions } : {};
  const previous = new Set(applied.toolRules ?? []);
  const deny = Array.isArray(permissions.deny)
    ? permissions.deny.filter((rule): rule is string => typeof rule === "string")
    : [];
  const next = deny.filter((rule) => !previous.has(rule) || wanted.has(rule));
  for (const rule of wanted) {
    if (!next.includes(rule)) {
      next.push(rule);
    }
  }
  const changed = JSON.stringify(next) !== JSON.stringify(deny);
  if (next.length > 0) {
    permissions.deny = next;
  } else {
    delete permissions.deny;
  }
  if (Object.keys(permissions).length > 0) {
    root.permissions = permissions;
  } else {
    delete root.permissions;
  }
  if (wanted.size > 0) {
    applied.toolRules = [...wanted].sort();
  } else {
    delete applied.toolRules;
  }
  return changed;
}

function applyToolRules(
  target: LibraryAgentTarget,
  state: McpState,
  desired: readonly StoredMcpServer[],
  applied: AppliedToAgent,
): boolean {
  if (state.kind !== "json" || target.mcpFormat !== "claude") {
    return false;
  }
  return applyClaudeToolRules({ ...state, servers: state.servers ?? {} }, desired, applied);
}

/**
 * Takes one server out of an agent's own config without the library having
 * applied it (myna's RemoveFoundServer). Callers back the file up first; the
 * rest of the file is kept as it is.
 */
export async function removeAgentMcpServer(
  target: LibraryAgentTarget,
  name: string,
): Promise<boolean> {
  if (!target.mcpPath || !target.mcpFormat) {
    return false;
  }
  const state = await readMcpState(target.mcpPath, target.mcpFormat);
  let exists: boolean;
  if (state.kind === "toml") {
    exists = tomlServerNames(state.raw).has(name);
    if (exists) {
      state.raw = setTomlServer(state.raw, name, null);
    }
  } else if (state.kind === "yaml") {
    const root = yamlRootFor(target.mcpFormat);
    exists = yamlServerNames(state.raw, root).has(name);
    if (exists) {
      state.raw = setYamlServer(state.raw, root, name, null);
    }
  } else {
    exists = state.servers !== undefined && name in state.servers;
    if (exists && state.servers) {
      delete state.servers[name];
    }
  }
  if (!exists) {
    return false;
  }
  await writeManagedFile(target.mcpPath, serializeMcpState(target.mcpFormat, state));
  return true;
}

export async function syncMcp(library: StoredLibrary, context: AgentSyncContext): Promise<void> {
  const { target, backup, result, hubServer } = context;
  const agent = target.id;
  if (!target.mcpPath || !target.mcpFormat) {
    return;
  }
  const wanted = hubServer
    ? [
        hubServer,
        // A server the user kept direct goes on as its own entry, so it can
        // read the folder the agent starts in (myna's Server.Hub).
        ...library.mcp.filter(
          (server) => server.agents.includes(agent) && server.router === "direct",
        ),
      ]
    : library.mcp.filter((server) => server.agents.includes(agent));
  const desired = wanted.map((server) =>
    target.distro === undefined ? server : wslMcpServer(server),
  );
  const applied = (library.applied[agent] ??= {});
  const previouslyApplied = applied.mcp ?? [];
  if (previouslyApplied.length === 0 && desired.length === 0) {
    return;
  }
  let state: McpState;
  try {
    state = await readMcpState(target.mcpPath, target.mcpFormat);
  } catch (error) {
    fail(result, agent, "mcp", error);
    return;
  }
  let existingNames: Set<string>;
  if (state.kind === "toml") {
    existingNames = tomlServerNames(state.raw);
  } else if (state.kind === "yaml") {
    existingNames = yamlServerNames(state.raw, yamlRootFor(target.mcpFormat));
  } else {
    existingNames = new Set(Object.keys(state.servers ?? {}));
  }
  const removed = removeUnwanted(
    state,
    target.mcpFormat,
    desired,
    previouslyApplied,
    existingNames,
  );
  let appliedNow: AppliedServers;
  if (state.kind === "toml") {
    appliedNow = applyTomlServers(target, state, desired, previouslyApplied, result);
  } else if (state.kind === "yaml") {
    appliedNow = applyYamlServers(target, state, desired, previouslyApplied, result);
  } else {
    appliedNow = applyJsonServers(
      target,
      { ...state, servers: state.servers ?? {} },
      desired,
      previouslyApplied,
      result,
    );
  }
  if (applyToolRules(target, state, desired, applied)) {
    appliedNow.changed = true;
  }
  if (appliedNow.written.length > 0) {
    applied.mcp = [...appliedNow.written].sort();
  } else {
    delete applied.mcp;
  }
  if (!removed && !appliedNow.changed) {
    return;
  }
  const serialized = serializeMcpState(target.mcpFormat, state);
  try {
    await backup.keep(agent, target.mcpPath);
    await writeManagedFile(target.mcpPath, serialized);
  } catch (error) {
    fail(result, agent, "mcp", error);
    return;
  }
  markChanged(result, agent);
}

export function mcpServerFromChange(
  value: Omit<StoredMcpServer, "name"> & { name: string },
): StoredMcpServer {
  return checkMcpServer(value);
}

// ---- reading what an agent already has, for discovery and import -----------

export interface DiscoveredMcpServer {
  name: string;
  transport: LibraryTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.filter((entry): entry is string => typeof entry === "string");
  return out.length > 0 ? out : undefined;
}

function remoteOrStdio(
  name: string,
  raw: Record<string, unknown>,
  urlKey: string,
  transport?: LibraryTransport,
): DiscoveredMcpServer | null {
  const url = raw[urlKey];
  if (typeof url === "string" && url.length > 0) {
    return {
      name,
      transport: transport ?? "http",
      url,
      headers: stringRecord(raw.headers),
    };
  }
  const command = raw.command;
  if (typeof command === "string" && command.length > 0) {
    return {
      name,
      transport: "stdio",
      command,
      args: stringList(raw.args),
      env: stringRecord(raw.env) ?? stringRecord(raw.envs),
    };
  }
  return null;
}

function remoteEntry(
  raw: Record<string, unknown>,
  name: string,
  transport: LibraryTransport,
): DiscoveredMcpServer {
  return {
    name,
    transport,
    url: String(raw.url ?? raw.serverUrl ?? ""),
    headers: stringRecord(raw.headers),
  };
}

function decodeCopilotEntry(
  name: string,
  raw: Record<string, unknown>,
): DiscoveredMcpServer | null {
  if (raw.type === "http" || raw.type === "sse") {
    return remoteEntry(raw, name, raw.type);
  }
  return remoteOrStdio(name, raw, "");
}

function decodeOpenCodeEntry(
  name: string,
  raw: Record<string, unknown>,
): DiscoveredMcpServer | null {
  if (raw.type === "remote") {
    return remoteEntry(raw, name, "http");
  }
  const command = stringList(raw.command);
  if (!command || command.length === 0) {
    return null;
  }
  return {
    name,
    transport: "stdio",
    command: command[0],
    ...(command.length > 1 ? { args: command.slice(1) } : {}),
    env: stringRecord(raw.environment),
  };
}

function decodeGeminiEntry(name: string, raw: Record<string, unknown>): DiscoveredMcpServer | null {
  if (typeof raw.httpUrl === "string") {
    return { name, transport: "http", url: raw.httpUrl, headers: stringRecord(raw.headers) };
  }
  if (typeof raw.url === "string") {
    return { name, transport: "sse", url: raw.url, headers: stringRecord(raw.headers) };
  }
  return remoteOrStdio(name, raw, "");
}

function decodeAntigravityEntry(
  name: string,
  raw: Record<string, unknown>,
): DiscoveredMcpServer | null {
  if (typeof raw.serverUrl === "string") {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url: raw.serverUrl,
      headers: stringRecord(raw.headers),
    };
  }
  return remoteOrStdio(name, raw, "");
}

function decodeTransportEntry(
  name: string,
  raw: Record<string, unknown>,
): DiscoveredMcpServer | null {
  if (typeof raw.url === "string") {
    return remoteEntry(raw, name, raw.transport === "sse" ? "sse" : "http");
  }
  return remoteOrStdio(name, raw, "");
}

function decodeTypedEntry(name: string, raw: Record<string, unknown>): DiscoveredMcpServer | null {
  const url = raw.url ?? raw.serverUrl;
  if (typeof url === "string") {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url,
      headers: stringRecord(raw.headers),
    };
  }
  return remoteOrStdio(name, raw, "");
}

function decodeGooseEntry(name: string, raw: Record<string, unknown>): DiscoveredMcpServer | null {
  if (typeof raw.uri === "string") {
    return {
      name,
      transport: raw.type === "sse" ? "sse" : "http",
      url: raw.uri,
      headers: stringRecord(raw.headers),
    };
  }
  if (typeof raw.cmd === "string") {
    return {
      name,
      transport: "stdio",
      command: raw.cmd,
      args: stringList(raw.args),
      env: stringRecord(raw.envs) ?? stringRecord(raw.env),
    };
  }
  return null;
}

function decodeJsonEntry(
  format: LibraryMcpFormat,
  name: string,
  raw: unknown,
): DiscoveredMcpServer | null {
  if (!isRecord(raw)) {
    return null;
  }
  switch (format) {
    case "copilot":
      return decodeCopilotEntry(name, raw);
    case "opencode":
      return decodeOpenCodeEntry(name, raw);
    case "gemini":
      return decodeGeminiEntry(name, raw);
    case "antigravity":
      return decodeAntigravityEntry(name, raw);
    case "kimi":
    case "devin":
      return decodeTransportEntry(name, raw);
    case "goose":
      return decodeGooseEntry(name, raw);
    case "hermes": {
      const decoded = remoteOrStdio(name, raw, "url");
      if (decoded && raw.transport === "sse") {
        decoded.transport = "sse";
      }
      return decoded;
    }
    case "omp":
    case "cursor":
    case "pi":
    case "claude":
    case "crush":
    case "zcode":
      return decodeTypedEntry(name, raw);
    case "codex":
    case "grok":
      return null;
  }
}

function tomlParseString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function tomlParseList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) {
    return undefined;
  }
  const out: string[] = [];
  for (const part of inner.split(",")) {
    const parsed = tomlParseString(part);
    if (parsed !== undefined) {
      out.push(parsed);
    }
  }
  return out.length > 0 ? out : undefined;
}

function tomlParseInlineTable(value: string): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const part of trimmed.slice(1, -1).split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) {
      continue;
    }
    const key = part.slice(0, at).trim().replace(/^"|"$/g, "");
    const parsed = tomlParseString(part.slice(at + 1));
    if (key.length > 0 && parsed !== undefined) {
      out[key] = parsed;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function decodeTomlServer(name: string, block: string): DiscoveredMcpServer | null {
  const values: Record<string, string> = {};
  for (const line of block.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const at = trimmed.indexOf("=");
    if (at <= 0) {
      continue;
    }
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  const url = values.url ? tomlParseString(values.url) : undefined;
  if (url) {
    return {
      name,
      transport: "http",
      url,
      headers: tomlParseInlineTable(values.http_headers ?? values.headers ?? ""),
    };
  }
  const command = values.command ? tomlParseString(values.command) : undefined;
  if (!command) {
    return null;
  }
  return {
    name,
    transport: "stdio",
    command,
    args: values.args ? tomlParseList(values.args) : undefined,
    env: values.env ? tomlParseInlineTable(values.env) : undefined,
  };
}

export async function readAgentMcpServers(
  target: LibraryAgentTarget,
): Promise<Map<string, DiscoveredMcpServer>> {
  const found = new Map<string, DiscoveredMcpServer>();
  if (!target.mcpPath || !target.mcpFormat) {
    return found;
  }
  const format = target.mcpFormat;
  const state = await readMcpState(target.mcpPath, format);
  if (state.kind === "toml") {
    for (const name of tomlServerNames(state.raw)) {
      const decoded = decodeTomlServer(name, tomlServerBlock(state.raw, name));
      if (decoded) {
        found.set(name, decoded);
      }
    }
    return found;
  }
  if (state.kind === "yaml") {
    const { parse } = await import("yaml");
    const doc = parse(state.raw);
    const root = isRecord(doc) ? doc[yamlRootFor(format)] : undefined;
    if (isRecord(root)) {
      for (const [name, raw] of Object.entries(root)) {
        const decoded = decodeJsonEntry(format, name, raw);
        if (decoded) {
          found.set(name, decoded);
        }
      }
    }
    return found;
  }
  for (const [name, raw] of Object.entries(state.servers ?? {})) {
    const decoded = decodeJsonEntry(format, name, raw);
    if (decoded) {
      found.set(name, decoded);
    }
  }
  return found;
}
