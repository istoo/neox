import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, close: () => Promise.resolve() });
    });
  });
}

interface Upstream extends TestServer {
  requests: number;
}

function startUpstream(body: string, delayMs = 0): Promise<Upstream> {
  const app = express();
  app.use(express.json());
  let requests = 0;
  app.use((_req, res) => {
    requests += 1;
    const respond = (): void => {
      res.setHeader("content-type", "application/json");
      res.end(body);
    };
    if (delayMs > 0) {
      setTimeout(respond, delayMs);
      return;
    }
    respond();
  });
  return listen(app).then((server) => ({
    ...server,
    get requests() {
      return requests;
    },
  }));
}

interface Gateway extends TestServer {
  neolixHome: string;
}

async function startGateway(config: GatewayConfig): Promise<Gateway> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-gw-interactions-"));
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  const masker = new Masker({ neolixHome, logger, allow: () => [] });
  const ledger = new UsageLedger({ neolixHome, logger });
  const app = express();
  app.use(createGatewayRouter({ configStore: store, masker, ledger, logger }));
  return { ...(await listen(app)), neolixHome };
}

function provider(id: string, url: string, protocol: "anthropic" | "openai" = "anthropic") {
  return {
    id,
    protocol,
    baseUrl: `${url}/v1`,
    apiKey: "key",
    models: [{ id: "m" }],
  } satisfies GatewayConfig["providers"][number];
}

function messageBody(text: string): string {
  return JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function configWith(providers: GatewayConfig["providers"], groups: GatewayConfig["groups"] = []) {
  return { version: 1, enabled: true, keys: [], providers, groups } satisfies GatewayConfig;
}

describe("concurrency", () => {
  it("serves parallel requests and records every one", async () => {
    const upstream = await startUpstream(messageBody("ok"));
    const gateway = await startGateway(configWith([provider("a", upstream.url)]));

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`${gateway.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "a/m", messages: [] }),
        }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = readFileSync(path.join(gateway.neolixHome, "gateway-usage.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(20);
    expect(upstream.requests).toBe(20);
  });
});

/** Streams one chunk, waits, then the rest — long enough to abort mid-stream. */
function startSlowStreamServer(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"index":0,"delta":{"content":"one"}}]}\n\n');
    setTimeout(() => finishSlowStream(res), 300);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function finishSlowStream(res: ServerResponse): void {
  res.write('data: {"choices":[{"index":0,"delta":{"content":"two"}}]}\n\n');
  res.end("data: [DONE]\n\n");
}

describe("client disconnects", () => {
  it("stays usable after a client aborts a stream", async () => {
    const slowUrl = await startSlowStreamServer();

    const gateway = await startGateway(
      configWith(
        [provider("slow", slowUrl, "openai")],
        [{ id: "g", members: ["slow/m"], strategy: "order" }],
      ),
    );

    const controller = new AbortController();
    const streaming = fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "group/g", stream: true, messages: [] }),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 120));
    controller.abort();
    await streaming;

    const stillUp = await fetch(`${gateway.url}/v1/models`);
    expect(stillUp.status).toBe(200);
  });
});

describe("failure boundaries", () => {
  it("answers 502 with the last upstream status when every candidate fails", async () => {
    const first = await startUpstream("{}", 0);
    const gateway = await startGateway(
      configWith(
        [
          { ...provider("a", first.url), baseUrl: "http://127.0.0.1:9/v1" },
          { ...provider("b", first.url), baseUrl: "http://127.0.0.1:9/v1" },
        ],
        [{ id: "g", members: ["a/m", "b/m"], strategy: "order" }],
      ),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "group/g", messages: [] }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { type: "gateway_error" } });
  });

  it("answers 404 for count_tokens when the gateway is disabled", async () => {
    const upstream = await startUpstream("{}");
    const gateway = await startGateway({
      ...configWith([provider("a", upstream.url)]),
      enabled: false,
    });

    const response = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a/m", messages: [] }),
    });

    expect(response.status).toBe(404);
  });
});

describe("conversation stickiness", () => {
  it("keeps a conversation on the upstream that answered it", async () => {
    const first = await startUpstream(messageBody("from-a"));
    const second = await startUpstream(messageBody("from-b"));
    const gateway = await startGateway(
      configWith(
        [provider("a", first.url), provider("b", second.url)],
        [{ id: "g", members: ["a/m", "b/m"], strategy: "rotate", affinity: "session" }],
      ),
    );

    const send = (conversation?: string): Promise<Response> =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(conversation === undefined ? {} : { "x-neolix-conversation": conversation }),
        },
        body: JSON.stringify({ model: "group/g", messages: [] }),
      });

    const firstTurn: unknown = await (await send("conv-1")).json();
    const secondTurn: unknown = await (await send("conv-1")).json();

    expect(firstTurn).toMatchObject({ content: [{ text: "from-a" }] });
    expect(secondTurn).toMatchObject({ content: [{ text: "from-a" }] });
    expect(first.requests).toBe(2);
    expect(second.requests).toBe(0);
  });
});

describe("masking with cross-protocol translation", () => {
  it("masks on the way out and restores on the way back", async () => {
    const secret = ["sk", "interactionsecret000000000000"].join("-");
    const requests: string[] = [];
    const openai = express();
    openai.use(express.json());
    openai.use((req, res) => {
      const serialized = JSON.stringify(req.body);
      requests.push(serialized);
      const placeholder = /\{\{API_KEY_[0-9a-f]{8}\}\}/.exec(serialized)?.[0] ?? "none";
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `echo ${placeholder}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
    const openaiServer = await listen(openai);

    const gateway = await startGateway({
      ...configWith([provider("open", openaiServer.url, "openai")]),
      masking: { enabled: true, allow: [] },
    });

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "open/m",
        max_tokens: 32,
        messages: [{ role: "user", content: `use ${secret}` }],
      }),
    });
    const body: unknown = await response.json();

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain(secret);
    expect(requests[0]).toContain("{{API_KEY_");
    expect(JSON.stringify(body)).toContain(secret);
    expect(JSON.stringify(body)).not.toContain("{{API_KEY_");
  });
});
