import { expect, test } from "vitest";
import { WebSocket, type RawData } from "ws";
import { createTestNeolixDaemon, type TestNeolixDaemon } from "./test-utils/index.js";
import { WSOutboundMessageSchema, type WSOutboundMessage } from "./messages.js";
import { MAX_PHYSICAL_SOCKET_BUFFERED_BYTES } from "./websocket/physical-socket.js";

const LARGE_REQUEST_BYTES = 512 * 1024;
// A pong frame is the padded request id plus a small envelope. Assume up to
// 1 KiB of overhead so the burst on its own stays below the bound.
const PONG_FRAME_BYTES_UPPER_BOUND = LARGE_REQUEST_BYTES + 1024;
const PING_BURST_COUNT =
  Math.ceil(MAX_PHYSICAL_SOCKET_BUFFERED_BYTES / PONG_FRAME_BYTES_UPPER_BOUND) - 1;
// The config-change broadcast must push the queue past the bound in one frame.
const CONFIG_PADDING_BYTES = 2 * 1024 * 1024;
const TEST_TIMEOUT_MS = 30_000;

interface SocketClose {
  code: number;
  reason: string;
}

class ResumedPhysicalSocketSession {
  private replacement: WebSocket | null = null;

  private constructor(
    private readonly daemon: TestNeolixDaemon,
    private readonly original: WebSocket,
  ) {}

  static async launch(): Promise<ResumedPhysicalSocketSession> {
    const daemon = await createTestNeolixDaemon();
    const original = await connectSocket(daemon.port, "stale-physical-socket");
    return new ResumedPhysicalSocketSession(daemon, original);
  }

  async abandonOriginal(): Promise<void> {
    this.original.pause();
  }

  async resumeSameClient(): Promise<void> {
    this.replacement = await connectSocket(this.daemon.port, "stale-physical-socket");
  }

  async overflowOriginalUntilClosed(): Promise<SocketClose> {
    const replacement = this.requireReplacement();
    const originalClose = waitForClose(this.original);

    for (let index = 0; index < PING_BURST_COUNT; index += 1) {
      this.original.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "ping",
            requestId: largeRequestId(index),
            clientSentAt: index,
          },
        }),
      );
    }

    // Session replies stay on the socket that requested them, so the abandoned
    // socket fills its own queue. A config change broadcasts to every socket;
    // the replacement receiving it proves the daemon already evaluated the
    // stale socket's queue and terminated it at the high-water mark.
    const configBroadcast = waitForMessage(
      replacement,
      (message) =>
        message.type === "session" &&
        message.message.type === "status" &&
        message.message.payload.status === "daemon_config_changed",
    );
    this.original.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "set_daemon_config_request",
          requestId: "bound-stale-socket",
          config: { appendSystemPrompt: "x".repeat(CONFIG_PADDING_BYTES) },
        },
      }),
    );
    await configBroadcast;

    // The close is only readable once the socket drains again.
    this.original.resume();
    return originalClose;
  }

  async replacementRoundTrip(): Promise<void> {
    const replacement = this.requireReplacement();
    const requestId = "replacement-still-active";
    await sendAndWait(
      replacement,
      {
        type: "session",
        message: { type: "ping", requestId, clientSentAt: 1 },
      },
      (message) =>
        message.type === "session" &&
        message.message.type === "pong" &&
        message.message.payload.requestId === requestId,
    );
  }

  async close(): Promise<void> {
    this.original.terminate();
    this.replacement?.terminate();
    await this.daemon.close();
  }

  private requireReplacement(): WebSocket {
    if (!this.replacement) throw new Error("Replacement socket is not connected");
    return this.replacement;
  }
}

test(
  "a resumed stale socket is bounded and removed without disrupting its replacement",
  async () => {
    const session = await ResumedPhysicalSocketSession.launch();
    try {
      await session.abandonOriginal();
      await session.resumeSameClient();

      const originalClose = await session.overflowOriginalUntilClosed();

      expect(originalClose).toEqual({ code: 1006, reason: "" });
      await session.replacementRoundTrip();
    } finally {
      await session.close();
    }
  },
  TEST_TIMEOUT_MS,
);

async function connectSocket(port: number, clientId: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(socket);
  await sendAndWait(
    socket,
    {
      type: "hello",
      clientId,
      clientType: "browser",
      protocolVersion: 1,
    },
    (message) =>
      message.type === "session" &&
      message.message.type === "status" &&
      message.message.payload.status === "server_info",
  );
  await sendAndWait(socket, { type: "ping" }, (message) => message.type === "pong");
  return socket;
}

function largeRequestId(index: number): string {
  return `${index}:`.padEnd(LARGE_REQUEST_BYTES, "x");
}

function sendAndWait(
  socket: WebSocket,
  message: unknown,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  const response = waitForMessage(socket, matches);
  socket.send(JSON.stringify(message));
  return response;
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<SocketClose> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for WebSocket to close"));
    }, TEST_TIMEOUT_MS);
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    };
    socket.once("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  matches: (message: WSOutboundMessage) => boolean,
): Promise<WSOutboundMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, TEST_TIMEOUT_MS);
    const onMessage = (data: RawData) => {
      const parsed = WSOutboundMessageSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success || !matches(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message arrived"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}
