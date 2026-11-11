import type { PersistedConfig } from "./persisted-config.js";

export const DEFAULT_DAEMON_PORT = 6868;

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

export function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

/** Whether two targets name the same socket. */
export function sameListenTarget(a: ListenTarget, b: ListenTarget): boolean {
  if (a.type === "tcp" || b.type === "tcp") {
    return a.type === "tcp" && b.type === "tcp" && a.host === b.host && a.port === b.port;
  }
  return a.type === b.type && a.path === b.path;
}

/**
 * Where the daemon listens: `NEOLIX_LISTEN`, the persisted `daemon.listen` or
 * port, then the default. Kept apart from config resolution because the
 * supervisor reads it before a worker exists.
 */
export function resolveListenAddress(
  env: NodeJS.ProcessEnv,
  persisted: PersistedConfig,
  cliListen: string | undefined,
): string {
  const fromNetwork = (): string | null => {
    if (persisted.daemon?.port === undefined && persisted.daemon?.lan === undefined) {
      return null;
    }
    const port = persisted.daemon.port ?? DEFAULT_DAEMON_PORT;
    return `${persisted.daemon.lan === true ? "0.0.0.0" : "127.0.0.1"}:${port === 0 ? DEFAULT_DAEMON_PORT : port}`;
  };
  return (
    cliListen ??
    env.NEOLIX_LISTEN ??
    persisted.daemon?.listen ??
    fromNetwork() ??
    `127.0.0.1:${env.PORT ?? DEFAULT_DAEMON_PORT}`
  );
}
