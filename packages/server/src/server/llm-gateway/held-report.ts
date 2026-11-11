import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "pino";

/**
 * A request the gateway holds too long before routing it is written to a
 * report of its own (myna's held_report.go): the daemon's log is not what a
 * user sends with a bug report. The report names when, the method and path,
 * the model and agent, how long it was held, how many requests were in
 * flight, and where the event loop stood; never the body or a header. The
 * newest HELD_KEPT reports are kept in `$NEOLIX_HOME/held`.
 *
 * myna reads a report from its Routing page's row for the request, which names
 * the file (trace.go Route.Held) and fetches it at /api/gateway/held/{name}.
 * Neolix's routing rows don't carry that name yet — the trace is written in the
 * routing module's hot path — so the page lists the newest reports (the
 * gateway.held.list / .read RPCs) and copies one from there.
 */

export const HELD_KEPT = 5;
const HELD_NAME = /^held-\d{8}-\d{6}-\d{9}\.txt$/;

export interface HeldReportInput {
  method: string;
  path: string;
  model: string;
  agent: string;
  provider: string;
  /** How long the request waited for a free account, in milliseconds. */
  waitedMs: number;
  inFlight: number;
}

export class HeldReportStore {
  public readonly dir: string;
  private lastAt = 0;

  constructor(
    neolixHome: string,
    private readonly logger?: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = path.join(neolixHome, "held");
  }

  /** Saves a report and answers its file name; null when it couldn't be written. */
  public async record(input: HeldReportInput): Promise<string | null> {
    const at = Math.max(this.now(), this.lastAt + 1);
    this.lastAt = at;
    const name = `held-${nameOf(at)}.txt`;
    const target = path.join(this.dir, name);
    const temporary = path.join(this.dir, `.held-${randomUUID()}`);
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, this.report(input, at), { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      this.logger?.warn({ err: error, dir: this.dir }, "Cannot write a held-request report");
      return null;
    }
    await this.prune();
    return name;
  }

  /** The report named name, or null when the name is not one of ours. */
  public async read(name: string): Promise<string | null> {
    if (!HELD_NAME.test(name)) {
      return null;
    }
    try {
      return await readFile(path.join(this.dir, name), "utf8");
    } catch {
      return null;
    }
  }

  /** The reports kept, newest first, for the routing page. */
  public async list(): Promise<string[]> {
    try {
      const names = (await readdir(this.dir)).filter((name) => HELD_NAME.test(name));
      return names.sort().toReversed();
    } catch {
      return [];
    }
  }

  private report(input: HeldReportInput, at: number): string {
    return [
      "Neox held a request before routing it; no free account answered in time",
      "",
      `time: ${new Date(at).toISOString()}`,
      `request: ${input.method} ${input.path}`,
      `model: ${input.model}`,
      `agent: ${input.agent}`,
      `provider: ${input.provider}`,
      `held: ${Math.round(input.waitedMs / 1000)}s waiting for an account`,
      `requests in flight: ${input.inFlight}`,
      "",
      "where the event loop stood:",
      new Error("held request").stack ?? "(no stack)",
      "",
    ].join("\n");
  }

  private async prune(): Promise<void> {
    try {
      const names = (await readdir(this.dir)).filter((name) => HELD_NAME.test(name)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - HELD_KEPT))) {
        await rm(path.join(this.dir, name), { force: true });
      }
    } catch {
      // Nothing to prune.
    }
  }
}

let store: HeldReportStore | null = null;

export function configureHeldReports(input: HeldReportStore): void {
  store = input;
}

/** Records a request held past its queue wait; null before configuration. */
export function recordHeldRequest(input: HeldReportInput): Promise<string | null> {
  if (store === null) {
    return Promise.resolve(null);
  }
  return store.record(input);
}

/** The reports kept, newest first; myna keeps the last heldKept (held_report.go). */
export function listHeldReports(): Promise<string[]> {
  return store === null ? Promise.resolve([]) : store.list();
}

/** The report named name; null when it is not one of ours or no longer kept. */
export function readHeldReport(name: string): Promise<string | null> {
  return store === null ? Promise.resolve(null) : store.read(name);
}

export interface HeldRevealResult {
  ok: boolean;
  error?: string;
}

/**
 * The command a desktop opens a folder with, or selects one file in it with
 * (myna's `w.OpenFolder`, which only the app's window has). Kept apart from
 * the spawn so tests can read it without opening a Finder window.
 */
export function revealCommand(
  platform: NodeJS.Platform,
  folder: string,
  file?: string,
): { command: string; args: string[] } {
  if (platform === "darwin") {
    return {
      command: "open",
      args: file === undefined ? [folder] : ["-R", path.join(folder, file)],
    };
  }
  if (platform === "win32") {
    return {
      command: "explorer",
      args: file === undefined ? [folder] : [`/select,${path.join(folder, file)}`],
    };
  }
  // Most Linux file managers open the folder; selecting one file is not
  // something xdg-open does everywhere.
  return { command: "xdg-open", args: [folder] };
}

/**
 * Opens the folder the held reports are kept in, or selects one report in it.
 * Only a name this module itself wrote is accepted, so nothing outside the
 * folder is ever revealed.
 */
export async function revealHeldReport(name?: string): Promise<HeldRevealResult> {
  if (store === null) {
    return { ok: false, error: "this daemon keeps no held reports" };
  }
  const folder = store.dir;
  if (name !== undefined) {
    if (!HELD_NAME.test(name)) {
      return { ok: false, error: "that is not a held report's name" };
    }
    try {
      await access(path.join(folder, name));
    } catch {
      return { ok: false, error: "this report is no longer kept: Neox keeps the last 5" };
    }
  }
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
  } catch {
    // The folder may not be writable; open says so.
  }
  const { command, args } = revealCommand(process.platform, folder, name);
  return new Promise<HeldRevealResult>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", (error) => resolve({ ok: false, error: error.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

function nameOf(at: number): string {
  const date = new Date(at);
  const pad = (value: number, size = 2): string => String(value).padStart(size, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-` +
    `${pad(date.getUTCMilliseconds() * 1_000_000, 9)}`
  );
}
