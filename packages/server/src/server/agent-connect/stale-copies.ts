/**
 * Copies of an agent still running on the list they started with (myna's
 * StaleCopies): the agent reads its model list at start, so a copy started
 * before Neolix last wrote its config keeps the old one until reopened.
 * Detection reads the process table; nothing here starts or ends a process.
 */
export type StaleKind = "app" | "ide" | "daemon" | "cli";

export interface StaleCopy {
  kind: StaleKind;
  /** When the copy started, in Unix milliseconds. */
  since: number;
  /** The desktop app's bundle, for a copy that is one. */
  bundle?: string;
}

export interface RunningProcess {
  command: string;
  /** How long it has been running, in milliseconds. */
  uptimeMs: number;
}

/** `ps -axo pid=,etime=,command=` as the processes it lists. */
export function parseProcessList(output: string): RunningProcess[] {
  const out: RunningProcess[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*\d+\s+(\S+)\s+(.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    out.push({ command: match[2], uptimeMs: parseElapsed(match[1]) });
  }
  return out;
}

/** [[dd-]hh:]mm:ss, as ps prints elapsed time. */
export function parseElapsed(value: string): number {
  let rest = value.trim();
  let days = 0;
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    days = Number(rest.slice(0, dash)) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map((part) => Number(part) || 0);
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, parts[0] ?? 0, parts[1] ?? 0];
  return ((days * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
}

/** What a command line runs, for one of Codex's copies; null when it is no copy. */
export function codexCopyKind(command: string): { kind: StaleKind; bundle?: string } | null {
  const executable = command.split(/ -/u)[0] ?? command;
  const fields = command.split(/\s+/u);
  if (!/(^|[/\\])codex(\.exe)?($|\s)/u.test(command)) return null;
  // A daemon's own helpers read no list and outlive a daemon restart.
  if (fields.includes("pid-update-loop")) return null;
  if (
    fields.some((field) => field === "--managed-daemon" || field.startsWith("--managed-daemon="))
  ) {
    return { kind: "daemon" };
  }
  if (executable.includes("/extensions/")) return { kind: "ide" };
  if (executable.includes(".app/")) {
    return { kind: "app", bundle: executable.slice(0, executable.indexOf(".app/") + 4) };
  }
  return { kind: "cli" };
}

/**
 * The copies started before `changedAt`, one per app for a desktop app's
 * processes (its app-server and helpers are one copy), newest first.
 */
export function staleCopies(input: {
  agent: "codex";
  processes: RunningProcess[];
  changedAt: number;
  now?: number;
}): StaleCopy[] {
  const now = input.now ?? Date.now();
  const out: StaleCopy[] = [];
  const apps = new Map<string, number>();
  for (const process of input.processes) {
    const kind = codexCopyKind(process.command);
    if (kind === null) continue;
    const since = Math.floor((now - process.uptimeMs) / 1000) * 1000;
    if (since >= input.changedAt - 1000) continue;
    const copy: StaleCopy = { kind: kind.kind, since };
    if (kind.kind === "app" && kind.bundle !== undefined) {
      copy.bundle = kind.bundle;
      const at = apps.get(kind.bundle);
      if (at !== undefined) {
        if (since < out[at]!.since) out[at]!.since = since;
        continue;
      }
      apps.set(kind.bundle, out.length);
    }
    out.push(copy);
  }
  return out;
}

/** The command that restarts one kind of copy, or null when the reader must reopen it. */
export function restartCommands(
  agent: "codex",
  kind: StaleKind,
  bundle?: string,
): { command: string; args: string[] }[] | null {
  if (agent !== "codex") return null;
  if (kind === "daemon") return [{ command: "codex", args: ["app-server", "daemon", "restart"] }];
  if (kind === "app" && bundle !== undefined) {
    const name = bundle.slice(bundle.lastIndexOf("/") + 1).replace(/\.app$/u, "");
    return [
      { command: "osascript", args: ["-e", `tell application "${name}" to quit`] },
      { command: "open", args: [bundle] },
    ];
  }
  return null;
}
