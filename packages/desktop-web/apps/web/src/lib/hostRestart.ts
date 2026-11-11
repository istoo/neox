// FILE: hostRestart.ts
// Purpose: Wait for the daemon that a Settings restart replaces, so the UI can
//          report the new worker instead of assuming the request landed.
// Layer: Settings model

export interface HostStatusLike {
  readonly serverId: string;
  readonly pid: number;
  readonly version: string | null;
}

export interface HostRestartDeps {
  getStatus: () => Promise<HostStatusLike>;
  restart: () => Promise<unknown>;
  pollMs?: number;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_MS = 250;
const DEFAULT_DEADLINE_MS = 90_000;

/** The bridge reports a dropped connection while the daemon replaces itself. */
export function isDaemonReconnectFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "DAEMON_CONNECTION_LOST" || code === "DAEMON_REQUEST_TIMEOUT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /connection (?:lost|closed)|websocket.*(?:closed|reconnect)|transport reconnect/i.test(
    message,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Restarts the daemon and resolves with the replacement worker. Only a
 * different PID of the same daemon counts as replaced; the request being
 * acknowledged is not enough. A daemon whose identity changes is an error.
 */
export async function restartHostAndAwaitReplacement({
  getStatus,
  restart,
  pollMs = DEFAULT_POLL_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  now = Date.now,
  sleep = defaultSleep,
}: HostRestartDeps): Promise<HostStatusLike> {
  const previous = await getStatus();
  let acknowledged = false;
  try {
    await restart();
    acknowledged = true;
  } catch (error) {
    if (!isDaemonReconnectFailure(error)) throw error;
  }

  const deadline = now() + deadlineMs;
  let lastError: unknown = null;
  while (now() < deadline) {
    try {
      const current = await getStatus();
      if (current.serverId !== previous.serverId) {
        throw new Error("Daemon identity changed during the restart.");
      }
      if (current.pid !== previous.pid) {
        return current;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("identity changed")) throw error;
      if (!isDaemonReconnectFailure(error)) throw error;
      lastError = error;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `The restart was ${acknowledged ? "accepted" : "not confirmed"}, but the replacement daemon did not appear within ${Math.round(
      deadlineMs / 1_000,
    )}s.${lastError ? ` Last error: ${isDaemonReconnectFailure(lastError) ? "connection lost" : String(lastError)}` : ""}`,
  );
}
