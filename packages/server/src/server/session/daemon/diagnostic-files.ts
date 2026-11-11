import { stat, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { writeHeapSnapshot } from "node:v8";

/**
 * The Node counterparts of myna's pprof files (`myna heap`, `myna cpu`,
 * `myna goroutines`): a V8 heap snapshot, a CPU profile from the inspector,
 * and a dump of the active handles and requests. Written by the daemon, at
 * a path the client names.
 */

/** myna never writes over a file that is there (heap_cli.go:40-52). */
async function refuseExisting(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  throw new Error(`${path} is there already: nothing was written`);
}

/** A heap snapshot at path, myna's heap profile (heap_cli.go:23). */
export async function writeDaemonHeapSnapshot(path: string): Promise<{
  path: string;
  bytes: number;
}> {
  await refuseExisting(path);
  const written = writeHeapSnapshot(path);
  return { path: written, bytes: (await stat(written)).size };
}

/** How long a CPU profile samples when the caller names no time. */
const DEFAULT_CPU_SECONDS = 10;

interface InspectorReply {
  profile?: unknown;
}

/**
 * Samples the daemon's CPU through the inspector and writes the profile,
 * myna's cpu profile (cpu_cli.go:27). The event loop keeps running while it
 * samples, as a Go CPU profile does.
 */
export async function writeDaemonCpuProfile(
  path: string,
  seconds: number = DEFAULT_CPU_SECONDS,
): Promise<{ path: string; bytes: number; seconds: number }> {
  await refuseExisting(path);
  const session = new Session();
  session.connect();
  const post = (method: string): Promise<InspectorReply> =>
    new Promise((resolve, reject) => {
      session.post(method, (error, reply: unknown) => {
        if (error !== null) {
          reject(new Error(error.message));
          return;
        }
        resolve((reply ?? {}) as InspectorReply);
      });
    });
  try {
    await post("Profiler.enable");
    await post("Profiler.start");
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    const reply = await post("Profiler.stop");
    await writeFile(path, JSON.stringify(reply.profile ?? reply));
  } finally {
    session.disconnect();
  }
  return { path, bytes: (await stat(path)).size, seconds };
}

interface HandleLike {
  constructor?: { name?: string };
}

function handleName(value: unknown): string {
  const name = (value as HandleLike | null)?.constructor?.name;
  return name === undefined || name === "" ? typeof value : name;
}

/**
 * The daemon's active handles and requests, myna's goroutine dump
 * (goroutines_cli.go:25): Node's equivalent of goroutines is what keeps the
 * loop alive and what it is waiting on.
 */
export async function writeDaemonHandlesDump(path: string): Promise<{
  path: string;
  bytes: number;
}> {
  await refuseExisting(path);
  const processWithHandles = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const body = {
    program: "neolix",
    uptimeSeconds: Math.round(process.uptime()),
    pid: process.pid,
    resources: process.getActiveResourcesInfo(),
    handles: (processWithHandles._getActiveHandles?.() ?? []).map(handleName),
    requests: (processWithHandles._getActiveRequests?.() ?? []).map(handleName),
  };
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
  return { path, bytes: (await stat(path)).size };
}
