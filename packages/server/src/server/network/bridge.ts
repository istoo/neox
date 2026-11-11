import { createServer, Socket, type Server } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * An HTTP proxy on loopback in front of a SOCKS5 one, as myna's bridge.go
 * does for hosts that speak only http:// proxies (its plugin host's Bun).
 * Neolix's own dispatcher is undici, which is in the same position: a
 * `socks5://` upstream proxy is refused as an unsupported protocol, so a
 * SOCKS proxy the user configured becomes this bridge's address.
 *
 * One bridge is kept per SOCKS address for the daemon's lifetime. A bridge
 * is never placed on the SOCKS proxy's own loopback port, or it would dial
 * itself (myna bridge.go:50-61).
 */
export interface SocksBridge {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  close(): Promise<void>;
}

interface BridgeState {
  server: Server;
  url: string;
  sockets: Set<Socket>;
}

const bridges = new Map<string, Promise<BridgeState>>();

/** The bridge for a SOCKS5 URL, started once per address. */
export async function bridgeForSocks(socksUrl: string): Promise<SocksBridge> {
  const existing = bridges.get(socksUrl);
  if (existing !== undefined) {
    const state = await existing;
    return { url: state.url, close: async () => undefined };
  }
  const started = startBridge(new URL(socksUrl));
  bridges.set(socksUrl, started);
  try {
    const state = await started;
    readyBridges.set(socksUrl, state);
    return {
      url: state.url,
      close: async () => {
        bridges.delete(socksUrl);
        readyBridges.delete(socksUrl);
        await closeBridge(state);
      },
    };
  } catch (error) {
    bridges.delete(socksUrl);
    throw error;
  }
}

/** The bridge's address when one is running, without starting one. */
export async function bridgedSocksUrl(socksUrl: string): Promise<string | null> {
  const existing = bridges.get(socksUrl);
  if (existing === undefined) {
    return null;
  }
  try {
    return (await existing).url;
  } catch {
    return null;
  }
}

/** The URL of a bridge already listening, or null; never starts one. */
export function readyBridgeUrl(socksUrl: string): string | null {
  const state = readyBridges.get(socksUrl);
  return state?.url ?? null;
}

const readyBridges = new Map<string, BridgeState>();

/** For tests: forget every bridge and stop the servers. */
export async function closeAllSocksBridges(): Promise<void> {
  const states = await Promise.allSettled(bridges.values());
  bridges.clear();
  readyBridges.clear();
  for (const result of states) {
    if (result.status === "fulfilled") {
      await closeBridge(result.value);
    }
  }
}

async function closeBridge(state: BridgeState): Promise<void> {
  for (const socket of state.sockets) {
    socket.destroy();
  }
  state.sockets.clear();
  await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

async function startBridge(socks: URL): Promise<BridgeState> {
  for (let tries = 0; tries < 4; tries += 1) {
    const state = await listenOnce(socks);
    if (state !== null) {
      return state;
    }
  }
  throw new Error(`No loopback port apart from the SOCKS proxy's ${socks.host}`);
}

function listenOnce(socks: URL): Promise<BridgeState | null> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      void serve(socket, socks);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      if (carriesToItself(address, socks)) {
        server.close(() => resolve(null));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}`, sockets });
    });
  });
}

/** Whether a bridge at `address` would dial the SOCKS proxy's own port. */
function carriesToItself(address: AddressInfo, socks: URL): boolean {
  const port = socks.port === "" ? "1080" : socks.port;
  if (Number(port) !== address.port) {
    return false;
  }
  const host = socks.hostname;
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    host === "127.0.0.1" ||
    host.startsWith("127.")
  );
}

const MAX_HEADER_BYTES = 64 * 1024;

/** Read one HTTP message's head, leaving the rest in `rest`. */
async function readHead(
  socket: Socket,
  rest: Buffer,
): Promise<{ head: string; rest: Buffer } | null> {
  for (;;) {
    const end = rest.indexOf("\r\n\r\n");
    if (end >= 0) {
      return { head: rest.subarray(0, end).toString("latin1"), rest: rest.subarray(end + 4) };
    }
    if (rest.length > MAX_HEADER_BYTES) {
      return null;
    }
    const chunk = await readSome(socket);
    if (chunk === null) {
      return null;
    }
    rest = Buffer.concat([rest, chunk]);
  }
}

function readSome(socket: Socket): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      socket.off("close", onEnd);
    };
    const onData = (chunk: Buffer): void => {
      cleanup();
      socket.pause();
      resolve(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(null);
    };
    socket.once("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onEnd);
    socket.once("close", onEnd);
    socket.resume();
  });
}

async function serve(client: Socket, socks: URL): Promise<void> {
  client.setTimeout(60_000, () => client.destroy());
  const first = await readHead(client, Buffer.alloc(0));
  if (first === null) {
    client.destroy();
    return;
  }
  const lines = first.head.split("\r\n");
  const requestLine = lines[0] ?? "";
  const [method = "", target = "", version = "HTTP/1.1"] = requestLine.split(" ");
  if (method.toUpperCase() === "CONNECT") {
    await tunnel(client, socks, target, first.rest);
    return;
  }
  await forward(client, socks, method, target, version, lines.slice(1), first.rest);
}

async function tunnel(client: Socket, socks: URL, authority: string, rest: Buffer): Promise<void> {
  try {
    const upstream = await dialSocks(socks, authority);
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (rest.length > 0) {
      // Bytes the client pipelined after its CONNECT (a TLS hello, often).
      upstream.write(rest);
    }
    client.setTimeout(0);
    upstream.setTimeout(0);
    client.pipe(upstream);
    upstream.pipe(client);
    const close = (): void => {
      upstream.destroy();
      client.destroy();
    };
    client.on("close", close);
    upstream.on("close", close);
    client.on("error", close);
    upstream.on("error", close);
  } catch (error) {
    refuse(client, error);
  }
}

async function forward(
  client: Socket,
  socks: URL,
  method: string,
  target: string,
  version: string,
  headers: string[],
  rest: Buffer,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    refuse(client, new Error(`Bad proxy target ${target}`));
    return;
  }
  const authority = url.port === "" ? `${url.hostname}:80` : `${url.hostname}:${url.port}`;
  let upstream: Socket;
  try {
    upstream = await dialSocks(socks, authority);
  } catch (error) {
    refuse(client, error);
    return;
  }
  const kept = headers.filter((line) => {
    const name = line.slice(0, line.indexOf(":")).trim().toLowerCase();
    return name !== "proxy-connection" && name !== "proxy-authorization";
  });
  const body = await readBody(client, headers, rest);
  if (body === null) {
    upstream.destroy();
    client.destroy();
    return;
  }
  const request = `${method} ${url.pathname}${url.search} ${version}\r\n${[
    ...kept.filter((line) => !line.toLowerCase().startsWith("connection:")),
    "Connection: close",
  ].join("\r\n")}\r\n\r\n`;
  upstream.write(request, "latin1");
  upstream.write(body);
  client.setTimeout(0);
  upstream.setTimeout(0);
  upstream.pipe(client);
  upstream.on("end", () => client.end());
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
}

/** The request's body: Content-Length bytes, a chunked body, or nothing. */
async function readBody(
  socket: Socket,
  headerLines: string[],
  rest: Buffer,
): Promise<Buffer | null> {
  const header = (name: string): string => {
    for (const line of headerLines) {
      const separator = line.indexOf(":");
      if (separator >= 0 && line.slice(0, separator).trim().toLowerCase() === name) {
        return line.slice(separator + 1).trim();
      }
    }
    return "";
  };
  const chunked = header("transfer-encoding").toLowerCase().includes("chunked");
  if (chunked) {
    return readUntilChunkedEnd(socket, rest);
  }
  const length = Number(header("content-length"));
  if (!Number.isFinite(length) || length <= 0) {
    return Buffer.alloc(0);
  }
  let body = rest;
  while (body.length < length) {
    const chunk = await readSome(socket);
    if (chunk === null) {
      return null;
    }
    body = Buffer.concat([body, chunk]);
  }
  return body.subarray(0, length);
}

async function readUntilChunkedEnd(socket: Socket, rest: Buffer): Promise<Buffer | null> {
  let body = rest;
  for (;;) {
    // A zero-length chunk ends the body: "0\r\n" then an optional trailer.
    const match = /(?:^|\r\n)0\r\n(?:[^\r]*\r\n)*\r\n/.exec(body.toString("latin1"));
    if (match !== null) {
      return body.subarray(0, match.index + match[0].length);
    }
    const chunk = await readSome(socket);
    if (chunk === null) {
      return null;
    }
    body = Buffer.concat([body, chunk]);
  }
}

/** Answer a client the SOCKS proxy didn't carry, as Go's transport words it. */
function refuse(socket: Socket, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  socket.end(
    `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\nConnection: close\r\n\r\n${message}`,
  );
}

/**
 * Connect to `address` (host:port) through the SOCKS5 proxy, sending the
 * host by name so the proxy resolves it (myna bridge.go:DialSOCKS).
 */
export async function dialSocks(socks: URL, address: string): Promise<Socket> {
  const proxyHost = socks.hostname;
  const proxyPort = socks.port === "" ? 1080 : Number(socks.port);
  const separator = address.lastIndexOf(":");
  if (separator <= 0) {
    throw new Error(`socks connect tcp ${socks.host}->${address}: missing port`);
  }
  const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
  const port = Number(address.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`socks connect tcp ${socks.host}->${address}: bad port`);
  }
  let socket: Socket;
  try {
    socket = await connectSocket(proxyHost, proxyPort);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`socks connect tcp ${socks.host}->${address}: ${message}`, { cause: error });
  }
  try {
    await handshake(socket, socks, host, port);
    return socket;
  } catch (error) {
    socket.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`socks connect tcp ${socks.host}->${address}: ${message}`, { cause: error });
  }
}

function connectSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      socket.off("error", onError);
      // The handshake reads the socket paused, so the reply's bytes are
      // buffered rather than emitted and lost between reads.
      socket.pause();
      resolve(socket);
    };
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error("timed out connecting to the SOCKS proxy"));
    });
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.connect(port, host);
  });
}

const SOCKS_REPLIES = new Map<number, string>([
  [1, "general SOCKS server failure"],
  [2, "connection not allowed by ruleset"],
  [3, "network unreachable"],
  [4, "host unreachable"],
  [5, "connection refused"],
  [6, "TTL expired"],
  [7, "command not supported"],
  [8, "address type not supported"],
]);

async function handshake(socket: Socket, socks: URL, host: string, port: number): Promise<void> {
  const methods = socks.username === "" && socks.password === "" ? [0] : [0, 2];
  socket.write(Buffer.from([5, methods.length, ...methods]));
  const choice = await readExactly(socket, 2);
  if (choice[0] !== 5) {
    throw new Error("not a SOCKS5 proxy");
  }
  if (choice[1] === 2) {
    const username = decodeURIComponent(socks.username);
    const password = decodeURIComponent(socks.password);
    if (username.length > 255 || password.length > 255) {
      throw new Error("user or password too long");
    }
    const message = Buffer.concat([
      Buffer.from([1, username.length]),
      Buffer.from(username),
      Buffer.from([password.length]),
      Buffer.from(password),
    ]);
    socket.write(message);
    const answer = await readExactly(socket, 2);
    if (answer[1] !== 0) {
      throw new Error("the proxy turned the user and password away");
    }
  } else if (choice[1] !== 0) {
    throw new Error("no authentication method the proxy takes");
  }
  const request: number[] = [5, 1, 0];
  const ip = parseIp(host);
  if (ip !== null) {
    if (ip.length === 4) {
      request.push(1, ...ip);
    } else {
      request.push(4, ...ip);
    }
  } else {
    const name = Buffer.from(host);
    if (name.length > 255) {
      throw new Error("host name too long");
    }
    request.push(3, name.length, ...name);
  }
  request.push((port >> 8) & 0xff, port & 0xff);
  socket.write(Buffer.from(request));
  const reply = await readExactly(socket, 4);
  if (reply[1] !== 0) {
    throw new Error(SOCKS_REPLIES.get(reply[1]) ?? `unknown SOCKS reply ${reply[1]}`);
  }
  let skip: number;
  switch (reply[3]) {
    case 1:
      skip = 4;
      break;
    case 4:
      skip = 16;
      break;
    case 3: {
      const length = await readExactly(socket, 1);
      skip = length[0] ?? 0;
      break;
    }
    default:
      throw new Error(`unknown address type ${reply[3]}`);
  }
  await readExactly(socket, skip + 2);
}

function parseIp(host: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(host)) {
    return null;
  }
  if (host.includes(":")) {
    return null;
  }
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = parts.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? bytes : null;
}

/**
 * Read exactly `length` bytes from a paused socket, leaving anything after
 * them in the socket's buffer (`unshift`) for the next read. Reading with a
 * `data` listener would drop the rest of a chunk, and the SOCKS reply's
 * address and port arrive in the same chunk as its status.
 */
function readExactly(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    socket.pause();
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while ((chunk = socket.read() as Buffer | null) !== null) {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length >= length) {
          break;
        }
      }
      if (buffer.length < length) {
        return;
      }
      cleanup();
      const out = buffer.subarray(0, length);
      const rest = buffer.subarray(length);
      if (rest.length > 0) {
        socket.unshift(rest);
      }
      resolve(out);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("the SOCKS proxy closed the connection"));
    };
    socket.on("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
    onReadable();
  });
}
