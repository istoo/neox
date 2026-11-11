import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { discoverWslRows, parseWslProvider, type WslRow } from "../agent-connect/external/wsl.js";

/** The MCP file shape each agent reads. */
export type LibraryMcpFormat =
  | "claude"
  | "codex"
  | "copilot"
  | "opencode"
  | "pi"
  | "omp"
  | "gemini"
  | "antigravity"
  | "cursor"
  | "grok"
  | "crush"
  | "zcode"
  | "kimi"
  | "devin"
  | "goose"
  | "hermes";

export type LibrarySubagentKind =
  | "claude"
  | "codex"
  | "opencode"
  | "copilot"
  | "gemini"
  | "qwen"
  | "droid"
  | "grok"
  | "cursor";

/**
 * Where one agent keeps the files the Library writes.
 *
 * A null path means the agent has no user-wide place for that kind, so the
 * page does not offer it. Paths follow the agent's own documentation, the
 * same ones myna uses; the environment moves them where the agent's own
 * environment variables say.
 */
export interface LibraryAgentTarget {
  id: string;
  name: string;
  /** Provider icon id from `@/components/provider-icons`. */
  icon: string;
  /**
   * Agents Neolix launches are always listed. Another agent myna can write
   * is listed only when its own config folder is on this computer.
   */
  optional?: boolean;
  configDir?: string;
  instructionsPath: string;
  /** A file an agent reads instead of the instructions, when present. */
  overridePath?: string;
  mcpPath?: string;
  mcpFormat?: LibraryMcpFormat;
  skillsDir?: string;
  /** JSON file holding hooks, in the shared shape. */
  hooksPath?: string;
  subagentsDir?: string;
  subagentKind?: LibrarySubagentKind;
  /** Set when the agent lives in a WSL distro: its paths are that home's. */
  distro?: string;
  /** An agent that isn't installed here: it reads no skills (myna's Gone). */
  gone?: boolean;
  /** A desktop-only agent, whose skills are its own (myna's Desktop). */
  desktop?: boolean;
  /** Reads ~/.agents/skills besides its own folder (myna's SharedToo). */
  sharedToo?: boolean;
}

export interface LibraryPathOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Agents of the running WSL distros, as agent-connect lists them. */
  wslRows?: readonly WslRow[];
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

async function firstExisting(dir: string, names: readonly string[]): Promise<string> {
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // not there: try the next name the agent reads
    }
  }
  return path.join(dir, names[0]);
}

async function isThere(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every agent the Library can write to: Neolix's own providers, and the
 * other agents myna knows whose config folder exists on this computer.
 */
async function buildTargets(options: LibraryPathOptions = {}): Promise<LibraryAgentTarget[]> {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;

  const claudeDir = envValue(env, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude");
  const codexDir = envValue(env, "CODEX_HOME") ?? path.join(home, ".codex");
  const copilotDir = envValue(env, "COPILOT_HOME") ?? path.join(home, ".copilot");
  const xdgConfig = envValue(env, "XDG_CONFIG_HOME") ?? path.join(home, ".config");
  const opencodeDir = path.dirname(
    envValue(env, "OPENCODE_CONFIG") ?? path.join(xdgConfig, "opencode", "opencode.json"),
  );
  const piDir = envValue(env, "PI_CODING_AGENT_DIR") ?? path.join(home, ".pi", "agent");
  const ompDir = path.join(home, ".omp", "agent");
  const geminiDir = path.join(home, ".gemini");
  const agyDir = path.join(geminiDir, "config");
  const cursorDir = path.join(home, ".cursor");
  const droidDir = path.join(home, ".factory");
  const qwenDir = envValue(env, "QWEN_HOME") ?? path.join(home, ".qwen");
  const grokDir = envValue(env, "GROK_HOME") ?? path.join(home, ".grok");
  const crushDir = path.join(xdgConfig, "crush");
  const zcodeDir = path.join(home, ".zcode");
  const kimiDir = (await isThere(path.join(home, ".kimi-code")))
    ? path.join(home, ".kimi-code")
    : path.join(home, ".kimi");
  const devinDir = path.join(home, ".devin");
  const qoderDir = path.join(home, ".qoder");
  const gooseDir = path.join(xdgConfig, "goose");
  const hermesDir = envValue(env, "HERMES_HOME") ?? path.join(home, ".hermes");

  return [
    {
      id: "claude",
      name: "Claude Code",
      icon: "claude",
      instructionsPath: path.join(claudeDir, "CLAUDE.md"),
      mcpPath: envValue(env, "CLAUDE_CONFIG_DIR")
        ? path.join(claudeDir, ".claude.json")
        : path.join(home, ".claude.json"),
      mcpFormat: "claude",
      skillsDir: path.join(claudeDir, "skills"),
      hooksPath: path.join(claudeDir, "settings.json"),
      subagentsDir: path.join(claudeDir, "agents"),
      subagentKind: "claude",
    },
    {
      id: "codex",
      name: "Codex",
      icon: "codex",
      instructionsPath: path.join(codexDir, "AGENTS.md"),
      overridePath: path.join(codexDir, "AGENTS.override.md"),
      mcpPath: path.join(codexDir, "config.toml"),
      mcpFormat: "codex",
      skillsDir: path.join(codexDir, "skills"),
      hooksPath: path.join(codexDir, "hooks.json"),
      subagentsDir: path.join(codexDir, "agents"),
      subagentKind: "codex",
    },
    {
      id: "copilot",
      name: "GitHub Copilot",
      icon: "copilot",
      instructionsPath: path.join(copilotDir, "copilot-instructions.md"),
      mcpPath: path.join(copilotDir, "mcp-config.json"),
      mcpFormat: "copilot",
      skillsDir: path.join(copilotDir, "skills"),
      subagentsDir: path.join(copilotDir, "agents"),
      subagentKind: "copilot",
    },
    {
      id: "opencode",
      name: "OpenCode",
      icon: "opencode",
      instructionsPath: path.join(opencodeDir, "AGENTS.md"),
      mcpPath: path.join(opencodeDir, "opencode.json"),
      mcpFormat: "opencode",
      skillsDir: path.join(opencodeDir, "skills"),
      subagentsDir: path.join(opencodeDir, "agents"),
      subagentKind: "opencode",
    },
    {
      id: "pi",
      name: "Pi",
      icon: "pi",
      instructionsPath: await firstExisting(piDir, [
        "AGENTS.md",
        "AGENTS.MD",
        "CLAUDE.md",
        "CLAUDE.MD",
      ]),
      overridePath: path.join(piDir, "AGENTS.override.md"),
      mcpPath: path.join(piDir, "mcp.json"),
      mcpFormat: "pi",
      skillsDir: path.join(piDir, "skills"),
    },
    {
      id: "omp",
      name: "Oh My Pi",
      icon: "omp",
      instructionsPath: path.join(ompDir, "AGENTS.md"),
      mcpPath: path.join(ompDir, "mcp.json"),
      mcpFormat: "omp",
      skillsDir: path.join(ompDir, "skills"),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      icon: "gemini",
      optional: true,
      configDir: geminiDir,
      instructionsPath: path.join(geminiDir, "GEMINI.md"),
      mcpPath: path.join(geminiDir, "settings.json"),
      mcpFormat: "gemini",
      skillsDir: path.join(geminiDir, "skills"),
      hooksPath: path.join(geminiDir, "settings.json"),
      subagentsDir: path.join(geminiDir, "agents"),
      subagentKind: "gemini",
    },
    {
      id: "agy",
      name: "Antigravity",
      icon: "antigravity",
      optional: true,
      configDir: agyDir,
      instructionsPath: path.join(agyDir, "GEMINI.md"),
      mcpPath: path.join(agyDir, "mcp_config.json"),
      mcpFormat: "antigravity",
      skillsDir: path.join(agyDir, "skills"),
    },
    {
      id: "cursor",
      name: "Cursor",
      icon: "cursor",
      optional: true,
      configDir: cursorDir,
      // Cursor reads rules, not a user-wide instructions file myna writes.
      instructionsPath: "",
      mcpPath: path.join(cursorDir, "mcp.json"),
      mcpFormat: "cursor",
      skillsDir: path.join(cursorDir, "skills"),
      hooksPath: path.join(cursorDir, "hooks.json"),
      subagentsDir: path.join(cursorDir, "agents"),
      subagentKind: "cursor",
    },
    {
      id: "droid",
      name: "Factory Droid",
      icon: "droid",
      optional: true,
      configDir: droidDir,
      instructionsPath: path.join(droidDir, "AGENTS.md"),
      mcpPath: path.join(droidDir, "mcp.json"),
      mcpFormat: "claude",
      skillsDir: path.join(droidDir, "skills"),
      subagentsDir: path.join(droidDir, "droids"),
      subagentKind: "droid",
    },
    {
      id: "qwen",
      name: "Qwen Code",
      icon: "qwen",
      optional: true,
      configDir: qwenDir,
      instructionsPath: path.join(qwenDir, "QWEN.md"),
      skillsDir: path.join(qwenDir, "skills"),
      subagentsDir: path.join(qwenDir, "agents"),
      subagentKind: "qwen",
    },
    {
      id: "grok",
      name: "Grok Build",
      icon: "grok",
      optional: true,
      configDir: grokDir,
      instructionsPath: path.join(grokDir, "AGENTS.md"),
      mcpPath: path.join(grokDir, "config.toml"),
      mcpFormat: "grok",
      skillsDir: path.join(grokDir, "skills"),
      subagentsDir: path.join(grokDir, "agents"),
      subagentKind: "grok",
    },
    {
      id: "crush",
      name: "Crush",
      icon: "crush",
      optional: true,
      configDir: crushDir,
      instructionsPath: path.join(crushDir, "CRUSH.md"),
      mcpPath: path.join(crushDir, "crush.json"),
      mcpFormat: "crush",
      skillsDir: path.join(crushDir, "skills"),
    },
    {
      id: "zcode",
      name: "ZCode",
      icon: "zcode",
      optional: true,
      configDir: zcodeDir,
      instructionsPath: path.join(zcodeDir, "AGENTS.md"),
      mcpPath: path.join(zcodeDir, "cli", "config.json"),
      mcpFormat: "zcode",
      skillsDir: path.join(zcodeDir, "skills"),
    },
    {
      id: "kimi",
      name: "Kimi Code",
      icon: "kimi",
      optional: true,
      configDir: kimiDir,
      // Only the new Kimi Code reads a user-wide AGENTS.md.
      instructionsPath: kimiDir.endsWith(".kimi-code") ? path.join(kimiDir, "AGENTS.md") : "",
      mcpPath: path.join(kimiDir, "mcp.json"),
      mcpFormat: "kimi",
      skillsDir: path.join(kimiDir, "skills"),
    },
    {
      id: "devin",
      name: "Devin",
      icon: "devin",
      optional: true,
      configDir: devinDir,
      instructionsPath: await firstExisting(devinDir, ["AGENTS.md", "AGENT.md"]),
      mcpPath: path.join(devinDir, "mcp_config.json"),
      mcpFormat: "devin",
      skillsDir: path.join(devinDir, "skills"),
    },
    {
      id: "qoder",
      name: "Qoder",
      icon: "qoder",
      optional: true,
      configDir: qoderDir,
      instructionsPath: path.join(qoderDir, "AGENTS.md"),
      mcpPath: path.join(qoderDir, "settings.json"),
      mcpFormat: "omp",
      skillsDir: path.join(qoderDir, "skills"),
    },
    {
      id: "goose",
      name: "Goose",
      icon: "goose",
      optional: true,
      configDir: gooseDir,
      instructionsPath: path.join(gooseDir, ".goosehints"),
      mcpPath: path.join(gooseDir, "config.yaml"),
      mcpFormat: "goose",
      skillsDir: path.join(home, ".agents", "skills"),
    },
    {
      id: "hermes",
      name: "Hermes",
      icon: "hermes",
      optional: true,
      configDir: hermesDir,
      // Hermes has no user-wide instructions file in myna's map.
      instructionsPath: "",
      mcpPath: path.join(hermesDir, "config.yaml"),
      mcpFormat: "hermes",
      skillsDir: path.join(hermesDir, "skills"),
    },
  ];
}

/**
 * The agents the page offers: Neolix's providers, and each other agent myna
 * knows whose own config folder is on this computer.
 */
export async function resolveLibraryAgentTargets(
  options: LibraryPathOptions = {},
): Promise<LibraryAgentTarget[]> {
  const rows = await buildTargets(options);
  const shown: LibraryAgentTarget[] = [];
  for (const target of rows) {
    if (!target.optional || (target.configDir && (await isThere(target.configDir)))) {
      shown.push(target);
    }
  }
  for (const row of options.wslRows ?? (await libraryWslRows())) {
    const parsed = parseWslProvider(row.provider);
    if (parsed === null) {
      continue;
    }
    // the agent's own folder inside the distro, opened through its share,
    // with no Windows variables deciding where its files are
    const inDistro = await buildTargets({ homeDir: row.uncHome, env: {} });
    const target = inDistro.find((one) => one.id === parsed.driver);
    if (target === undefined) {
      continue;
    }
    shown.push({
      ...uncTarget(target),
      id: row.provider,
      name: row.name,
      icon: row.icon,
      distro: parsed.distro,
      optional: false,
    });
  }
  return shown;
}

export function findLibraryAgentTarget(
  targets: readonly LibraryAgentTarget[],
  id: string,
): LibraryAgentTarget | undefined {
  return targets.find((target) => target.id === id);
}

/** The paths Windows opens a distro's home by, with Windows' separators. */
function uncTarget(target: LibraryAgentTarget): LibraryAgentTarget {
  const fix = (value: string): string => value.replaceAll("/", "\\");
  return {
    ...target,
    ...(target.configDir === undefined ? {} : { configDir: fix(target.configDir) }),
    instructionsPath: fix(target.instructionsPath),
    ...(target.overridePath === undefined ? {} : { overridePath: fix(target.overridePath) }),
    ...(target.mcpPath === undefined ? {} : { mcpPath: fix(target.mcpPath) }),
    ...(target.skillsDir === undefined ? {} : { skillsDir: fix(target.skillsDir) }),
    ...(target.hooksPath === undefined ? {} : { hooksPath: fix(target.hooksPath) }),
    ...(target.subagentsDir === undefined ? {} : { subagentsDir: fix(target.subagentsDir) }),
  };
}

/** The running distros' agents; none off Windows, where there are none to find. */
async function libraryWslRows(): Promise<readonly WslRow[]> {
  if (process.platform !== "win32") {
    return [];
  }
  // the row's gateway address isn't the Library's business; its paths are
  return discoverWslRows("http://127.0.0.1");
}
