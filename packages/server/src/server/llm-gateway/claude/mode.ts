/**
 * How a Claude subscription's runs are made on this machine, for the Claude
 * Code provider editor (myna's `ClaudeModeNow`, claude_subscription.go):
 * Claude Code's interactive mode (TUI), or `claude -p`. `tui` is whether a
 * run can be the interactive mode; `why` names why not — the setting off,
 * this system unsupported, or Claude Code not installed — and `last` is how
 * the last run since the daemon started went.
 */

export type ClaudeModeWhy = "" | "os" | "missing" | "off";

export interface ClaudeLastRun {
  tui: boolean;
  /** The code it ran as -p for ("off", "os", "missing"), "" for the TUI. */
  why: string;
  at: number;
}

export interface ClaudeMode {
  tui: boolean;
  why: ClaudeModeWhy;
  last: ClaudeLastRun | null;
}

export interface ClaudeModeInput {
  platform: string;
  /** Whether `claude` is on PATH. */
  hasBinary: boolean;
  /** The user turned the interactive mode off (`claudePrintMode`). */
  printMode: boolean;
}

/**
 * Why every run on this machine is -p, "" when runs can be the interactive
 * mode (myna's `claudeMachineWhy`): the system first, then Claude Code's
 * absence, then the setting.
 */
export function claudeModeWhy(input: ClaudeModeInput): ClaudeModeWhy {
  if (input.platform !== "darwin" && input.platform !== "linux" && input.platform !== "win32") {
    return "os";
  }
  if (!input.hasBinary) {
    return "missing";
  }
  if (input.printMode) {
    return "off";
  }
  return "";
}

/** The mode now, with how the last run since start went. */
export function claudeModeNow(
  input: ClaudeModeInput,
  last: ClaudeLastRun | null = lastClaudeRun(),
): ClaudeMode {
  const why = claudeModeWhy(input);
  return { tui: why === "", why, last };
}

let lastRun: ClaudeLastRun | null = null;

/** Records how a run was made: "" is the interactive mode, else why it was -p. */
export function noteClaudeRun(why: string, now: number = Date.now()): void {
  lastRun = { tui: why === "", why, at: now };
}

/** How the last run went, since the daemon started; null when none has. */
export function lastClaudeRun(): ClaudeLastRun | null {
  return lastRun;
}

/** Forgets the last run; tests use it between cases. */
export function clearClaudeRun(): void {
  lastRun = null;
}
