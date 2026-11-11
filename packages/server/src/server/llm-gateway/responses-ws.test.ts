import { createServer, IncomingMessage, type Server } from "node:http";
import { Duplex } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";
import express from "express";
import pino from "pino";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { ResponsesSockets, responsesSocketInternals } from "./responses-ws.js";
import { createGatewayRuntime } from "./runtime.js";
import { SearchLedger } from "./search.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });

interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const openServers: Server[] = [];
const openClients: SocketClient[] = [];

afterEach(async () => {
  for (const client of openClients.splice(0)) {
    client.close();
  }
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function listen(
  app: express.Express,
): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    openServers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const userHi = `{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}`;
const userMore = `{"type":"message","role":"user","content":[{"type":"input_text","text":"and more"}]}`;

function create(prev: string, input: string, extra = ""): string {
  let frame = `{"type":"response.create","model":"fake/m1","stream":true,"store":false,"instructions":"be brief","input":[${input}]`;
  if (prev !== "") {
    frame += `,"previous_response_id":"${prev}"`;
  }
  if (extra !== "") {
    frame += `,${extra}`;
  }
  return `${frame}}`;
}

const TERMINAL = ["response.completed", "response.failed", "response.incomplete", "error"];

interface Frame {
  type?: string;
  [key: string]: unknown;
}

class SocketClient {
  private readonly frames: Frame[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private code = 0;
  private failure: Error | null = null;
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      this.frames.push(JSON.parse(data.toString()) as Frame);
      this.wake?.();
    });
    socket.on("close", (code) => {
      this.closed = true;
      this.code = code;
      this.wake?.();
    });
    socket.on("error", (error) => {
      this.failure = error;
      this.closed = true;
      this.wake?.();
    });
  }

  public static async dial(
    url: string,
    headers: Record<string, string> = {},
    localAddress?: string,
  ): Promise<SocketClient> {
    const socket = new WebSocket(url, { headers, ...(localAddress ? { localAddress } : {}) });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`refused ${response.statusCode}`));
      });
      socket.once("error", (error) => reject(error));
    });
    const client = new SocketClient(socket);
    openClients.push(client);
    return client;
  }

  public send(frame: string): void {
    this.socket.send(frame);
  }

  public async until(kinds: string[]): Promise<{ frames: Frame[]; closeCode: number | null }> {
    const got: Frame[] = [];
    for (;;) {
      const frame = this.frames.shift();
      if (frame !== undefined) {
        got.push(frame);
        if (kinds.includes(String(frame.type))) {
          return { frames: got, closeCode: null };
        }
        continue;
      }
      if (this.closed) {
        if (this.failure !== null && this.code === 0) {
          throw this.failure;
        }
        return { frames: got, closeCode: this.code };
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  public async turn(frame: string): Promise<Frame[]> {
    this.send(frame);
    const result = await this.until(TERMINAL);
    if (result.closeCode !== null) {
      throw new Error(
        `the socket closed (${result.closeCode}) after ${JSON.stringify(result.frames)}`,
      );
    }
    return result.frames;
  }

  public async closes(): Promise<number> {
    const result = await this.until([]);
    return result.closeCode ?? 0;
  }

  public close(): void {
    this.socket.close();
  }
}

interface Upstream {
  url: string;
  requests: RecordedRequest[];
}

function streamLongReply(res: express.Response, req: express.Request, onClose: () => void): void {
  res.setHeader("content-type", "text/event-stream");
  res.write(
    `data: {"type":"response.created","response":{"id":"resp_long","object":"response","status":"in_progress","output":[]}}\n\n`,
  );
  res.write(
    `data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_long","delta":"wor"}\n\n`,
  );
  res.flush?.();
  req.on("close", onClose);
}

function startUpstream(
  reply?: (count: number, res: express.Response, req: express.Request) => boolean,
): Promise<Upstream> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json({ limit: "64mb" }));
  app.post("/v1/responses", (req, res) => {
    requests.push({
      url: req.originalUrl,
      headers: req.headers,
      body: req.body as Record<string, unknown>,
    });
    if (reply !== undefined && reply(requests.length, res, req)) {
      return;
    }
    const count = requests.length;
    const id = `resp_up${count}`;
    const item = `{"type":"message","id":"msg_${count}","role":"assistant","status":"completed","content":[{"type":"output_text","text":"answer ${count}"}]}`;
    res.setHeader("content-type", "text/event-stream");
    res.end(
      `data: {"type":"response.created","response":{"id":"${id}","object":"response","status":"in_progress","output":[]}}\n\n` +
        `data: {"type":"response.output_item.done","output_index":0,"item":${item}}\n\n` +
        `data: {"type":"response.completed","response":{"id":"${id}","object":"response","status":"completed","output":[${item}],"usage":{"input_tokens":300,"output_tokens":50,"total_tokens":350}}}\n\n`,
    );
  });
  return listen(app).then(({ url }) => ({ url, requests }));
}

interface Gateway {
  url: string;
  responses: ResponsesSockets;
  store: GatewayConfigStore;
  neolixHome: string;
}

async function startGateway(
  upstream: Upstream,
  overrides: Partial<GatewayConfig> = {},
): Promise<Gateway> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-responses-ws-"));
  const config: GatewayConfig = {
    ...EMPTY_GATEWAY_CONFIG,
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "fake",
        protocol: "openai-responses",
        baseUrl: `${upstream.url}/v1`,
        apiKey: "upstream-key",
        models: [{ id: "m1" }],
      },
    ],
    groups: [],
    ...overrides,
  };
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  const masker = new Masker({
    neolixHome,
    logger,
    allow: () => [],
    actions: () => ({}),
    shape: () => false,
    categorySwitches: () => ({}),
  });
  await masker.ensureKey();
  const ledger = new UsageLedger({ neolixHome, logger });
  const searchLedger = new SearchLedger({ neolixHome, logger });
  await searchLedger.start();
  const runtime = createGatewayRuntime(ledger);
  const app = express();
  app.use(
    createGatewayRouter({ configStore: store, masker, ledger, logger, searchLedger, runtime }),
  );
  return new Promise((resolve) => {
    const server = createServer(app);
    openServers.push(server);
    const responses = new ResponsesSockets({
      configStore: store,
      logger,
      dispatch: (request, response) => {
        (app as unknown as { handle: (req: typeof request, res: typeof response) => void }).handle(
          request,
          response,
        );
      },
    });
    server.on("upgrade", (request, socket, head) => {
      responses.handleUpgrade(request, socket, head);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `ws://127.0.0.1:${address.port}`, responses, store, neolixHome });
    });
  });
}

function last(frames: Frame[]): Frame {
  return frames[frames.length - 1]!;
}

describe("responses over a WebSocket", () => {
  it("continues a conversation the socket holds, sending the whole upstream", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    for (const pathname of ["/v1/responses", "/responses"]) {
      const client = await SocketClient.dial(`${gateway.url}${pathname}`);
      const first = await client.turn(create("", userHi));
      expect(first[0]?.type).toBe("response.created");
      expect(last(first).type).toBe("response.completed");
      const id = String((last(first).response as Record<string, unknown>).id);
      expect(id).not.toBe("");
      expect(first.some((frame) => frame.type === "response.output_item.done")).toBe(true);

      const second = await client.turn(create(id, userMore));
      expect(last(second).type).toBe("response.completed");
      const body = upstream.requests[1]!.body;
      const input = body.input as Array<Record<string, unknown>>;
      expect(input).toHaveLength(3);
      expect(((input[0]!.content as Array<{ text: string }>)[0] ?? {}).text).toBe("hi");
      expect(input[1]!.role).toBe("assistant");
      expect(((input[1]!.content as Array<{ text: string }>)[0] ?? {}).text).toBe("answer 1");
      expect(((input[2]!.content as Array<{ text: string }>)[0] ?? {}).text).toBe("and more");
      expect(body).not.toHaveProperty("type");
      expect(body).not.toHaveProperty("previous_response_id");
      expect(body).not.toHaveProperty("generate");
      expect(body.instructions).toBe("be brief");

      const secondId = String((last(second).response as Record<string, unknown>).id);
      const third = await client.turn(create(secondId, userHi));
      expect(last(third).type).toBe("response.completed");
      expect((upstream.requests[2]!.body.input as unknown[]).length).toBe(5);
      client.close();
    }
  });

  it("still tells a plain GET to POST", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    const response = await fetch(`${gateway.url.replace("ws:", "http:")}/v1/responses`);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("answers an unknown previous_response_id and keeps serving", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    const a = await SocketClient.dial(`${gateway.url}/v1/responses`);
    const first = await a.turn(create("", userHi));
    const held = String((last(first).response as Record<string, unknown>).id);
    const b = await SocketClient.dial(`${gateway.url}/v1/responses`);
    for (const previous of ["resp_never", held]) {
      const frames = await b.turn(create(previous, userMore));
      expect(last(frames).type).toBe("error");
      expect(last(frames).status).toBe(400);
      expect((last(frames).error as Record<string, unknown>).code).toBe(
        "previous_response_not_found",
      );
    }
    expect(upstream.requests).toHaveLength(1);
    expect(last(await b.turn(create("", userHi))).type).toBe("response.completed");
    a.close();
    b.close();
  });

  it("answers a warmup without a provider, and continues from it", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    const client = await SocketClient.dial(`${gateway.url}/v1/responses`);
    const warmup = await client.turn(create("", userHi, `"generate":false`));
    expect(warmup).toHaveLength(2);
    expect(warmup[0]?.type).toBe("response.created");
    expect(last(warmup).type).toBe("response.completed");
    expect(upstream.requests).toHaveLength(0);
    const id = String((last(warmup).response as Record<string, unknown>).id);
    const frames = await client.turn(create(id, userMore));
    expect(last(frames).type).toBe("response.completed");
    expect(upstream.requests).toHaveLength(1);
    const input = upstream.requests[0]!.body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(((input[0]!.content as Array<{ text: string }>)[0] ?? {}).text).toBe("hi");
    expect(((input[1]!.content as Array<{ text: string }>)[0] ?? {}).text).toBe("and more");
    client.close();
  });

  it("turns a refused turn into an error frame and keeps serving", async () => {
    let failing = true;
    const upstream = await startUpstream((_count, res) => {
      if (!failing) {
        return false;
      }
      res.status(400).setHeader("content-type", "application/json");
      res.end(
        `{"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"too long for this model"}}`,
      );
      return true;
    });
    const gateway = await startGateway(upstream);
    const client = await SocketClient.dial(`${gateway.url}/v1/responses`);
    const frames = await client.turn(create("", userHi));
    expect(last(frames).type).toBe("error");
    expect(last(frames).status).toBe(400);
    expect(String((last(frames).error as Record<string, unknown>).message)).toContain("too long");
    failing = false;
    expect(last(await client.turn(create("", userHi))).type).toBe("response.completed");
    client.close();
  });

  it("interrupts the reply in flight, and refuses an id no turn gave", async () => {
    let gone = false;
    let goneResolve: () => void = () => undefined;
    const goneSeen = new Promise<void>((resolve) => {
      goneResolve = resolve;
    });
    const onUpstreamClose = (): void => {
      gone = true;
      goneResolve();
    };
    const upstream = await startUpstream((count, res, req) => {
      if (count !== 1) {
        return false;
      }
      streamLongReply(res, req, onUpstreamClose);
      return true;
    });
    const gateway = await startGateway(upstream);
    const client = await SocketClient.dial(`${gateway.url}/v1/responses`);
    client.send(create("", userHi));
    const created = await client.until(["response.created"]);
    expect((last(created.frames).response as Record<string, unknown>).id).toBe("resp_long");
    client.send(
      `{"type":"response.interrupt","response_id":"resp_other","mode":"discard_partial_items"}`,
    );
    const failed = await client.until(["response.interrupt.failed"]);
    expect(last(failed.frames).response_id).toBe("resp_other");
    client.send(
      `{"type":"response.interrupt","response_id":"resp_long","mode":"discard_partial_items"}`,
    );
    const interrupted = await client.until(["response.incomplete"]);
    expect(
      interrupted.frames.some(
        (frame) =>
          frame.type === "response.interrupt.accepted" && frame.response_id === "resp_long",
      ),
    ).toBe(true);
    expect(
      (last(interrupted.frames).response as Record<string, unknown>).incomplete_details,
    ).toEqual({
      reason: "interrupted",
    });
    await goneSeen;
    expect(gone).toBe(true);
    expect(last(await client.turn(create("", userHi))).type).toBe("response.completed");
    client.close();
  });

  it("closes going away on drain and refuses the next socket", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    const client = await SocketClient.dial(`${gateway.url}/v1/responses`);
    expect(last(await client.turn(create("", userHi))).type).toBe("response.completed");
    const closed = client.closes();
    await gateway.responses.drain();
    expect(await closed).toBe(1001);
    await expect(SocketClient.dial(`${gateway.url}/v1/responses`)).rejects.toThrow("refused 503");
  });

  it("judges a socket's opener as an HTTP request would", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream);
    // Refusals are answered before the upgrade, on the socket itself, as an
    // HTTP reply would be; a fake connection names any address and origin.
    const refusal = (remoteAddress: string, headers: Record<string, string>): string => {
      const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
          callback();
        },
      }) as Duplex & {
        remoteAddress: string;
        remotePort: number;
        localAddress: string;
        localPort: number;
      };
      socket.remoteAddress = remoteAddress;
      socket.remotePort = 5000;
      socket.localAddress = "127.0.0.1";
      socket.localPort = 6767;
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.end = ((chunk?: string) => {
        if (chunk !== undefined) {
          chunks.push(Buffer.from(chunk));
        }
        return socket;
      }) as typeof socket.end;
      const request = new IncomingMessage(socket);
      request.method = "GET";
      request.url = "/v1/responses";
      request.httpVersion = "1.1";
      request.headers = { ...headers, upgrade: "websocket", connection: "Upgrade" };
      gateway.responses.handleUpgrade(request, socket, Buffer.alloc(0));
      return Buffer.concat(chunks).toString("utf8");
    };
    expect(refusal("198.51.100.7", {})).toContain("HTTP/1.1 401");
    expect(refusal("198.51.100.7", { authorization: "Bearer wrong" })).toContain("HTTP/1.1 401");
    for (const origin of ["https://evil.example", "null", "http://evil.localhost:3425"]) {
      expect(refusal("127.0.0.1", { origin })).toContain("HTTP/1.1 403");
    }
    expect(upstream.requests).toHaveLength(0);
  });

  it("judges every turn as an HTTP request would, and a revoked key ends the next", async () => {
    const upstream = await startUpstream();
    const gateway = await startGateway(upstream, { keys: ["secret", "other"] });
    const client = await SocketClient.dial(`${gateway.url}/v1/responses`, {
      authorization: "Bearer secret",
    });
    const first = await client.turn(create("", userHi));
    expect(last(first).type).toBe("response.completed");

    await gateway.store.write({
      version: 1,
      enabled: true,
      keys: ["other"],
      providers: [
        {
          id: "fake",
          protocol: "openai-responses",
          baseUrl: `${upstream.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "m1" }],
        },
      ],
      groups: [],
    });
    const next = await client.turn(create("", userMore));
    expect(last(next).type).toBe("error");
    expect(last(next).status).toBe(401);
    expect(upstream.requests).toHaveLength(1);
    client.close();
  });

  it("sends the turn state and the lite flag from client_metadata, and drops the socket's beta", () => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const origin = new IncomingMessage(socket);
    origin.headers = {
      host: "127.0.0.1:6767",
      "openai-beta": "responses_websockets=2026-02-06",
      authorization: "Bearer secret",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "abc",
      "content-type": "application/json",
    };
    const body = Buffer.from(
      JSON.stringify({
        type: "response.create",
        input: [],
        client_metadata: {
          "x-codex-turn-state": "ts-prev",
          ws_request_header_x_openai_internal_codex_responses_lite: "true",
        },
      }),
    );
    const headers = responsesSocketInternals.turnHeaders(origin, body);
    expect(headers["x-codex-turn-state"]).toBe("ts-prev");
    expect(headers["x-openai-internal-codex-responses-lite"]).toBe("true");
    expect(headers["openai-beta"]).toBeUndefined();
    expect(headers["sec-websocket-key"]).toBeUndefined();
    expect(headers["upgrade"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["content-length"]).toBe(String(body.byteLength));
  });
});
