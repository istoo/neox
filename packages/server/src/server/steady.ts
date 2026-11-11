import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Read and replace files another process may be replacing at that moment,
 * as myna's steady package does (internal/steady/steady.go). On Windows a
 * file being renamed over refuses to open, and one held open refuses to be
 * renamed over, both for a moment ("Access is denied"): read as none, a
 * file of accounts is no accounts, and the next write leaves them out. A
 * file being renamed over is also, for a moment, not there at all.
 *
 * The wait is bounded to half a second for a held file and about 15ms for
 * a file that is really gone: what holds it is another read or rename,
 * done in milliseconds.
 */
export interface SteadyRuntime {
  /** How often a held file is tried again, in milliseconds. */
  pause: number;
  /** How many times a held file is tried. */
  tries: number;
  /** How often a file that is gone is tried again. */
  gonePause: number;
  /** How many times a file that is gone is tried. */
  goneTries: number;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultRuntime: SteadyRuntime = {
  pause: 10,
  tries: 50,
  gonePause: 1,
  goneTries: 15,
  sleep,
};

function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
}

const HELD = new Set(["EPERM", "EACCES", "EBUSY"]);

async function retry<T>(operation: () => Promise<T>, runtime: SteadyRuntime): Promise<T> {
  let error: unknown;
  for (let attempt = 0; attempt < runtime.tries; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      error = cause;
      if (!HELD.has(codeOf(cause))) {
        throw cause;
      }
      await runtime.sleep(runtime.pause);
    }
  }
  throw error;
}

/** Whether the file's folder is there; when it isn't, nothing is being renamed in. */
async function directoryThere(filePath: string): Promise<boolean> {
  try {
    const info = await fs.stat(path.dirname(filePath));
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function retryGone<T>(
  filePath: string,
  operation: () => Promise<T>,
  runtime: SteadyRuntime,
): Promise<T> {
  try {
    return await retry(operation, runtime);
  } catch (error) {
    if (codeOf(error) !== "ENOENT" || !(await directoryThere(filePath))) {
      throw error;
    }
    let last = error;
    for (let attempt = 0; attempt < runtime.goneTries; attempt += 1) {
      await runtime.sleep(runtime.gonePause);
      try {
        return await retry(operation, runtime);
      } catch (cause) {
        last = cause;
        if (codeOf(cause) !== "ENOENT") {
          throw cause;
        }
      }
    }
    throw last;
  }
}

/**
 * `fs.readFile`, waiting out a file another process is replacing: a held
 * file for up to half a second, and one briefly not there (a rename's
 * moment) for about 15ms. A file whose folder isn't there is really gone
 * and costs no wait.
 */
export function readFileSteady(
  filePath: string,
  runtime: SteadyRuntime = defaultRuntime,
): Promise<Buffer> {
  return retryGone(filePath, () => fs.readFile(filePath), runtime);
}

/** `fs.stat` of a file that was there: one being replaced is waited for. */
export function statSteady(
  filePath: string,
  runtime: SteadyRuntime = defaultRuntime,
): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  return retryGone(filePath, () => fs.stat(filePath), runtime);
}

/** `fs.rename`, waiting out a reader holding the destination open. */
export function renameSteady(
  source: string,
  destination: string,
  runtime: SteadyRuntime = defaultRuntime,
): Promise<void> {
  return retry(() => fs.rename(source, destination), runtime);
}

/**
 * Replace `filePath` with `data`, through a temp file beside it that is
 * flushed to the disk before it is renamed over. A write or flush that
 * fails removes the temp file and leaves the destination as it was
 * (myna steady.WriteFile).
 */
export async function writeFileSteady(
  filePath: string,
  data: string | Uint8Array,
  mode: number,
  runtime: SteadyRuntime = defaultRuntime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "w", mode);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameSteady(temporary, filePath, runtime);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
