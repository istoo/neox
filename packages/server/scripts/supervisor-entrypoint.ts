import { fileURLToPath } from "url";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  acquirePidLock,
  PidLockError,
  releasePidLock,
  startPidLockHeartbeat,
  updatePidLock,
} from "../src/server/pid-lock.js";
import { resolveNeolixHome } from "../src/server/neolix-home.js";
import { daemonLogPath } from "../src/server/daemon-instance.js";
import { PRIVATE_FILE_MODE } from "../src/server/private-files.js";
import { loadPersistedConfig } from "../src/server/persisted-config.js";
import { configurationEnvironment } from "../src/server/config-environment.js";
import {
  parseListenString,
  resolveListenAddress,
  sameListenTarget,
} from "../src/server/listen-address.js";
import { leaveCodexRelay } from "../src/server/llm-gateway/codex-relay.js";
import { reapTerminalWorkers } from "../src/terminal/terminal-worker-reaper.js";
import { runSupervisor } from "./supervisor.js";
import { createSupervisorListener } from "./supervisor-listener.js";
import { resolveSupervisorLogFile } from "./supervisor-log-config.js";

process.title = "Neox Supervisor";

interface DaemonRunnerConfig {
  devMode: boolean;
  workerArgs: string[];
}

function parseConfig(argv: string[]): DaemonRunnerConfig {
  let devMode = false;
  const workerArgs: string[] = [];

  for (const arg of argv) {
    if (arg === "--dev") {
      devMode = true;
      continue;
    }
    if (arg === "--reclaim-stale-pid-lock") {
      throw new Error(
        "--reclaim-stale-pid-lock was removed: stop the existing supervisor before starting another.",
      );
    }
    workerArgs.push(arg);
  }

  return { devMode, workerArgs };
}

function resolveWorkerEntry(): string {
  const candidates = [
    fileURLToPath(new URL("../server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../dist/server/server/daemon-worker.js", import.meta.url)),
    fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url)),
    fileURLToPath(new URL("../../src/server/daemon-worker.ts", import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDevWorkerEntry(): string {
  const candidate = fileURLToPath(new URL("../src/server/daemon-worker.ts", import.meta.url));
  if (!existsSync(candidate)) {
    throw new Error(`Dev worker entry not found: ${candidate}`);
  }
  return candidate;
}

function resolveWorkerExecArgv(workerEntry: string, devMode: boolean): string[] {
  const execArgv = workerEntry.endsWith(".ts") ? ["--import", "tsx"] : [];
  if (!devMode) {
    return execArgv;
  }
  const devArgs = [
    "--heapsnapshot-near-heap-limit=3",
    "--max-old-space-size=3072",
    "--report-on-fatalerror",
    "--report-directory=/tmp/neolix-reports",
  ];
  const inspectArg = process.env.NEOLIX_NODE_INSPECT ?? "--inspect";
  if (inspectArg !== "0" && inspectArg !== "false" && inspectArg !== "off") {
    devArgs.push(inspectArg);
  }
  return [...devArgs, ...execArgv];
}

function resolvePackagedNodeEntrypointRunnerPath(currentScriptPath: string): string | null {
  const packageMarker = `${path.sep}node_modules${path.sep}@neolix${path.sep}server${path.sep}`;
  const markerIndex = currentScriptPath.lastIndexOf(packageMarker);
  if (markerIndex === -1) {
    return null;
  }

  const appRoot = currentScriptPath.slice(0, markerIndex);
  const runnerPath = path.join(appRoot, "dist", "daemon", "node-entrypoint-runner.js");
  return existsSync(runnerPath) ? runnerPath : null;
}

async function bindListener(listen: string, relayStatePath: string) {
  if (parseListenString(listen).type === "tcp") {
    // A relay from an earlier daemon may hold this port until it is told to let go.
    await leaveCodexRelay(relayStatePath).catch(() => false);
  }
  try {
    return await createSupervisorListener(listen);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Daemon cannot listen on ${listen}: ${message}`, { cause: error });
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2));
  const workerEntry = config.devMode ? resolveDevWorkerEntry() : resolveWorkerEntry();
  const workerExecArgv = resolveWorkerExecArgv(workerEntry, config.devMode);
  const workerEnv: NodeJS.ProcessEnv = { ...process.env };
  const packagedNodeEntrypointRunner =
    process.env.ELECTRON_RUN_AS_NODE === "1"
      ? resolvePackagedNodeEntrypointRunnerPath(fileURLToPath(import.meta.url))
      : null;

  const neolixHome = resolveNeolixHome(workerEnv);
  const persistedConfig = loadPersistedConfig(neolixHome);
  const supervisorLogFile = resolveSupervisorLogFile(neolixHome, persistedConfig, workerEnv);

  try {
    await acquirePidLock(neolixHome, null, {
      ownerPid: process.pid,
    });
  } catch (error) {
    if (error instanceof PidLockError) {
      failStartup(error.message, error.message);
    }
    throw error;
  }

  let lockReleased = false;
  let requestSupervisorShutdown: ((reason: string) => void) | null = null;
  const stopLockHeartbeat = startPidLockHeartbeat(neolixHome, {
    ownerPid: process.pid,
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`PID lock heartbeat failed: ${message}\n`);
      if (error instanceof PidLockError) {
        requestSupervisorShutdown?.("pid_lock_ownership_lost");
      }
    },
  });
  const releaseLock = async (): Promise<void> => {
    if (lockReleased) {
      return;
    }
    lockReleased = true;
    stopLockHeartbeat();
    await releasePidLock(neolixHome, {
      ownerPid: process.pid,
    });
  };

  const listenAddress = resolveListenAddress(
    configurationEnvironment(workerEnv),
    persistedConfig,
    undefined,
  );
  const relayStatePath = path.join(neolixHome, "gateway", "codex-relay.json");
  // Windows has no socket handover; there the worker listens as before.
  let listener =
    process.platform === "win32" ? null : await bindListener(listenAddress, relayStatePath);
  if (listener) {
    workerEnv.NEOLIX_INHERITED_LISTEN = listener.address;
  }
  // A worker restart re-reads the configuration. The supervisor's socket follows a
  // changed daemon.listen; a failed bind abandons the restart before the worker stops.
  const relisten =
    listener === null
      ? undefined
      : async () => {
          const nextAddress = resolveListenAddress(
            configurationEnvironment(workerEnv),
            loadPersistedConfig(neolixHome),
            undefined,
          );
          const current = listener;
          if (current && sameListenTarget(current.target, parseListenString(nextAddress))) {
            return null;
          }
          const next = await bindListener(nextAddress, relayStatePath);
          listener = next;
          workerEnv.NEOLIX_INHERITED_LISTEN = next.address;
          await current?.close();
          return next;
        };

  const supervisor = runSupervisor({
    name: "DaemonRunner",
    startupMessage: "Starting daemon worker (IPC restart and crash restart enabled)",
    resolveWorkerEntry: () => workerEntry,
    workerArgs: config.workerArgs,
    workerEnv,
    workerExecArgv,
    resolveWorkerSpawnSpec: packagedNodeEntrypointRunner
      ? (resolvedWorkerEntry) => ({
          command: process.execPath,
          args: [
            packagedNodeEntrypointRunner,
            "node-script",
            resolvedWorkerEntry,
            ...config.workerArgs,
          ],
          env: {
            ...workerEnv,
            ELECTRON_RUN_AS_NODE: "1",
          },
        })
      : undefined,
    listener: listener ?? undefined,
    relisten,
    restartOnCrash: true,
    logFile: supervisorLogFile,
    onWorkerReady: async ({ listen, serverId }) => {
      await updatePidLock(neolixHome, { listen, serverId }, { ownerPid: process.pid });
    },
    onWorkerExit: () =>
      updatePidLock(neolixHome, { listen: null, serverId: null }, { ownerPid: process.pid }),
    onSupervisorExit: releaseLock,
    cleanupTerminals: async (log) => {
      const result = await reapTerminalWorkers({ neolixHome, log });
      log("Terminal worker cleanup result", { ...result });
    },
  });
  requestSupervisorShutdown = supervisor.requestShutdown;
}

// The supervisor opens its log only after config and the PID lock succeed. A background
// launch discards stderr, so earlier failures also go to the log the launcher points at.
function failStartup(detail: string, summary: string): never {
  process.stderr.write(`${detail}\n`);
  try {
    const logPath = daemonLogPath(resolveNeolixHome(process.env));
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify({
        level: "fatal",
        time: new Date().toISOString(),
        pid: process.pid,
        name: "DaemonRunner",
        msg: summary,
      })}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
  } catch {
    // stderr already carries the failure.
  }
  process.exit(1);
}

void main().catch((error) => {
  if (error instanceof Error) failStartup(error.stack ?? error.message, error.message);
  failStartup(String(error), String(error));
});
