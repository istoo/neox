import { createHash } from "node:crypto";

/** The MCP server name Claude Code prefixes every tool of the bridge with. */
export const CLAUDE_MCP_SERVER = "neox";
export const CLAUDE_MCP_TOOL_PREFIX = `mcp__${CLAUDE_MCP_SERVER}__`;

export interface ClaudeToolSpec {
  name: string;
  description?: string;
  /** A JSON Schema; an empty one is replaced with an object schema. */
  inputSchema?: unknown;
}

export interface ClaudeMcpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

const NAME_OK = /^[A-Za-z0-9_-]{1,51}$/;
const NAME_BAD = /[^A-Za-z0-9_-]/g;
const NAME_HASHED = /_[0-9a-f]{12}$/;

/**
 * The name the MCP helper offers a caller's tool under. Claude Code takes an
 * MCP tool's name as [A-Za-z0-9_-] only, so a name it would change (or one
 * that already looks like a changed name) keeps its readable part and a hash
 * of the caller's name; the same name maps the same way in every run, so a
 * resumed session names the tool as before.
 */
export function bridgeToolName(name: string): string {
  const unprefixed = name.startsWith(CLAUDE_MCP_TOOL_PREFIX)
    ? name.slice(CLAUDE_MCP_TOOL_PREFIX.length)
    : "";
  if (unprefixed !== "" && NAME_OK.test(unprefixed) && !NAME_HASHED.test(unprefixed)) {
    return unprefixed;
  }
  if (NAME_OK.test(name) && !NAME_HASHED.test(name)) {
    return name;
  }
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 12);
  const readable = name.replace(NAME_BAD, "_").slice(0, 38);
  return `${readable}_${digest}`;
}

/** The name the run's agent has a caller's tool under, as a past call is told. */
export function bridgeName(name: string): string {
  return `${CLAUDE_MCP_TOOL_PREFIX}${bridgeToolName(name)}`;
}

/** The caller's name of each tool whose offered name differs. */
export function bridgeToolAliases(tools: readonly ClaudeToolSpec[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const tool of tools) {
    const offered = bridgeToolName(tool.name);
    if (offered !== tool.name) {
      names.set(offered, tool.name);
    }
  }
  return names;
}

/** The caller's name of the tool the run called, by the aliases it was offered under. */
export function declaredToolName(aliases: ReadonlyMap<string, string>, name: string): string {
  return aliases.get(name) ?? name;
}

/** The names of the caller's tools, whose past calls are told under bridgeName. */
export function offeredToolNames(tools: readonly ClaudeToolSpec[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

/** The tools the MCP helper lists, with the names Claude Code can take. */
export function bridgeTools(tools: readonly ClaudeToolSpec[], only?: string): ClaudeMcpTool[] {
  const out: ClaudeMcpTool[] = [];
  for (const tool of tools) {
    if (only !== undefined && only !== "" && tool.name !== only) {
      continue;
    }
    out.push({
      name: bridgeToolName(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** The `--mcp-config` JSON: one server, this bridge's stdio helper. */
export function mcpConfigJson(helperPath: string, helperArgs: readonly string[]): string {
  return JSON.stringify({
    mcpServers: {
      [CLAUDE_MCP_SERVER]: { command: helperPath, args: helperArgs },
    },
  });
}
