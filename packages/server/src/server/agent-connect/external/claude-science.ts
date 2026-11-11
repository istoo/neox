import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { readJsonObject } from "../config-files.js";

const exec = promisify(execFile);

/**
 * Claude Science's daemon reads its API address from ANTHROPIC_BASE_URL and
 * has no setting for it, so Neolix starts it with the variable itself. The
 * note of the daemon Neolix started is what keeps it connected; the keeper
 * starts that daemon again whenever it isn't running (myna's
 * KeepClaudeScience).
 */

export const SCIENCE_VAR = "ANTHROPIC_BASE_URL";
export const SCIENCE_MARK = "claude-science.json";

export interface ScienceStatus {
  running: boolean;
  pid: number;
  port?: number;
}

export type ScienceRun = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;

export interface ScienceEnvironment {
  homeDir: string;
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  runWithEnv?: ScienceRun;
}

export interface ScienceMark {
  url: string;
  pid: number;
  port?: number;
}

/** Where Neolix notes the daemon it started: the daemon's own folder holds it. */
export function scienceMarkPath(environment: ScienceEnvironment): string {
  return path.join(environment.homeDir, ".claude-science", SCIENCE_MARK);
}

/** claude-science's program: its app bundle, its installer's folder, or PATH. */
export async function findScience(environment: ScienceEnvironment): Promise<string | null> {
  const home = environment.homeDir;
  const candidates: string[] = [];
  const exe = environment.platform === "win32" ? "claude-science.exe" : "claude-science";
  if (environment.platform === "darwin") {
    for (const folder of [path.join(home, "Applications"), "/Applications"]) {
      candidates.push(
        path.join(folder, "Claude Science.app", "Contents", "Resources", "bin", "claude-science"),
      );
    }
  } else if (environment.platform === "win32") {
    const local = environment.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    candidates.push(path.join(local, "Programs", "ClaudeScience", exe));
  }
  candidates.push(path.join(home, ".local", "bin", exe));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next place.
    }
  }
  const pathVar = environment.env.PATH ?? environment.env.Path ?? "";
  for (const directory of pathVar.split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, exe);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next folder.
    }
  }
  return null;
}

export async function scienceStatus(
  bin: string,
  run: ScienceRun,
  env: NodeJS.ProcessEnv,
): Promise<ScienceStatus | null> {
  try {
    const out = await run(bin, ["status"], env);
    const parsed: unknown = JSON.parse(out);
    return typeof parsed === "object" && parsed !== null ? (parsed as ScienceStatus) : null;
  } catch {
    return null;
  }
}

/** The daemon's environment: Neolix's own with the gateway's address, or without it. */
export function scienceEnv(base: NodeJS.ProcessEnv, baseUrl: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase() !== SCIENCE_VAR) env[key] = value;
  }
  if (baseUrl !== null) env[SCIENCE_VAR] = baseUrl;
  return env;
}

export async function readScienceMark(
  environment: ScienceEnvironment,
): Promise<ScienceMark | null> {
  try {
    const value = await readJsonObject(scienceMarkPath(environment));
    if (typeof value.url !== "string" || typeof value.pid !== "number") return null;
    return {
      url: value.url,
      pid: value.pid,
      ...(typeof value.port === "number" ? { port: value.port } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeScienceMark(
  environment: ScienceEnvironment,
  mark: ScienceMark,
): Promise<void> {
  const file = scienceMarkPath(environment);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
}

export async function removeScienceMark(environment: ScienceEnvironment): Promise<void> {
  await fs.rm(scienceMarkPath(environment), { force: true });
}

function runOf(environment: ScienceEnvironment): ScienceRun {
  if (environment.runWithEnv !== undefined) return environment.runWithEnv;
  return async (command, args, env) => {
    const { stdout } = await exec(command, args, {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90_000,
    });
    return stdout;
  };
}

/** Starts the daemon on baseUrl (null: without it), on the port it was on; waits for status. */
export async function scienceServe(
  environment: ScienceEnvironment,
  bin: string,
  baseUrl: string | null,
  port: number | undefined,
): Promise<ScienceStatus> {
  const run = runOf(environment);
  const args = ["serve", "--detached", "--no-browser"];
  if (port !== undefined && port > 0) args.push("--port", String(port));
  await run(bin, args, scienceEnv({ ...process.env, ...environment.env }, baseUrl));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await scienceStatus(bin, run, { ...process.env, ...environment.env });
    if (status?.running === true) return status;
    if (Date.now() > deadline) {
      throw new Error("claude-science serve: its daemon is not running (see claude-science logs).");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Connects the daemon: stops one running and starts it on the gateway. */
export async function scienceConnect(
  environment: ScienceEnvironment,
  baseUrl: string,
): Promise<ScienceMark> {
  const bin = await findScience(environment);
  if (bin === null) {
    throw new Error("Claude Science is not installed (no claude-science found).");
  }
  const run = runOf(environment);
  const before = await scienceStatus(bin, run, { ...process.env, ...environment.env });
  if (before?.running === true) {
    await run(bin, ["stop"], { ...process.env, ...environment.env });
  }
  const status = await scienceServe(environment, bin, baseUrl, before?.port);
  const mark: ScienceMark = {
    url: baseUrl,
    pid: status.pid,
    ...(status.port === undefined ? {} : { port: status.port }),
  };
  await writeScienceMark(environment, mark);
  return mark;
}

/** Disconnects the daemon Neolix started: restarts it without the variable. */
export async function scienceDisconnect(environment: ScienceEnvironment): Promise<void> {
  const mark = await readScienceMark(environment);
  const bin = await findScience(environment);
  if (mark !== null && bin !== null) {
    const run = runOf(environment);
    const status = await scienceStatus(bin, run, { ...process.env, ...environment.env });
    if (status?.running === true) {
      await run(bin, ["stop"], { ...process.env, ...environment.env });
      await scienceServe(environment, bin, null, mark.port);
    }
  }
  await removeScienceMark(environment);
}

/**
 * Keeps the daemon Neolix started running (myna's KeepClaudeScience): one
 * not running is started on the gateway note's address; one running is
 * never stopped.
 */
export function createScienceKeeper(options: {
  environment: () => ScienceEnvironment;
  log?: (message: string, error?: unknown) => void;
  intervalMs?: number;
}): { tick: () => Promise<void>; start: () => Promise<() => void> } {
  const log = options.log ?? ((message, error) => console.warn(message, error ?? ""));
  const tick = async (): Promise<void> => {
    const environment = options.environment();
    const mark = await readScienceMark(environment);
    if (mark === null) return;
    const bin = await findScience(environment);
    if (bin === null) return;
    const run = runOf(environment);
    const status = await scienceStatus(bin, run, { ...process.env, ...environment.env });
    if (status?.running === true) return;
    try {
      const started = await scienceServe(environment, bin, mark.url, mark.port);
      await writeScienceMark(environment, {
        url: mark.url,
        pid: started.pid,
        ...(started.port === undefined ? {} : { port: started.port }),
      });
    } catch (error) {
      log("Claude Science: starting its daemon on Neox's gateway failed", error);
    }
  };
  return {
    tick,
    start: async () => {
      await tick();
      const timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
