import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import net from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import { inheritedListenAddress, inheritListener } from "./inherited-listener.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A worker-side socket, already accepted somewhere else, as the supervisor sends it. */
async function acceptedSocket(): Promise<{
  socket: net.Socket;
  client: net.Socket;
  close: () => Promise<void>;
}> {
  const acceptor = net.createServer({ pauseOnConnect: true });
  await new Promise<void>((resolve) => acceptor.listen(0, "127.0.0.1", resolve));
  const address = acceptor.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  const accepted = new Promise<net.Socket>((resolve) => acceptor.once("connection", resolve));
  const client = net.connect(address.port, "127.0.0.1");
  const socket = await accepted;
  return {
    socket,
    client,
    close: async () => {
      client.destroy();
      await new Promise<void>((resolve) => acceptor.close(() => resolve()));
    },
  };
}

test("serves a connection delivered over IPC", async () => {
  const messages = new EventEmitter();
  const server = createServer((_request, response) => response.end("inherited\n"));
  inheritListener(server, {
    listenTarget: { type: "tcp", host: "127.0.0.1", port: 4567 },
    messages,
  });
  expect(server.listening).toBe(true);
  expect(server.address()).toEqual({ address: "127.0.0.1", family: "IPv4", port: 4567 });

  const { socket, client, close } = await acceptedSocket();
  const answered = new Promise<string>((resolve, reject) => {
    client.on("data", (chunk) => resolve(chunk.toString()));
    client.on("error", reject);
  });
  messages.emit("message", { type: "neolix:connection" }, socket);
  client.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
  expect(await answered).toContain("inherited");
  await close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("close waits for the connections the supervisor handed over", async () => {
  const messages = new EventEmitter();
  const server = createServer((_request, response) => {
    setTimeout(() => response.end("late\n"), 100);
  });
  inheritListener(server, {
    listenTarget: { type: "socket", path: "/tmp/neolix-test.sock" },
    messages,
  });

  const { socket, client, close } = await acceptedSocket();
  messages.emit("message", { type: "neolix:connection" }, socket);
  client.write("GET / HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n");
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  let closedYet = false;
  void closed.then(() => {
    closedYet = true;
    return closedYet;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(closedYet).toBe(false);
  await closed;
  expect(closedYet).toBe(true);
  await close();
});

test("reads the inherited address from the environment", () => {
  vi.stubEnv("NEOLIX_INHERITED_LISTEN", "127.0.0.1:6768");
  expect(inheritedListenAddress()).toBe("127.0.0.1:6768");
  vi.stubEnv("NEOLIX_INHERITED_LISTEN", "");
  expect(inheritedListenAddress()).toBeNull();
});
