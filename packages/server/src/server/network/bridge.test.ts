import { createServer, connect, type Server, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { bridgeForSocks, closeAllSocksBridges, dialSocks } from "./bridge.js";

const servers: Server[] = [];
afterEach(async () => {
  await closeAllSocksBridges();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("missing port");
  }
  return address.port;
}

/** A SOCKS5 proxy that connects where it is asked, with no authentication. */
async function socksServer(): Promise<number> {
  const server = createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" | "open" = "greeting";
    client.on("data", (chunk: Buffer) => {
      if (stage === "open") {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1] ?? 0;
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        stage = "request";
        client.write(Buffer.from([5, 0]));
      }
      if (stage === "request") {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let offset = 4;
        let host: string;
        if (atyp === 1) {
          if (buffer.length < offset + 4 + 2) return;
          host = [...buffer.subarray(offset, offset + 4)].join(".");
          offset += 4;
        } else if (atyp === 3) {
          const length = buffer[offset] ?? 0;
          if (buffer.length < offset + 1 + length + 2) return;
          host = buffer.subarray(offset + 1, offset + 1 + length).toString();
          offset += 1 + length;
        } else {
          client.destroy();
          return;
        }
        const port = buffer.readUInt16BE(offset);
        stage = "open";
        const upstream = connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on("error", () => client.destroy());
      }
    });
  });
  return listen(server);
}

it("bridges a SOCKS5 proxy as an http:// proxy for CONNECT", async () => {
  const socksPort = await socksServer();
  const echoServer = createServer((socket: Socket) => {
    socket.on("data", (data: Buffer) => socket.write(data));
  });
  const echoPort = await listen(echoServer);
  const bridge = await bridgeForSocks(`socks5://127.0.0.1:${socksPort}`);
  expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const client = connect(Number(new URL(bridge.url).port), "127.0.0.1");
  await once(client, "connect");
  client.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
  let received = "";
  client.on("data", (data: Buffer) => {
    received += data.toString();
  });
  await once(client, "data");
  client.write("ping");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toContain("200 Connection established");
  expect(received).toContain("ping");
  client.destroy();
});

it("sends a plain http:// request through the SOCKS proxy", async () => {
  const socksPort = await socksServer();
  const target = createHttpServer((request, response) => {
    response.end(`hello ${request.url}`);
  });
  const targetPort = await listen(target as unknown as Server);
  const bridge = await bridgeForSocks(`socks5://127.0.0.1:${socksPort}`);

  const client = connect(Number(new URL(bridge.url).port), "127.0.0.1");
  await once(client, "connect");
  client.write(
    `GET http://127.0.0.1:${targetPort}/path HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`,
  );
  let received = "";
  client.on("data", (data: Buffer) => {
    received += data.toString();
  });
  await once(client, "end");
  expect(received).toContain("200 OK");
  expect(received).toContain("hello /path");
});

it("dials through SOCKS with the host name sent as it is", async () => {
  const socksPort = await socksServer();
  const target = createServer((socket: Socket) => socket.end("ok"));
  const targetPort = await listen(target);
  const socket = await dialSocks(
    new URL(`socks5://127.0.0.1:${socksPort}`),
    `127.0.0.1:${targetPort}`,
  );
  expect(await once(socket, "data")).toBeDefined();
  socket.destroy();
});

it("refuses a SOCKS proxy that isn't there with the transport's words", async () => {
  const bridge = await bridgeForSocks("socks5://127.0.0.1:1");
  const client = connect(Number(new URL(bridge.url).port), "127.0.0.1");
  await once(client, "connect");
  client.write("CONNECT vendor.invalid:443 HTTP/1.1\r\n\r\n");
  let received = "";
  client.on("data", (data: Buffer) => {
    received += data.toString();
  });
  await once(client, "end");
  expect(received).toContain("502 Bad Gateway");
  expect(received).toContain("socks connect");
});
