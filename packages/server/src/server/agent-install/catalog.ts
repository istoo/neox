import type { AgentInstallCommand, AgentInstallEntry } from "@neolix/protocol/agent-install";
import { AGENT_PROVIDER_DEFINITIONS } from "@neolix/protocol/provider-manifest";

/**
 * The commands each vendor's docs give for installing its CLI, ported from
 * myna's `internal/agent/install.go`. The daemon only ever runs one of
 * these fixed lines; the client names an entry, never a command.
 */
export interface AgentInstallCatalogEntry {
  provider: string;
  /** For an agent that is not a Neolix provider; a provider's own label wins. */
  name?: string;
  description?: string;
  url: string | null;
  /** Commands by platform; an absent platform has no command. */
  commands: Partial<Record<NodeJS.Platform | "posix", AgentInstallCommand[]>>;
  /**
   * The vendor's documented uninstall of what `commands` installed, by the
   * same platform keys. Only the program itself: the user's settings and
   * sign-ins stay.
   */
  uninstall?: Partial<Record<NodeJS.Platform | "posix", AgentInstallCommand[]>>;
}

const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const CLAUDE_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"';
// Anthropic's own uninstall for the native installation the line above
// makes (setup docs, "Uninstall a native installation").
const CLAUDE_UNINSTALL = "rm -f ~/.local/bin/claude && rm -rf ~/.local/share/claude";
const CLAUDE_UNINSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "Remove-Item -Path \\"$env:USERPROFILE\\.local\\bin\\claude.exe\\" -Force; Remove-Item -Path \\"$env:USERPROFILE\\.local\\share\\claude\\" -Recurse -Force"';
const CODEX_INSTALL = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_INSTALL_WINDOWS =
  'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"';
const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/install | bash";

export const AGENT_INSTALL_CATALOG: AgentInstallCatalogEntry[] = [
  {
    provider: "claude",
    url: "https://code.claude.com/docs/en/setup",
    commands: {
      posix: [{ id: "script", via: "script", command: CLAUDE_INSTALL }],
      win32: [{ id: "powershell", via: "powershell", command: CLAUDE_INSTALL_WINDOWS }],
    },
    uninstall: {
      posix: [{ id: "script", via: "script", command: CLAUDE_UNINSTALL }],
      win32: [{ id: "powershell", via: "powershell", command: CLAUDE_UNINSTALL_WINDOWS }],
    },
  },
  {
    provider: "codex",
    url: "https://github.com/openai/codex",
    commands: {
      posix: [
        { id: "script", via: "script", command: CODEX_INSTALL },
        { id: "brew", via: "brew", command: "brew install --cask codex" },
      ],
      win32: [{ id: "powershell", via: "powershell", command: CODEX_INSTALL_WINDOWS }],
    },
  },
  {
    provider: "copilot",
    url: "https://github.com/github/copilot-cli",
    commands: {
      posix: [
        { id: "npm", via: "npm", command: "npm install -g @github/copilot" },
        { id: "brew", via: "brew", command: "brew install copilot-cli" },
      ],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @github/copilot" }],
    },
  },
  {
    provider: "opencode",
    url: "https://opencode.ai/docs",
    commands: {
      posix: [{ id: "script", via: "script", command: OPENCODE_INSTALL }],
    },
  },
  {
    provider: "pi",
    url: "https://github.com/earendil-works/pi",
    commands: {
      posix: [
        { id: "npm", via: "npm", command: "npm install -g @earendil-works/pi-coding-agent" },
        { id: "brew", via: "brew", command: "brew install pi-coding-agent" },
      ],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @earendil-works/pi-coding-agent" }],
    },
  },
  {
    provider: "omp",
    url: "https://github.com/oh-my-pi/pi",
    commands: {
      posix: [{ id: "npm", via: "npm", command: "npm install -g @oh-my-pi/pi-coding-agent" }],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @oh-my-pi/pi-coding-agent" }],
    },
  },
  // External agents Neolix wires to the gateway but does not run itself. The
  // commands are the ones myna's install list gives for them; an agent myna
  // has no command for (agy, Qoder, Kimi, Droid, Zed) is not listed here.
  {
    provider: "gemini",
    name: "Gemini CLI",
    description: "Google's Gemini in the terminal, wired through the gateway's Gemini endpoint.",
    url: "https://github.com/google-gemini/gemini-cli",
    commands: {
      posix: [
        { id: "brew", via: "brew", command: "brew install gemini-cli" },
        { id: "npm", via: "npm", command: "npm install -g @google/gemini-cli" },
      ],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @google/gemini-cli" }],
    },
  },
  {
    provider: "cline",
    name: "Cline",
    description: "Cline's command-line agent, pointed at the gateway as an OpenAI provider.",
    url: "https://github.com/cline/cline",
    commands: {
      posix: [
        { id: "npm", via: "npm", command: "npm install -g cline" },
        { id: "brew", via: "brew", command: "brew install cline" },
      ],
      win32: [{ id: "npm", via: "npm", command: "npm install -g cline" }],
    },
  },
  {
    provider: "goose",
    name: "Goose",
    description: "Block's Goose, connected through a custom provider entry.",
    url: "https://block.github.io/goose/",
    commands: {
      posix: [{ id: "brew", via: "brew", command: "brew install block-goose-cli" }],
    },
  },
  {
    provider: "grok",
    name: "Grok Build",
    description: "xAI's Grok CLI, with the gateway's models added to its picker.",
    url: "https://x.ai/cli",
    commands: {
      posix: [{ id: "brew", via: "brew", command: "brew install grok-build" }],
    },
  },
  {
    // Cursor CLI's installer is the only official command; it updates itself.
    provider: "cursor",
    name: "Cursor CLI",
    description: "Cursor's terminal agent. It runs on Cursor's own models.",
    url: "https://cursor.com/install",
    commands: {},
  },
  {
    provider: "codebuddy",
    name: "CodeBuddy",
    description: "Tencent's CodeBuddy coding agent, using the gateway's models.",
    url: "https://www.codebuddy.ai/",
    commands: {
      posix: [{ id: "npm", via: "npm", command: "npm install -g @tencent-ai/codebuddy-code" }],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @tencent-ai/codebuddy-code" }],
    },
  },
  {
    provider: "snow",
    name: "Snow CLI",
    description: "Snow CLI, connected through a profile of its own.",
    url: "https://github.com/MayDay-wpf/snow-cli",
    commands: {
      posix: [{ id: "npm", via: "npm", command: "npm install -g snow-ai" }],
      win32: [{ id: "npm", via: "npm", command: "npm install -g snow-ai" }],
    },
  },
  {
    provider: "dsh",
    name: "DeepSeek Harness",
    description: "DeepSeek's agent harness, connected through a custom model provider.",
    url: "https://github.com/deepseek-ai/dsh",
    commands: {
      posix: [{ id: "npm", via: "npm", command: "npm install -g @deepseek-ai/dsh" }],
      win32: [{ id: "npm", via: "npm", command: "npm install -g @deepseek-ai/dsh" }],
    },
  },
];

/** The commands this platform can run, in the order the vendor lists them. */
export function commandsForPlatform(
  entry: AgentInstallCatalogEntry,
  platform: NodeJS.Platform,
): AgentInstallCommand[] {
  if (platform === "win32") {
    return entry.commands.win32 ?? [];
  }
  return [...(entry.commands.posix ?? []), ...(entry.commands[platform] ?? [])];
}

/** The vendor's uninstall lines this platform can run; empty when it documents none. */
export function uninstallCommandsForPlatform(
  entry: AgentInstallCatalogEntry,
  platform: NodeJS.Platform,
): AgentInstallCommand[] {
  const uninstall = entry.uninstall;
  if (uninstall === undefined) {
    return [];
  }
  if (platform === "win32") {
    return uninstall.win32 ?? [];
  }
  return [...(uninstall.posix ?? []), ...(uninstall[platform] ?? [])];
}

/** The name and description come from the provider manifest, so they match the rest of Neolix. */
export function installEntriesForPlatform(
  catalog: AgentInstallCatalogEntry[],
  platform: NodeJS.Platform,
): AgentInstallEntry[] {
  return catalog.map((entry) => {
    const definition = AGENT_PROVIDER_DEFINITIONS.find(
      (candidate) => candidate.id === entry.provider,
    );
    const uninstallCommands = uninstallCommandsForPlatform(entry, platform);
    return {
      provider: entry.provider,
      name: definition?.label ?? entry.name ?? entry.provider,
      description: definition?.description ?? entry.description ?? "",
      url: entry.url,
      commands: commandsForPlatform(entry, platform),
      ...(uninstallCommands.length === 0 ? {} : { uninstallCommands }),
    };
  });
}
