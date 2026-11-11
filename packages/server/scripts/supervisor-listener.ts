import type { ChildProcess } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import {
  formatListenTarget,
  parseListenString,
  type ListenTarget,
} from "../src/server/listen-address.js";

/**
 * The supervisor owns the daemon's listening socket so a worker restart never
 * closes the port: connections accepted while no worker serves wait, paused,
 * and go to the next worker as soon as it says it is ready.
 *
 * The handover is myna's `internal/handoff` by another route: it takes the
 * socket from one process to the next. Here the socket never leaves the
 * supervisor — `pauseOnConnect` keeps the request bytes in the kernel until
 * the receiving worker's HTTP server is there to parse them.
 */

/** How many connections wait for a worker before new ones are dropped. */
const MAX_PENDING_CONNECTIONS = 1024;

export const CONNECTION_MESSAGE = "neolix:connection";

export interface SupervisorListener {
  readonly target: ListenTarget;
  readonly address: string;
  /** Send connections to this worker; its HTTP server is already serving. */
  attach(child: ChildProcess): void;
  /** The worker is gone: keep accepting, but hold connections. */
  detach(): void;
  close(): Promise<void>;
}

export async function createSupervisorListener(listen: string): Promise<SupervisorListener> {
  const requested = parseListenString(listen);
  if (requested.type === "socket" && existsSync(requested.path)) {
    unlinkSync(requested.path);
  }
  const server = net.createServer({ pauseOnConnect: true });
  const pending: net.Socket[] = [];
  let worker: ChildProcess | null = null;
  let closed = false;

  const send = (socket: net.Socket): void => {
    const target = worker;
    if (!target || !target.connected) {
      hold(socket);
      return;
    }
    target.send({ type: CONNECTION_MESSAGE }, socket, (error) => {
      if (error) socket.destroy();
    });
  };

  const hold = (socket: net.Socket): void => {
    if (pending.length >= MAX_PENDING_CONNECTIONS) {
      socket.destroy();
      return;
    }
    pending.push(socket);
    socket.once("close", () => {
      const index = pending.indexOf(socket);
      if (index !== -1) pending.splice(index, 1);
    });
  };

  const flush = (): void => {
    if (worker === null) return;
    for (const socket of pending.splice(0)) {
      if (!socket.destroyed) send(socket);
    }
  };

  server.on("connection", (socket) => {
    if (closed) {
      socket.destroy();
      return;
    }
    send(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (requested.type === "tcp") {
      server.listen(requested.port, requested.host);
    } else {
      server.listen(requested.path);
    }
  });

  const address = server.address();
  const target: ListenTarget =
    requested.type === "tcp"
      ? {
          type: "tcp",
          host: requested.host,
          port: typeof address === "object" && address !== null ? address.port : requested.port,
        }
      : requested;

  return {
    target,
    address: formatListenTarget(target) ?? listen,
    attach(child) {
      worker = child;
      flush();
    },
    detach() {
      worker = null;
    },
    async close() {
      closed = true;
      worker = null;
      for (const socket of pending.splice(0)) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
