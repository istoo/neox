import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { ListenTarget } from "./listen-address.js";

/**
 * A worker that does not own the listening socket: the supervisor keeps it and
 * sends each accepted connection over IPC. `pauseOnConnect` on the supervisor's
 * side leaves the request bytes in the kernel until the HTTP server here has
 * the socket, so a restart between two workers loses nothing.
 *
 * This is the receiving half of myna's `handoff.Take`; the supervisor is the
 * one that keeps the socket instead of passing it between sibling processes.
 */

export const INHERITED_LISTEN_ENV = "NEOLIX_INHERITED_LISTEN";
export const CONNECTION_MESSAGE = "neolix:connection";

export interface InheritedListener {
  readonly listenTarget: ListenTarget;
  /** The sockets this worker served, for logging and tests. */
  readonly connections: ReadonlySet<Socket>;
}

export function inheritedListenAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[INHERITED_LISTEN_ENV];
  return value === undefined || value.trim() === "" ? null : value;
}

export function inheritListener(
  httpServer: Server,
  options: {
    listenTarget: ListenTarget;
    /** Where connection messages arrive; the process IPC channel by default. */
    messages?: Pick<NodeJS.Process, "on">;
  },
): InheritedListener {
  const connections = new Set<Socket>();
  const drained: Array<() => void> = [];
  const originalClose = httpServer.close.bind(httpServer);
  let closing = false;

  const drop = (socket: Socket): void => {
    connections.delete(socket);
    if (closing && connections.size === 0) {
      for (const resume of drained.splice(0)) resume();
    }
  };

  const accept = (socket: Socket): void => {
    if (closing || socket.destroyed) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.once("close", () => drop(socket));
    httpServer.emit("connection", socket);
    // A socket the supervisor paused stays paused until something reads it; the
    // HTTP parser has just subscribed, so start the flow.
    socket.resume();
  };

  const messages = options.messages ?? process;
  messages.on("message", (message: unknown, handle?: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if ((message as { type?: unknown }).type !== CONNECTION_MESSAGE) return;
    if (!isSocket(handle)) {
      return;
    }
    accept(handle);
  });

  // The HTTP server has no listening handle of its own; report the address the
  // supervisor bound and make close() wait for the connections it handed us.
  httpServer.address = () =>
    options.listenTarget.type === "tcp"
      ? { address: options.listenTarget.host, family: "IPv4", port: options.listenTarget.port }
      : options.listenTarget.path;
  Object.defineProperty(httpServer, "listening", { configurable: true, get: () => !closing });

  httpServer.closeAllConnections = () => {
    for (const socket of connections) socket.destroy();
  };

  httpServer.close = (callback?: (err?: Error) => void): Server => {
    closing = true;
    const finish = () => originalClose(callback);
    if (connections.size === 0) {
      finish();
    } else {
      drained.push(finish);
    }
    return httpServer;
  };

  return { listenTarget: options.listenTarget, connections };
}

function isSocket(value: unknown): value is Socket {
  return (
    typeof value === "object" &&
    value !== null &&
    "write" in value &&
    typeof (value as { write?: unknown }).write === "function"
  );
}
