import { fork, spawn, type ChildProcess } from "child_process";
import path from "node:path";
import {
  createStream as createRotatingFileStream,
  type RotatingFileStream,
} from "rotating-file-stream";
import { signalProcessTree } from "../src/utils/tree-kill.js";
import type { SupervisorListener } from "./supervisor-listener.js";

const WORKER_HEARTBEAT_INTERVAL_MS = 1_000;
const WORKER_TERMINATION_GRACE_MS = 10_000;

interface SupervisorLogFileOptions {
  path: string;
  rotate: {
    maxSize: string;
    maxFiles: number;
  };
}

type WorkerLifecycleMessage =
  | {
      type: "neolix:shutdown";
      reason?: string;
      keepTerminals: boolean;
    }
  | {
      type: "neolix:ready";
      listen: string;
      serverId: string;
    }
  | {
      type: "neolix:restart";
      reason?: string;
      keepTerminals: boolean;
    };

interface SupervisorHeartbeatMessage {
  type: "neolix:supervisor-heartbeat";
}

interface SupervisorGracefulShutdownMessage {
  type: "neolix:graceful-shutdown";
  reason: string;
  keepTerminals: boolean;
}

export type SupervisorLifecycleLog = (message: string, fields?: Record<string, unknown>) => void;

interface SupervisorOptions {
  name: string;
  startupMessage: string;
  resolveWorkerEntry: () => string;
  workerArgs?: string[];
  workerEnv?: NodeJS.ProcessEnv;
  workerExecArgv?: string[];
  resolveWorkerSpawnSpec?: (workerEntry: string) => {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | null;
  onWorkerReady?: (message: { listen: string; serverId: string }) => Promise<void> | void;
  onWorkerExit?: () => Promise<void> | void;
  restartOnCrash?: boolean;
  onSupervisorExit?: () => Promise<void> | void;
  // Closes every terminal the worker left. Runs after a kill-intent restart or stop once the
  // worker has exited (also after a forced kill), before a respawn, and on any supervisor
  // exit except a keep-terminals stop. A crash restart keeps terminals and skips it.
  cleanupTerminals?: (log: SupervisorLifecycleLog) => Promise<void>;
  logFile?: SupervisorLogFileOptions;
  // The supervisor's own listening socket; connections go to whichever worker is ready.
  listener?: SupervisorListener;
  // Rebinds when the configured address changed since the last bind; null keeps the
  // current socket. Throwing abandons the restart and leaves the worker serving.
  relisten?: () => Promise<SupervisorListener | null>;
}

export interface SupervisorController {
  requestShutdown(reason: string, options?: { keepTerminals?: boolean }): void;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (typeof code === "number" ? `code ${code}` : "unknown");
}

function parseLifecycleMessage(msg: unknown): WorkerLifecycleMessage | null {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) {
    return null;
  }
  const type = (msg as { type?: unknown }).type;
  if (type === "neolix:shutdown") {
    const { reason, keepTerminals } = msg as { reason?: unknown; keepTerminals?: unknown };
    return {
      type: "neolix:shutdown",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
      keepTerminals: keepTerminals === true,
    };
  }
  if (type === "neolix:ready") {
    const { listen, serverId } = msg as { listen?: unknown; serverId?: unknown };
    if (typeof listen !== "string" || listen.trim().length === 0) {
      return null;
    }
    if (typeof serverId !== "string" || serverId.trim().length === 0) {
      return null;
    }
    return { type: "neolix:ready", listen, serverId };
  }
  if (type === "neolix:restart") {
    const { reason, keepTerminals } = msg as { reason?: unknown; keepTerminals?: unknown };
    return {
      type: "neolix:restart",
      ...(typeof reason === "string" && reason.trim().length > 0 ? { reason } : {}),
      keepTerminals: keepTerminals === true,
    };
  }
  return null;
}

function toRotatingFileStreamSize(size: string): string {
  const trimmed = size.trim();
  const match = trimmed.match(/^(\d+)\s*([bBkKmMgG])?$/);
  if (!match) {
    return trimmed;
  }

  const value = match[1];
  const unit = (match[2] ?? "M").toUpperCase();
  return `${value}${unit}`;
}

// daemon.log is best effort: a full disk or a replaced log path must not take the
// supervisor, and with it the worker, down. A failed stream is dropped and a new one
// is opened on the next write, so logging resumes once the file is writable again.
function createDurableLog(
  options: SupervisorLogFileOptions | undefined,
  reportFailure: (message: string) => void,
) {
  let stream: RotatingFileStream | null = null;
  let failing = false;

  const open = (logFile: SupervisorLogFileOptions): RotatingFileStream => {
    const next = createRotatingFileStream(path.basename(logFile.path), {
      path: path.dirname(logFile.path),
      size: toRotatingFileStreamSize(logFile.rotate.maxSize),
      maxFiles: logFile.rotate.maxFiles,
    });
    next.on("error", (error) => {
      if (stream === next) {
        stream = null;
      }
      if (!failing) {
        failing = true;
        reportFailure(
          `Cannot write ${logFile.path}, will retry on the next log line: ${error.message}`,
        );
      }
    });
    return next;
  };

  return {
    write(chunk: string | Buffer): void {
      if (!options) {
        return;
      }
      stream ??= open(options);
      stream.write(chunk, (error) => {
        if (!error) {
          failing = false;
        }
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!stream) {
          resolve();
          return;
        }
        stream.end(() => resolve());
      });
    },
  };
}

// The program that started the daemon can close its end of stdout or stderr, as
// `neolix daemon run | head -1` does. Drop the output nobody reads and keep supervising
// the worker; daemon.log still records it.
function ignoreClosedOutput(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }
}

export function runSupervisor(options: SupervisorOptions): SupervisorController {
  const restartOnCrash = options.restartOnCrash ?? false;
  const workerArgs = options.workerArgs ?? process.argv.slice(2);
  const workerEnv = options.workerEnv ?? process.env;
  const workerExecArgv = options.workerExecArgv ?? ["--import", "tsx"];
  const resolveWorkerSpawnSpec = options.resolveWorkerSpawnSpec;
  let listener = options.listener;

  let child: ChildProcess | null = null;
  let restarting = false;
  let shuttingDown = false;
  // The resolved terminal decision of the pending restart or stop. It survives the force-kill
  // path, so a hung kill restart still closes terminals before the respawn.
  let pendingKeepTerminals = false;
  let exiting = false;
  let lifecycleFailed = false;
  let publication = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | null = null;
  const durableLog = createDurableLog(options.logFile, (message) => {
    process.stderr.write(`[${options.name}] ${message}\n`);
  });

  const writeDurableChunk = (chunk: string | Buffer): void => {
    durableLog.write(chunk);
  };

  const writeLifecycleLog = (message: string, fields: Record<string, unknown> = {}): void => {
    writeDurableChunk(
      `${JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        pid: process.pid,
        name: options.name,
        msg: message,
        ...fields,
      })}\n`,
    );
  };

  const log = (message: string): void => {
    process.stderr.write(`[${options.name}] ${message}\n`);
    writeLifecycleLog(message);
  };

  const closeLogStream = (): Promise<void> => durableLog.close();

  const runTerminalCleanup = async (when: string): Promise<void> => {
    if (!options.cleanupTerminals) {
      return;
    }
    writeLifecycleLog("Closing terminals", { when });
    try {
      await options.cleanupTerminals(writeLifecycleLog);
      writeLifecycleLog("Terminal cleanup finished", { when });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Terminal cleanup not confirmed (${when}): ${message}`);
    }
  };

  const exitSupervisor = (code: number, exitOptions: { keepTerminals?: boolean } = {}): void => {
    if (exiting) {
      return;
    }
    exiting = true;
    const cleanup =
      exitOptions.keepTerminals === true
        ? Promise.resolve()
        : runTerminalCleanup("supervisor_exit");
    cleanup
      .then(() => options.onSupervisorExit?.())
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`Supervisor exit cleanup failed: ${message}`);
      })
      .then(closeLogStream)
      .then(() => listener?.close())
      .finally(() => {
        process.exit(code);
      });
  };

  const clearForceKillTimer = (): void => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
  };

  const scheduleForceKill = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    clearForceKillTimer();
    forceKillTimer = setTimeout(() => {
      forceKillTimer = null;
      if (child !== currentChild) {
        return;
      }
      writeLifecycleLog(
        "Worker did not exit after graceful shutdown request; forcing process tree kill",
        {
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        },
      );
      void signalProcessTree(currentChild, "SIGKILL").catch((error) => {
        writeLifecycleLog("Failed to force-kill worker process tree", {
          error: error instanceof Error ? error.message : String(error),
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      });
    }, WORKER_TERMINATION_GRACE_MS);
    forceKillTimer.unref();
  };

  const spawnWorker = () => {
    let workerEntry: string;
    try {
      // Resolve at spawn time so restarts pick up current filesystem state.
      workerEntry = options.resolveWorkerEntry();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Failed to resolve worker entry: ${message}`);
      exitSupervisor(1);
      return;
    }

    const spawnSpec = resolveWorkerSpawnSpec?.(workerEntry) ?? null;
    writeLifecycleLog("Spawning worker", { workerEntry });
    if (spawnSpec) {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: spawnSpec.env ?? workerEnv,
      });
    } else {
      child = fork(workerEntry, workerArgs, {
        stdio: ["inherit", "pipe", "pipe", "ipc"],
        env: workerEnv,
        execArgv: workerExecArgv,
      });
    }

    const currentChild = child;
    let reachedReady = false;
    // Serialize endpoint writes with exit/clear before allowing another worker to spawn.
    const heartbeat = setInterval(() => {
      const message: SupervisorHeartbeatMessage = { type: "neolix:supervisor-heartbeat" };
      if (currentChild.connected) {
        currentChild.send?.(message, (error) => {
          if (error) {
            writeLifecycleLog("Worker heartbeat IPC send failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        writeLifecycleLog("Worker heartbeat skipped because IPC channel is disconnected");
      }
    }, WORKER_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();

    child.on("disconnect", () => {
      writeLifecycleLog("Worker IPC channel disconnected");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      writeDurableChunk(chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      writeDurableChunk(chunk);
    });

    child.on("message", (msg: unknown) => {
      const lifecycleMessage = parseLifecycleMessage(msg);
      if (!lifecycleMessage || child !== currentChild) {
        return;
      }

      if (lifecycleMessage.type === "neolix:ready") {
        reachedReady = true;
        // The worker's HTTP server is up and its connection handler installed; from here
        // on a restart never leaves the port unserved.
        listener?.attach(currentChild);
        writeLifecycleLog("Worker ready", { listen: lifecycleMessage.listen });
        publication = publication
          .then(() =>
            options.onWorkerReady?.({
              listen: lifecycleMessage.listen,
              serverId: lifecycleMessage.serverId,
            }),
          )
          .catch((error) => {
            lifecycleFailed = true;
            const message = error instanceof Error ? error.message : String(error);
            log(`Worker ready callback failed: ${message}`);
            requestShutdown("endpoint_publication_failed");
          });
        return;
      }

      if (lifecycleMessage.type === "neolix:shutdown") {
        const reason = lifecycleMessage.reason ?? "worker_requested_shutdown";
        writeLifecycleLog("Worker requested shutdown", {
          reason,
          keepTerminals: lifecycleMessage.keepTerminals,
        });
        requestShutdown(reason, { keepTerminals: lifecycleMessage.keepTerminals });
        return;
      }

      const reason = lifecycleMessage.reason ?? "worker_requested_restart";
      writeLifecycleLog("Worker requested restart", {
        reason,
        keepTerminals: lifecycleMessage.keepTerminals,
      });
      requestRestart(reason, lifecycleMessage.keepTerminals);
    });

    child.on("error", (error) => {
      lifecycleFailed = true;
      log(`Worker spawn failed: ${error.message}`);
      exitSupervisor(1);
    });

    child.on("exit", (code, signal) => {
      clearInterval(heartbeat);
      clearForceKillTimer();
      listener?.detach();
      child = null;
      publication = publication
        .then(() => options.onWorkerExit?.())
        .catch((error) => {
          lifecycleFailed = true;
          log(`Worker exit callback failed: ${String(error)}`);
        });
      void publication.then(() => {
        const exitDescriptor = describeExit(code, signal);
        writeLifecycleLog("Worker exited", { code, signal, exit: exitDescriptor });

        if (lifecycleFailed || (!reachedReady && !shuttingDown)) {
          log(`Worker exited before successful readiness (${exitDescriptor}). Supervisor exiting.`);
          exitSupervisor(1);
          return;
        }

        if (shuttingDown) {
          log(`Worker exited (${exitDescriptor}). Supervisor shutting down.`);
          exitSupervisor(0, { keepTerminals: pendingKeepTerminals });
          return;
        }

        const crashed =
          restartOnCrash &&
          ((code !== 0 && code !== null) || (signal !== null && signal !== "SIGTERM"));

        if (restarting || crashed) {
          const closeTerminals = restarting && !pendingKeepTerminals;
          restarting = false;
          pendingKeepTerminals = false;
          log(
            crashed && !closeTerminals
              ? `Worker crashed (${exitDescriptor}). Restarting worker...`
              : `Worker exited (${exitDescriptor}). Restarting worker...`,
          );
          if (!closeTerminals) {
            spawnWorker();
            return;
          }
          // The replacement daemon must never adopt terminals the user asked to close.
          void runTerminalCleanup("before_respawn").then(() => {
            if (!shuttingDown) {
              spawnWorker();
            }
            return;
          });
          return;
        }

        log(`Worker exited (${exitDescriptor}). Supervisor exiting.`);
        exitSupervisor(typeof code === "number" ? code : 1);
        return;
      });
    });
  };

  const requestWorkerShutdown = (reason: string): void => {
    if (!child) {
      return;
    }
    const currentChild = child;
    const message: SupervisorGracefulShutdownMessage = {
      type: "neolix:graceful-shutdown",
      reason,
      keepTerminals: pendingKeepTerminals,
    };
    writeLifecycleLog("Supervisor requesting graceful worker shutdown", {
      reason,
      keepTerminals: pendingKeepTerminals,
      supervisorPid: process.pid,
      workerPid: currentChild.pid ?? null,
    });
    if (!currentChild.connected) {
      writeLifecycleLog("Graceful worker shutdown IPC unavailable", {
        reason,
        supervisorPid: process.pid,
        workerPid: currentChild.pid ?? null,
      });
      return;
    }
    currentChild.send?.(message, (error) => {
      if (error) {
        writeLifecycleLog("Graceful worker shutdown IPC send failed", {
          error: error instanceof Error ? error.message : String(error),
          reason,
          supervisorPid: process.pid,
          workerPid: currentChild.pid ?? null,
        });
      }
    });
  };

  const requestRestart = (reason: string, keepTerminals: boolean) => {
    if (!child || restarting || shuttingDown) {
      return;
    }
    restarting = true;
    pendingKeepTerminals = keepTerminals;
    // Connections wait for the replacement rather than going to a worker that is closing.
    listener?.detach();
    writeLifecycleLog("Restart requested", { reason, keepTerminals });
    const stoppingChild = child;
    void rebind().then((rebound) => {
      if (!rebound) {
        // The address could not be rebound: leave the running worker serving it.
        restarting = false;
        pendingKeepTerminals = false;
        listener?.attach(stoppingChild);
        return false;
      }
      if (child !== stoppingChild || shuttingDown) {
        return false;
      }
      log(`${reason}. Stopping worker for restart...`);
      requestWorkerShutdown(reason);
      scheduleForceKill(reason);
      return true;
    });
  };

  // A changed daemon.listen needs a socket of its own. A failed bind abandons the
  // restart before the worker is told to stop.
  const rebind = async (): Promise<boolean> => {
    if (!options.relisten) {
      return true;
    }
    try {
      const next = await options.relisten();
      if (next) {
        listener = next;
        writeLifecycleLog("Listening socket changed", { listen: next.address });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeLifecycleLog("Restart abandoned; listening socket unchanged", { error: message });
      log(`Restart abandoned: ${message}`);
      return false;
    }
  };

  const requestShutdown = (reason: string, shutdownOptions: { keepTerminals?: boolean } = {}) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    restarting = false;
    pendingKeepTerminals = shutdownOptions.keepTerminals === true;
    listener?.detach();
    writeLifecycleLog("Supervisor shutdown requested", {
      reason,
      keepTerminals: pendingKeepTerminals,
    });
    log(`${reason}. Stopping worker...`);
    if (!child) {
      void publication.then(() => {
        exitSupervisor(lifecycleFailed ? 1 : 0, { keepTerminals: pendingKeepTerminals });
        return;
      });
      return;
    }
    requestWorkerShutdown(reason);
    scheduleForceKill(reason);
  };

  const forwardSignal = (signal: NodeJS.Signals) => {
    requestShutdown(`supervisor_received_${signal}`);
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.stdout.on("error", ignoreClosedOutput);
  process.stderr.on("error", ignoreClosedOutput);

  process.stdout.write(`[${options.name}] ${options.startupMessage}\n`);
  writeLifecycleLog(options.startupMessage);
  spawnWorker();

  return { requestShutdown };
}
