import { Buffer } from "node:buffer";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@neolix/client/internal/daemon-client-transport-types";

type SocketEvent = "message" | "close" | "error";
type SocketListener = (...args: unknown[]) => void;
type ClientMessageHandler = (data: unknown, isBinary: boolean) => void;

function normalizeBinaryFrame(data: Uint8Array | ArrayBuffer): Uint8Array {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(data);
}

function frameByteLength(data: string | Uint8Array): number {
  return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The daemon side of the desktop web app's client connection: a `WebSocketLike` whose
 * frames are function calls instead of a socket. It replaces the loopback TCP socket the
 * bridge used to dial, so the same client code runs inside the daemon process without a
 * handshake, a credential file, or a serialization round trip through the kernel.
 *
 * Delivery is asynchronous (a microtask), like a real socket: neither side can re-enter
 * the other synchronously, and a throwing handler cannot unwind into `Session`.
 * `bufferedAmount` counts bytes written by the daemon that have not reached the bridge yet.
 */
export class WebAppSocket {
  readyState = 1;
  bufferedAmount = 0;
  private readonly listeners = new Map<SocketEvent, Set<SocketListener>>();
  private readonly onceListeners = new Map<SocketEvent, Set<SocketListener>>();
  private readonly clientMessageHandlers = new Set<ClientMessageHandler>();
  private readonly clientOpenHandlers = new Set<() => void>();
  private readonly clientCloseHandlers = new Set<(event?: unknown) => void>();
  private readonly clientErrorHandlers = new Set<(event?: unknown) => void>();
  private clientClosed = false;

  /** The daemon → bridge half: bytes the daemon writes arrive at the bridge's model. */
  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    if (this.readyState !== 1) {
      callback?.(new Error("Web app socket is closed"));
      return;
    }
    const frame = typeof data === "string" ? data : normalizeBinaryFrame(data);
    const bytes = frameByteLength(frame);
    this.bufferedAmount += bytes;
    queueMicrotask(() => {
      this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
      let failure: Error | null = null;
      if (this.readyState === 1) {
        for (const handler of this.clientMessageHandlers) {
          try {
            handler(frame, typeof frame !== "string");
          } catch (error) {
            failure = toError(error);
            break;
          }
        }
      }
      if (failure) this.emitClient("error", failure);
      try {
        callback?.(failure ?? undefined);
      } catch {
        // A send callback is the caller's code; a throw there must not escape this microtask.
      }
    });
  }

  /** The bridge → daemon half. Called by the in-process transport for each client frame. */
  receive(data: string | Uint8Array | ArrayBuffer): void {
    if (this.readyState !== 1) return;
    const frame = typeof data === "string" ? data : normalizeBinaryFrame(data);
    const isBinary = typeof data !== "string";
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      for (const listener of this.listeners.get("message") ?? []) {
        try {
          listener(frame, isBinary);
        } catch (error) {
          this.emit("error", toError(error));
          break;
        }
      }
    });
  }

  /** Closes the daemon side; the bridge sees a close event as if the socket dropped. */
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emitClient("close", { code, reason });
      this.emit("close", code, reason);
    });
  }

  terminate(): void {
    this.close(1006, "Terminated");
  }

  on(event: SocketEvent, listener: SocketListener): void {
    const listeners = this.listeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  once(event: "close" | "error", listener: SocketListener): void {
    const listeners = this.onceListeners.get(event) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.onceListeners.set(event, listeners);
  }

  /** The client side of this socket, handed to `DaemonClient` as its transport. */
  daemonTransport(): DaemonTransport {
    return {
      supportsDrain: true,
      send: (data) => {
        if (this.readyState !== 1) {
          throw new Error(`Web app socket not open (readyState=${this.readyState})`);
        }
        this.receive(data);
      },
      close: (code?: number, reason?: string) => this.closeFromClient(code, reason),
      onMessage: (handler) => {
        this.clientMessageHandlers.add(handler);
        return () => this.clientMessageHandlers.delete(handler);
      },
      onOpen: (handler) => {
        this.clientOpenHandlers.add(handler);
        return () => this.clientOpenHandlers.delete(handler);
      },
      onClose: (handler) => {
        this.clientCloseHandlers.add(handler);
        return () => this.clientCloseHandlers.delete(handler);
      },
      onError: (handler) => {
        this.clientErrorHandlers.add(handler);
        return () => this.clientErrorHandlers.delete(handler);
      },
    };
  }

  /** The daemon attached this socket to a session; the bridge may connect now. */
  openClient(): void {
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      for (const handler of this.clientOpenHandlers) {
        try {
          handler();
        } catch (error) {
          this.emitClient("error", toError(error));
        }
      }
    });
  }

  /** The daemon refused the socket (shutting down); the bridge sees a failed connection. */
  failClient(error: unknown): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emitClient("error", toError(error));
      this.emitClient("close", { error: toError(error) });
    });
  }

  private closeFromClient(code?: number, reason?: string): void {
    if (this.clientClosed) return;
    this.clientClosed = true;
    queueMicrotask(() => {
      if (this.readyState !== 3) {
        this.readyState = 3;
        this.emit("close", code, reason);
      }
      this.emitClient("close", { code, reason });
    });
  }

  private emit(event: SocketEvent, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(...args);
      } catch {
        // Session listeners are the daemon's own; one failing must not stop the others.
      }
    }
    const once = this.onceListeners.get(event);
    if (!once) return;
    this.onceListeners.delete(event);
    for (const listener of once) {
      try {
        listener(...args);
      } catch {
        // Same isolation as the persistent listeners.
      }
    }
  }

  private emitClient(event: "open" | "close" | "error", ...args: unknown[]): void {
    if (event === "open") {
      for (const handler of this.clientOpenHandlers) {
        try {
          handler();
        } catch {
          // The bridge is a client of the daemon; its handler failures stay on its side.
        }
      }
      return;
    }
    const handlers = event === "close" ? this.clientCloseHandlers : this.clientErrorHandlers;
    for (const handler of handlers) {
      try {
        handler(...args);
      } catch {
        // The bridge is a client of the daemon; its handler failures stay on its side.
      }
    }
  }
}

/**
 * Builds the bridge's transport per connection attempt. Each attempt gets a fresh
 * daemon-side socket, attached through `attach` (the daemon's own WebSocket server), so a
 * reconnect uses a new session exactly as a new TCP socket would.
 */
export function createWebAppTransportFactory(
  attach: (socket: WebAppSocket) => Promise<void>,
): DaemonTransportFactory {
  return () => {
    const socket = new WebAppSocket();
    const transport = socket.daemonTransport();
    void attach(socket).then(
      () => socket.openClient(),
      (error: unknown) => socket.failClient(error),
    );
    return transport;
  };
}
