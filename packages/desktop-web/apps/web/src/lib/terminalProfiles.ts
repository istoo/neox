// Terminal profiles are the daemon's per-host list of commands to start in a
// terminal instead of the default shell. The prompt placeholder vocabulary is
// copied from the daemon protocol so a profile that carries it launches as its
// bare command when the dock has nowhere to type a prompt.

export const PROMPT_SENTINEL = "{{{prompt}}}";

export interface TerminalProfileWire {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly icon?: string;
}

export interface TerminalProfileLaunch {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
}

/** The daemon's built-ins, shown until the host's own list is written. */
export const DEFAULT_TERMINAL_PROFILES: readonly TerminalProfileWire[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [PROMPT_SENTINEL], icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: [PROMPT_SENTINEL], icon: "codex" },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: [`--prompt=${PROMPT_SENTINEL}`],
    icon: "opencode",
  },
  { id: "pi", name: "Pi", command: "pi", args: [PROMPT_SENTINEL], icon: "pi" },
];

export function resolveTerminalProfileList(
  profiles: ReadonlyArray<TerminalProfileWire> | undefined,
): readonly TerminalProfileWire[] {
  return profiles === undefined ? DEFAULT_TERMINAL_PROFILES : profiles;
}

function replaceSentinel(value: string, prompt: string): string {
  return value.split(PROMPT_SENTINEL).join(prompt);
}

/** An arg that exists only to carry a prompt, dropped when there is no prompt. */
function isPromptOnlyArg(arg: string): boolean {
  if (arg === PROMPT_SENTINEL) return true;
  const separator = arg.indexOf("=");
  return separator > 0 && arg.slice(separator + 1) === PROMPT_SENTINEL;
}

/** What to spawn for a profile, with its prompt sentinel resolved (usually empty). */
export function resolveTerminalProfileLaunch(
  profile: TerminalProfileWire,
  prompt = "",
): TerminalProfileLaunch {
  return {
    name: profile.name,
    command: replaceSentinel(profile.command, prompt),
    args: (profile.args ?? []).flatMap((arg) =>
      prompt === "" && isPromptOnlyArg(arg) ? [] : [replaceSentinel(arg, prompt)],
    ),
  };
}
