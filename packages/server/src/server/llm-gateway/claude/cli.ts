import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

/** The settings file a headless run is given, so it never registers an OS URL handler. */
export const CLAUDE_DEEP_LINK_SETTINGS = '{"disableDeepLinkRegistration":"disable"}';

/**
 * The prompt cache Claude Code writes lasts an hour on a subscription within
 * its limits. A run kept for its conversation's next turn waits that long;
 * a run let go sooner makes the next one write the whole conversation again.
 */
export const CLAUDE_CACHE_TTL_MS = 60 * 60_000;

/** Variables a run is never given: they would point Claude Code at another gateway or account. */
const BLOCKED_ENV = new Set([
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROMPT_CACHE_TTL",
  "CLAUDE_CODE_EXTRA_BODY",
  "ANTHROPIC_BETAS",
]);

/** Variables every run is given, as myna gives them. */
const FIXED_ENV: Record<string, string> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  // The caller tells its model the repository state itself; a status that
  // changes with each commit would undo the cached prefix.
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
  // Every run marks its prompt for an hour, which may not follow a 5m mark.
  CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
};

/**
 * One run's process as it is started: where, with what, and the session
 * folders its conversation is kept in (a WSL distro's are its own).
 */
export interface ClaudeLaunch {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  sessionDirs: readonly string[];
  /** Set when Claude Code runs in a WSL distro. */
  wsl?: { distro: string; home: string; projects?: string };
}

export interface ClaudeCliArgsInput {
  model: string;
  /** Inline JSON for `--mcp-config`: one server, this bridge's helper. */
  mcpConfig: string;
  effort?: string;
  /** Claude Code runs Anthropic's own WebSearch; no caller tool is offered for it. */
  webSearch?: boolean;
  /** The caller turned thinking off (auto mode classifiers, small asks). */
  thinkingOff?: boolean;
  /** A request that wants its answer in a JSON schema. */
  jsonSchema?: string;
  /** A file of the run's own, for instructions too long for a command line. */
  systemPromptFile?: string;
  /** A saved session this run goes on with. */
  resumeSession?: string;
  /** Keep Claude Code's transcript on disk, so a later run can resume it. */
  persistSession?: boolean;
}

/**
 * The arguments of one `claude -p` run: stream-json in and out, the prompt as
 * the genuine Claude Code preset, every tool of its own off but WebSearch, and
 * no settings or MCP servers of the user's.
 */
export function claudeCliArgs(input: ClaudeCliArgsInput): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    input.model,
    "--tools",
    input.webSearch === true ? "WebSearch" : "",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfig,
    "--setting-sources",
    "",
    "--settings",
    CLAUDE_DEEP_LINK_SETTINGS,
    "--dangerously-skip-permissions",
  ];
  if (input.persistSession !== true) {
    args.push("--no-session-persistence");
  }
  if (input.effort !== undefined && input.effort !== "") {
    args.push("--effort", input.effort, "--thinking-display", "summarized");
  }
  if (input.thinkingOff === true) {
    args.push("--thinking", "disabled");
  }
  if (input.jsonSchema !== undefined && input.jsonSchema !== "") {
    args.push("--json-schema", input.jsonSchema);
  }
  if (input.systemPromptFile !== undefined) {
    args.push("--system-prompt-file", input.systemPromptFile);
  }
  if (input.resumeSession !== undefined && input.resumeSession !== "") {
    args.push("--resume", input.resumeSession);
  }
  return args;
}

/** The arguments of a one-off warm-up ask: one JSON answer, no tools, nothing kept. */
export function claudeWarmArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--settings",
    CLAUDE_DEEP_LINK_SETTINGS,
    "--no-session-persistence",
  ];
}

/**
 * The environment a run inherits: the daemon's, without anything that would
 * point Claude Code at another gateway or account, and with the fixed
 * variables myna sets for every run.
 */
export function cleanClaudeEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !BLOCKED_ENV.has(key)) {
      out[key] = value;
    }
  }
  return { ...out, ...FIXED_ENV };
}

export interface ClaudeRunEnvInput {
  env: Readonly<Record<string, string | undefined>>;
  /** A saved account's config directory; "" for the account Claude Code is signed in to. */
  configDir?: string;
  /** A setup-token account's token, handed to Claude Code in its environment only. */
  oauthToken?: string;
  isRoot?: boolean;
}

/**
 * Environment for one run. A saved account gets its own `CLAUDE_CONFIG_DIR`,
 * where Claude Code keeps (and refreshes) that account's sign-in itself; the
 * default account keeps the environment's own.
 */
export function claudeRunEnv(input: ClaudeRunEnvInput): Record<string, string> {
  let env = cleanClaudeEnv(input.env);
  if (input.configDir !== undefined && input.configDir !== "") {
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.CLAUDE_CONFIG_DIR = input.configDir;
    if (input.oauthToken !== undefined && input.oauthToken !== "") {
      env.CLAUDE_CODE_OAUTH_TOKEN = input.oauthToken;
    }
  }
  env = asSandboxEnv(env, input.isRoot === true);
  return env;
}

/**
 * Claude Code refuses `--dangerously-skip-permissions` as root unless it is
 * told it runs in a sandbox. The run has no tool of Claude Code's own that
 * touches the machine, so saying so is what myna does.
 */
export function asSandboxEnv(env: Record<string, string>, isRoot: boolean): Record<string, string> {
  if (!isRoot) {
    return env;
  }
  if ((env.CLAUDE_CODE_BUBBLEWRAP ?? "") !== "" || env.IS_SANDBOX === "1") {
    return env;
  }
  return { ...env, IS_SANDBOX: "1" };
}

export interface FindClaudeBinaryInput {
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** The PATH separator; ":" elsewhere. */
  pathDelimiter?: string;
}

/**
 * The `claude` on PATH, or "" when there is none. Neolix's Claude Code agent
 * provider resolves the same binary for its own runs; the bridge does not
 * share that process model and only needs the executable.
 */
export async function findClaudeBinary(input: FindClaudeBinaryInput): Promise<string> {
  const platform = input.platform ?? process.platform;
  const delimiter = input.pathDelimiter ?? (platform === "win32" ? ";" : ":");
  const searchPath = input.env.PATH ?? "";
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of searchPath.split(delimiter)) {
    if (dir === "") {
      continue;
    }
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return "";
}

async function isExecutable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  const mode = platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK;
  try {
    await access(file, mode);
    return true;
  } catch {
    return false;
  }
}

/** What a run's process is told when Claude Code is not installed. */
export const CLAUDE_NOT_INSTALLED =
  "Claude Code is not installed; install it and run `claude auth login`";
