import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGatewayCandidates } from "./catalog.js";
import { saveCodexAccounts } from "./codex-accounts.js";
import { clearCodexLeads } from "./codex-leads.js";
import { clearCopilotAutoPicks } from "./copilot-auto.js";
import { clearCopilotSessions, subscriptionAuth } from "./subscription-auth.js";
import {
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  type CopilotAccount,
  type FactorySubscriptionAccount,
} from "./subscription-store.js";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { exportGatewaySpan } from "./otel.js";
import { GatewayArchive } from "./gateway-archive.js";
import { Masker } from "./masking.js";
import { resetAnthropicShapes } from "./anthropic-shapes.js";
import { createGatewayRouter, type GatewayRouterOptions } from "./routes.js";
import { createGatewayRuntime, type GatewayRuntime } from "./runtime.js";
import { SearchLedger } from "./search.js";
import { buildUpstreamUrl } from "./upstream.js";
import { UsageLedger, type UsageRecord } from "./usage.js";

const logger = pino({ level: "silent" });

interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

interface UpstreamServer extends TestServer {
  requests: RecordedRequest[];
}

const openServers: Server[] = [];

afterEach(async () => {
  clearCodexLeads();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function createConfigStore(config: GatewayConfig): {
  store: GatewayConfigStore;
  neolixHome: string;
} {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-gateway-"));
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  return { store: new GatewayConfigStore({ neolixHome, logger }), neolixHome };
}

interface UpstreamReply {
  status: number;
  body: string;
  contentType?: string;
  headers?: Record<string, string>;
}

function startDynamicUpstream(
  handler: (request: RecordedRequest) => UpstreamReply,
): Promise<UpstreamServer> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    const recorded = { url: req.originalUrl, headers: req.headers, body: req.body };
    requests.push(recorded);
    const reply = handler(recorded);
    res.status(reply.status).setHeader("content-type", reply.contentType ?? "application/json");
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(reply.body);
  });
  return listen(app).then((server) => ({ ...server, requests }));
}

/** Whether the first message the upstream was sent carries thinking. */
function hasThinkingBlock(request: RecordedRequest): boolean {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  const first = messages[0] as { content?: { type?: string }[] } | undefined;
  return (first?.content ?? []).some((block) => block.type === "thinking");
}

function startUpstream(reply: UpstreamReply): Promise<UpstreamServer> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    requests.push({ url: req.originalUrl, headers: req.headers, body: req.body });
    res.status(reply.status).setHeader("content-type", reply.contentType ?? "application/json");
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(reply.body);
  });
  return listen(app).then((server) => ({ ...server, requests }));
}

/** An upstream that answers each request with the next reply, the last one
 * repeating. */
function startReplying(replies: UpstreamReply[]): Promise<UpstreamServer> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    requests.push({ url: req.originalUrl, headers: req.headers, body: req.body });
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    res.status(reply.status).setHeader("content-type", reply.contentType ?? "application/json");
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      res.setHeader(name, value);
    }
    res.end(reply.body);
  });
  return listen(app).then((server) => ({ ...server, requests }));
}

/** A Messages stream that reasons, then has the safety filter stop it. */
const THINKING_THEN_REFUSAL =
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}',
    "",
  ].join("\n") + "\n";

/** A Messages stream that answers with one text block. */
const TEXT_REPLY =
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m2","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n") + "\n";

/** A Messages stream cut off after its first word: no block stop, no
 * message_stop. */
const CUT_REPLY =
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m9","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
    "",
  ].join("\n") + "\n";

/** A Messages stream that ends without saying anything. */
const EMPTY_REPLY =
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m8","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n") + "\n";

/** A Messages stream that answers, then has the safety filter stop it. */
const TEXT_THEN_REFUSAL =
  [
    "event: message_start",
    'data: {"type":"message_start","message":{"id":"m3","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    "",
    "event: content_block_start",
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    "",
    "event: content_block_stop",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":1}}',
    "",
  ].join("\n") + "\n";

interface GatewayServer extends TestServer {
  neolixHome: string;
  store: GatewayConfigStore;
  ledger: UsageLedger;
  runtime: GatewayRuntime;
  archive: GatewayArchive;
}

async function startGateway(
  config: GatewayConfig,
  extra: Partial<GatewayRouterOptions> = {},
): Promise<GatewayServer> {
  const { store, neolixHome } = createConfigStore(config);
  await store.start();
  const masker = new Masker({
    neolixHome,
    logger,
    allow: () => store.get().masking?.allow ?? [],
    actions: () => store.get().masking?.actions ?? {},
    shape: () => store.get().masking?.shape === true,
    categorySwitches: () => store.get().masking?.categorySwitches ?? {},
  });
  await masker.ensureKey();
  const ledger = new UsageLedger({ neolixHome, logger });
  const searchLedger = new SearchLedger({ neolixHome, logger });
  await searchLedger.start();
  const runtime = createGatewayRuntime(ledger);
  const archive = new GatewayArchive({ neolixHome, logger });
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker,
      ledger,
      logger,
      searchLedger,
      runtime,
      neolixHome,
      archive,
      ...extra,
    }),
  );
  return { ...(await listen(app)), neolixHome, store, ledger, runtime, archive };
}

function baseConfig(
  upstream: { url: string },
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "local",
        protocol: "anthropic",
        baseUrl: `${upstream.url}/v1`,
        apiKey: "upstream-key",
        models: [{ id: "model-a" }, { id: "model-b" }],
      },
    ],
    groups: [],
    ...overrides,
  };
}

describe("GET /v1/models", () => {
  it("lists provider models", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/models`);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toEqual(["local/model-a", "local/model-b"]);
  });
});

describe("POST /v1/messages", () => {
  it("forwards to the anthropic upstream and rewrites the model id", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", max_tokens: 16, messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Which provider and member answered (myna's member.go), under Neolix's
    // names and myna's.
    expect(response.headers.get("x-neolix-provider")).toBe("local");
    expect(response.headers.get("x-neolix-model")).toBe("local/model-a");
    expect(response.headers.get("x-magpie-provider")).toBe("local");
    expect(response.headers.get("x-magpie-model")).toBe("local/model-a");
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe("/v1/messages");
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe("upstream-key");
    expect(upstream.requests[0]?.body.model).toBe("model-a");
    expect(upstream.requests[0]?.body.max_tokens).toBe(16);
  });

  it("offers the request and reply bodies to the request's span", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const otel = {
      enabled: true,
      bodies: true,
      endpoint: "http://collector:4318",
      metrics: false,
      sessions: false,
    };
    const gateway = await startGateway(baseConfig(upstream, { otel }));
    // bootstrap wires the ledger's record to the exporter; a test gateway is
    // built without it, so the one line it runs is repeated here.
    gateway.ledger.onRecord = (record) => exportGatewaySpan(otel, record);
    const realFetch = globalThis.fetch;
    const spans: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("http://collector:4318")) {
        spans.push(String(init?.body ?? ""));
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      return realFetch(input, init);
    });
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "local/model-a", max_tokens: 16, messages: [] }),
      });
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      vi.restoreAllMocks();
    }
    const attributes = (
      JSON.parse(spans[0] ?? "{}") as {
        resourceSpans: {
          scopeSpans: {
            spans: { attributes: { key: string; value: { stringValue?: string } }[] }[];
          }[];
        }[];
      }
    ).resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes;
    const of = (key: string): string | undefined =>
      attributes?.find((attribute) => attribute.key === key)?.value.stringValue;
    expect(of("langfuse.observation.input")).toContain("model-a");
    expect(of("langfuse.observation.output")).toBe('{"ok":true}');
  });

  it("streams the upstream body through unchanged", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: 'event: message_start\ndata: {"type":"message_start"}\n\n',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", stream: true }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('event: message_start\ndata: {"type":"message_start"}\n\n');
  });

  it("takes a bare id a routing group goes by, before a provider's", async () => {
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${healthy.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "team", members: ["a/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "team", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(healthy.requests[0]?.body.model).toBe("m");
  });

  it("falls back to the next group member when the first one fails", async () => {
    const failing = await startUpstream({ status: 500, body: '{"error":"boom"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${failing.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "group/g", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(failing.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
  });

  it("hands a refusal after reasoning to the next member in the same stream", async () => {
    const refused = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: THINKING_THEN_REFUSAL,
    });
    const healthy = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: TEXT_REPLY,
    });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${refused.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "group/g",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"thinking_delta"');
    // The refusal itself never reaches the agent: the next member answers.
    expect(body).not.toContain('"stop_reason":"refusal"');
    expect(body).toContain('"text":"hi"');
    // The answer continues after the thinking block the first try sent.
    expect(body).toContain('"index":1');
    expect(refused.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
  });

  it("keeps a refusal once the answer has begun, as the agent's", async () => {
    const refused = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: TEXT_THEN_REFUSAL,
    });
    const healthy = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: TEXT_REPLY,
    });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${refused.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "group/g",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"text":"hi"');
    expect(body).toContain('"stop_reason":"refusal"');
    expect(healthy.requests).toHaveLength(0);
    expect(refused.requests).toHaveLength(1);
  });

  it("asks again when a reply ends without saying anything", async () => {
    const upstream = await startReplying([
      { status: 200, contentType: "text/event-stream", body: EMPTY_REPLY },
      { status: 200, contentType: "text/event-stream", body: TEXT_REPLY },
    ]);
    const config = baseConfig(upstream, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${upstream.url}/v1`, models: [{ id: "m" }] },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "a/m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"content":"hi"');
    expect(body).toContain("[DONE]");
    expect(upstream.requests).toHaveLength(2);
  });

  it("asks a cut reply to go on from what the client already has", async () => {
    const upstream = await startReplying([
      { status: 200, contentType: "text/event-stream", body: CUT_REPLY },
      { status: 200, contentType: "text/event-stream", body: TEXT_REPLY },
    ]);
    const config = baseConfig(upstream, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${upstream.url}/v1`, models: [{ id: "m" }] },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "a/m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"content":"Hel"');
    // The second try answers from the prefill and the reply goes on in the
    // same chat stream.
    expect(body).toContain('"content":"hi"');
    expect(body).toContain("[DONE]");
    expect(upstream.requests).toHaveLength(2);
    const asked = upstream.requests[1]?.body.messages as { role: string; content: unknown }[];
    expect(asked.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hel" }],
    });
  });

  it("keeps a streaming agent alive through a patience pause", async () => {
    const upstream = await startReplying([
      { status: 503, body: '{"error":"overloaded"}' },
      { status: 503, body: '{"error":"overloaded"}' },
      { status: 200, contentType: "text/event-stream", body: TEXT_REPLY },
    ]);
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
          patienceMs: 30_000,
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "a/m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();

    // The second pause is 4s: the agent is told the stream is still there.
    expect(body).toContain(": keepalive");
    expect(body).toContain('"text":"hi"');
  });

  it("does not wait when the group's own patience is off", async () => {
    const a = await startReplying([{ status: 503, body: '{"error":"overloaded"}' }]);
    const b = await startReplying([{ status: 503, body: '{"error":"overloaded"}' }]);
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${a.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${b.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"], patience: 0 }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "group/g", messages: [] }),
    });

    expect(response.status).toBe(502);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it("sends the agent's User-Agent where the provider passes it on", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const provider = {
      id: "a",
      protocol: "anthropic" as const,
      baseUrl: `${upstream.url}/v1`,
      models: [{ id: "m" }],
    };
    const plain = await startGateway(baseConfig(upstream, { providers: [provider] }));
    const passing = await startGateway(
      baseConfig(upstream, { providers: [{ ...provider, passUserAgent: true }] }),
    );
    const ask = (url: string): Promise<Response> =>
      fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "claude-code/2.1.0" },
        body: JSON.stringify({ model: "a/m", messages: [] }),
      });

    await ask(plain.url);
    await ask(passing.url);

    expect(upstream.requests[0]?.headers["user-agent"]).toMatch(/^neolix\/[0-9]/);
    expect(upstream.requests[1]?.headers["user-agent"]).toBe("claude-code/2.1.0");
  });

  it("tells Antigravity's turned-away prompt apart from a quota", async () => {
    const upstream = await startUpstream({
      status: 429,
      body: '{"error":{"message":"Resource has been exhausted"}}',
    });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "gemini",
          baseUrl: `${upstream.url}/v1beta`,
          models: [{ id: "gemini-3-flash" }],
          accounts: [{ id: "ag", agent: "antigravity", subscriptionUser: "someone@example.com" }],
        },
      ],
    });
    const gateway = await startGateway(config);
    mkdirSync(path.join(gateway.neolixHome, "gateway"), { recursive: true });
    writeFileSync(
      path.join(gateway.neolixHome, "gateway", "google-accounts.json"),
      JSON.stringify([
        {
          id: "ag",
          agent: "antigravity",
          user: "someone@example.com",
          plan: "free",
          addedAt: Date.now(),
          lapsed: null,
          accessToken: "google-token",
          refreshToken: "google-refresh",
          expiresAt: Date.now() + 3_600_000,
          project: "project-1",
        },
      ]),
    );

    const response = await fetch(`${gateway.url}/v1beta/models/gemini-3-flash:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "x-anthropic-billing-header: v1" }] },
      }),
    });

    // Not a 429: the SDKs retry that ten times over (myna's codeassist.go).
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { type?: string; message?: string } };
    expect(body.error?.type).toBe("prompt_turned_away");
    expect(body.error?.message).toContain("Antigravity answers this 429");
    expect(upstream.requests).toHaveLength(1);
  });

  it("does not ask a provider's other Antigravity accounts after one was turned away", async () => {
    const refused = await startUpstream({
      status: 429,
      body: '{"error":{"message":"Resource has been exhausted"}}',
    });
    const healthy = await startUpstream({
      status: 200,
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        {
          id: "a",
          protocol: "gemini",
          baseUrl: `${refused.url}/v1beta`,
          models: [{ id: "gemini-3-flash" }],
          accounts: [
            { id: "a1", agent: "antigravity", subscriptionUser: "one@example.com" },
            { id: "a2", agent: "antigravity", subscriptionUser: "two@example.com" },
          ],
        },
        { id: "b", protocol: "gemini", baseUrl: `${healthy.url}/v1beta`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/gemini-3-flash", "b/m"] }],
    });
    const gateway = await startGateway(config);
    mkdirSync(path.join(gateway.neolixHome, "gateway"), { recursive: true });
    const google = ["one@example.com", "two@example.com"].map((user, index) => ({
      id: `a${index + 1}`,
      agent: "antigravity",
      user,
      plan: "free",
      addedAt: Date.now(),
      lapsed: null,
      accessToken: "google-token",
      refreshToken: "google-refresh",
      expiresAt: Date.now() + 3_600_000,
      project: "project-1",
    }));
    writeFileSync(
      path.join(gateway.neolixHome, "gateway", "google-accounts.json"),
      JSON.stringify(google),
    );

    const response = await fetch(`${gateway.url}/v1beta/models/group/g:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "x-anthropic-billing-header: v1" }] },
      }),
    });

    expect(response.status).toBe(200);
    // One account was turned away; its mate carries the same prompt, so it
    // is left unasked and the member after it answers.
    expect(refused.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
  });

  it("asks the last Antigravity mate when no other provider is left", async () => {
    const refused = await startUpstream({
      status: 429,
      body: '{"error":{"message":"Resource has been exhausted"}}',
    });
    const config = baseConfig(refused, {
      providers: [
        {
          id: "a",
          protocol: "gemini",
          baseUrl: `${refused.url}/v1beta`,
          models: [{ id: "gemini-3-flash" }],
          accounts: [
            { id: "a1", agent: "antigravity", subscriptionUser: "one@example.com" },
            { id: "a2", agent: "antigravity", subscriptionUser: "two@example.com" },
          ],
        },
      ],
    });
    const gateway = await startGateway(config);
    mkdirSync(path.join(gateway.neolixHome, "gateway"), { recursive: true });
    const google = ["one@example.com", "two@example.com"].map((user, index) => ({
      id: `a${index + 1}`,
      agent: "antigravity",
      user,
      plan: "free",
      addedAt: Date.now(),
      lapsed: null,
      accessToken: "google-token",
      refreshToken: "google-refresh",
      expiresAt: Date.now() + 3_600_000,
      project: "project-1",
    }));
    writeFileSync(
      path.join(gateway.neolixHome, "gateway", "google-accounts.json"),
      JSON.stringify(google),
    );

    const response = await fetch(`${gateway.url}/v1beta/models/a/gemini-3-flash:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        systemInstruction: { parts: [{ text: "x-anthropic-billing-header: v1" }] },
      }),
    });

    // No provider after this one: its last account is asked before the
    // request ends (myna's matesLast leaves the last one to be tried).
    expect(response.status).toBe(400);
    expect(refused.requests).toHaveLength(2);
  });

  it("skips an Antigravity member that turned the same prompt away lately", async () => {
    const refused = await startUpstream({
      status: 429,
      body: '{"error":{"message":"Resource has been exhausted"}}',
    });
    const healthy = await startUpstream({
      status: 200,
      body: JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }),
    });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        {
          id: "a",
          protocol: "gemini",
          baseUrl: `${refused.url}/v1beta`,
          models: [{ id: "gemini-3-flash" }],
          accounts: [{ id: "ag", agent: "antigravity", subscriptionUser: "someone@example.com" }],
        },
        { id: "b", protocol: "gemini", baseUrl: `${healthy.url}/v1beta`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/gemini-3-flash", "b/m"] }],
    });
    const gateway = await startGateway(config);
    mkdirSync(path.join(gateway.neolixHome, "gateway"), { recursive: true });
    writeFileSync(
      path.join(gateway.neolixHome, "gateway", "google-accounts.json"),
      JSON.stringify([
        {
          id: "ag",
          agent: "antigravity",
          user: "someone@example.com",
          plan: "free",
          addedAt: Date.now(),
          lapsed: null,
          accessToken: "google-token",
          refreshToken: "google-refresh",
          expiresAt: Date.now() + 3_600_000,
          project: "project-1",
        },
      ]),
    );
    const ask = (): Promise<Response> =>
      fetch(`${gateway.url}/v1beta/models/group/g:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          systemInstruction: { parts: [{ text: "x-anthropic-billing-header: v1" }] },
        }),
      });

    expect((await ask()).status).toBe(200);
    // The same prompt, a moment later: Antigravity would only turn it away
    // again, so it isn't asked, and the member after it answers.
    expect((await ask()).status).toBe(200);
    expect(refused.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });

  it("asks a busy provider again after its own patience (myna's patience.go)", async () => {
    const upstream = await startReplying([
      { status: 503, body: '{"error":"overloaded"}' },
      { status: 200, body: '{"ok":true}' },
    ]);
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
          patienceMs: 5_000,
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a/m", messages: [] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream.requests).toHaveLength(2);
  });

  it("does not wait for a provider whose patience is off", async () => {
    const upstream = await startReplying([{ status: 503, body: '{"error":"overloaded"}' }]);
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
          patienceMs: 0,
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "a/m", messages: [] }),
    });

    expect(response.status).toBe(502);
    expect(upstream.requests).toHaveLength(1);
  });

  it("traces the order, the tries and the prompt of a request", async () => {
    const failing = await startUpstream({ status: 500, body: '{"error":"boom"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const upstreamBase = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstreamBase, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${failing.url}/v1`,
          models: [{ id: "m", contextWindow: 100_000 }],
        },
        {
          id: "b",
          protocol: "anthropic",
          baseUrl: `${healthy.url}/v1`,
          models: [{ id: "m", contextWindow: 100_000 }],
        },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "group/g",
        system: "You are helpful.",
        messages: [{ role: "user", content: "hello there" }],
      }),
    });

    expect(response.status).toBe(200);
    const snapshot = gateway.runtime.routeTrace.snapshot();
    expect(snapshot.stats).toEqual({ requests: 1, rerouted: 1, errors: 0, active: 0 });
    const route = snapshot.routes[0];
    expect(route?.group).toBe("g");
    expect(route?.seats.map((seat) => seat.provider)).toEqual(["a", "b"]);
    expect(route?.tries.map((entry) => entry.status)).toEqual([500, 200]);
    expect(route?.prompt?.window).toBe(100_000);
    expect(route?.prompt?.parts.map((part) => part.kind)).toEqual(["system", "messages"]);
    expect(route?.done).toBe(true);
  });

  it("rotates past a failing member and starts the next request with the one that served", async () => {
    const failing = await startUpstream({ status: 500, body: '{"error":"boom"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${failing.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"], strategy: "rotate" }],
    });
    const gateway = await startGateway(config);
    const send = () =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "group/g", messages: [] }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(failing.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });

  it("does not count a failed attempt against least-used and skips it while resting", async () => {
    let flakyCalls = 0;
    const flaky = await startDynamicUpstream(() => {
      flakyCalls += 1;
      return flakyCalls === 1
        ? { status: 200, body: '{"ok":true}' }
        : { status: 500, body: '{"error":"boom"}' };
    });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${flaky.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"], strategy: "least-used" }],
    });
    const gateway = await startGateway(config);
    const send = () =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "group/g", messages: [] }),
      });

    // Counts start tied: `a` serves, then `b` serves because it is less used.
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    // Tied again, `a` is tried and fails; its failure must not become usage.
    expect((await send()).status).toBe(200);
    // `a` is now resting, so it stays behind `b` despite the lower count.
    expect((await send()).status).toBe(200);

    expect(flaky.requests).toHaveLength(2);
    expect(healthy.requests).toHaveLength(3);
  });

  it("fails over to the next account under the same provider", async () => {
    const expired = await startUpstream({ status: 401, body: '{"error":"expired"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${expired.url}/v1`,
          accounts: [
            { id: "one", apiKey: "key-one", baseUrl: `${expired.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${healthy.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "pool/m", messages: [] });

    expect(response.status).toBe(200);
    expect(expired.requests[0]?.headers["x-api-key"]).toBe("key-one");
    expect(healthy.requests[0]?.headers["x-api-key"]).toBe("key-two");
    await gateway.ledger.flush();
    const lines = readFileSync(path.join(gateway.neolixHome, "gateway-usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { ok: boolean; account: string | null });
    expect(lines).toContainEqual(expect.objectContaining({ ok: true, account: "two" }));
  });

  it("ties every provider a call tried to one gateway call id", async () => {
    const failing = await startUpstream({ status: 503, body: '{"error":"overloaded"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${failing.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });
    expect(response.status).toBe(200);

    await gateway.ledger.flush();
    const lines = readFileSync(path.join(gateway.neolixHome, "gateway-usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { gatewayCallId?: string; requestId?: string });
    expect(lines).toHaveLength(2);
    expect(lines[0]?.gatewayCallId).toBeDefined();
    expect(lines[1]?.gatewayCallId).toBe(lines[0]?.gatewayCallId);
    expect(lines[1]?.requestId).not.toBe(lines[0]?.requestId);
  });

  it("keeps a conversation on the account that answered it", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(first, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${first.url}/v1`,
          accounts: [
            { id: "one", apiKey: "key-one", baseUrl: `${first.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${second.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);
    const send = () =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-neolix-conversation": "conv-account",
        },
        body: JSON.stringify({ model: "pool/m", messages: [] }),
      });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(first.requests).toHaveLength(2);
    expect(second.requests).toHaveLength(0);
  });

  it("rejects an unknown model", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope/nope" }),
    });

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it("translates an Anthropic request to an OpenAI-protocol provider", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "chatcmpl-1",
        choices: [
          { index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      }),
    });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "open",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "open/m",
        max_tokens: 32,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });

    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.requests[0]?.body.model).toBe("m");
    expect(upstream.requests[0]?.body.messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

function postMessages(gateway: TestServer, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${gateway.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("routing state", () => {
  it("skips an upstream that just failed instead of retrying it", async () => {
    const dead = await startUpstream({ status: 502, body: '{"error":"down"}' });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        { id: "dead", protocol: "anthropic", baseUrl: `${dead.url}/v1`, models: [{ id: "m" }] },
        { id: "ok", protocol: "anthropic", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["dead/m", "ok/m"], strategy: "order" }],
    });
    const gateway = await startGateway(config);

    await postMessages(gateway, { model: "group/g", messages: [] });
    await postMessages(gateway, { model: "group/g", messages: [] });

    expect(dead.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });
});

describe("POST /v1/messages/count_tokens", () => {
  it("estimates input tokens without calling the upstream", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        messages: [{ role: "user", content: "a".repeat(400) }],
      }),
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ input_tokens: expect.any(Number) });
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects an unknown model", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope/nope", messages: [] }),
    });

    expect(response.status).toBe(404);
  });
});

describe("thinking compatibility", () => {
  it("asks again without a thinking block another conversation signed", async () => {
    const upstream = await startDynamicUpstream((request) =>
      hasThinkingBlock(request)
        ? {
            status: 400,
            body: JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "messages.0.content.0: invalid `signature` in `thinking` block",
              },
            }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 2, output_tokens: 2 },
            }),
          },
    );
    const gateway = await startGateway(baseConfig(upstream));

    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hm", signature: "signed-elsewhere" },
            { type: "text", text: "hi" },
          ],
        },
        { role: "user", content: "again" },
      ],
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    const retried = upstream.requests[1]?.body.messages as { content?: { type?: string }[] }[];
    expect(retried[0]?.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("retries without thinking when the upstream rejects the parameter", async () => {
    const upstream = await startDynamicUpstream((request) => {
      const thinking = request.body.thinking;
      if (thinking !== undefined) {
        return {
          status: 400,
          body: JSON.stringify({ type: "error", error: { message: "thinking unsupported" } }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "adapted" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 2 },
        }),
      };
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await postMessages(gateway, {
      model: "local/model-a",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "hi" }],
    });
    const body: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ content: [{ type: "text", text: "adapted" }] });
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[0]?.body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(upstream.requests[1]?.body.thinking).toBeUndefined();
  });

  it("keeps the account's credential on a retry", async () => {
    const upstream = await startDynamicUpstream((request) =>
      request.body.thinking !== undefined
        ? {
            status: 400,
            body: JSON.stringify({ type: "error", error: { message: "thinking unsupported" } }),
          }
        : {
            status: 200,
            body: JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "retried" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 2, output_tokens: 2 },
            }),
          },
    );
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "local",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "model-a" }],
          accounts: [{ id: "main", apiKey: "account-key" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "local/model-a",
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    // The retry without thinking goes out as the same account, not anonymously.
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe("account-key");
    expect(upstream.requests[1]?.headers["x-api-key"]).toBe("account-key");
  });
});

describe("handler failures", () => {
  it("answers 502 instead of rejecting when a translated upstream body is malformed", async () => {
    const upstream = await startUpstream({ status: 200, body: "not json" });
    const config = baseConfig(upstream, {
      providers: [
        { id: "open", protocol: "openai", baseUrl: `${upstream.url}/v1`, models: [{ id: "m" }] },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "open/m",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { type: "gateway_error" } });
  });
});

describe("usage ledger", () => {
  it("records the tokens the upstream reported for a same-protocol request", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    await postMessages(gateway, { model: "local/model-a", messages: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await gateway.ledger.flush();
    const lines = readFileSync(path.join(gateway.neolixHome, "gateway-usage.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      requested: "local/model-a",
      provider: "local",
      model: "model-a",
      ok: true,
      inputTokens: 7,
      outputTokens: 3,
    });
  });
});

describe("OpenAI Responses endpoint", () => {
  it("translates an Anthropic upstream reply into a Responses body", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", input: "hi", max_output_tokens: 16 }),
    });
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      model: "local/model-a",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
  });
});

describe("Gemini endpoint", () => {
  it("serves generateContent from an Anthropic upstream", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1beta/models/local/model-a:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
    });
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      candidates: [
        { content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
    });
  });

  it("streams streamGenerateContent as Gemini SSE", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(
      `${gateway.url}/v1beta/models/local/model-a:streamGenerateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      },
    );
    const text = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain('"parts":[{"text":"hi"}]');
    expect(text).toContain('"finishReason":"STOP"');
  });
});

describe("config middleware", () => {
  it("routes an alias to the target model and keeps the alias in the reply", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "model-a",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const config = baseConfig(upstream, {
      middleware: { aliases: { fast: "local/model-a" }, overrides: [] },
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "fast", messages: [] });
    const body: unknown = await response.json();

    expect(upstream.requests[0]?.body.model).toBe("model-a");
    expect(body).toMatchObject({ model: "fast" });
  });

  it("applies set and remove overrides to the upstream body", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstream, {
      middleware: {
        aliases: {},
        overrides: [{ model: "local/model-a", set: { temperature: 0.1 }, remove: ["top_p"] }],
      },
    });
    const gateway = await startGateway(config);

    await postMessages(gateway, {
      model: "local/model-a",
      temperature: 0.9,
      top_p: 0.5,
      messages: [],
    });

    expect(upstream.requests[0]?.body.temperature).toBe(0.1);
    expect(upstream.requests[0]?.body.top_p).toBeUndefined();
  });
});

describe("stream shape mismatch", () => {
  it("streams a JSON upstream to a client that asked for a stream", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "whole" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await postMessages(gateway, {
      model: "local/model-a",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"whole"');
    expect(text).toContain("event: message_stop");
  });

  it("returns JSON to a client that did not ask for a stream", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await postMessages(gateway, {
      model: "local/model-a",
      messages: [{ role: "user", content: "hi" }],
    });
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      type: "message",
      content: [{ type: "text", text: "streamed" }],
      stop_reason: "end_turn",
    });
  });
});

describe("masking", () => {
  it("masks the request and restores the placeholder in the reply", async () => {
    const secret = ["sk", "testsecretaaaaaaaaaaaaaaaa"].join("-");
    const upstream = await startDynamicUpstream((request) => {
      const serialized = JSON.stringify(request.body);
      const match = /\{\{API_KEY_[0-9a-f]{8}\}\}/.exec(serialized);
      const placeholder = match?.[0] ?? "none";
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `seen ${placeholder}` }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });
    const config = baseConfig(upstream, { masking: { enabled: true, allow: [] } });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: `use ${secret}` }],
    });
    const body: unknown = await response.json();

    const upstreamBody = JSON.stringify(upstream.requests[0]?.body);
    expect(upstreamBody).not.toContain(secret);
    expect(upstreamBody).toContain("{{API_KEY_");
    expect(JSON.stringify(body)).toContain(secret);
    expect(JSON.stringify(body)).not.toContain("{{API_KEY_");
  });

  it("masks a Gemini-bound request and restores the placeholder in the Anthropic reply", async () => {
    const secret = ["sk", "testsecretbbbbbbbbbbbbbbbb"].join("-");
    const upstream = await startDynamicUpstream((request) => {
      const match = /\{\{API_KEY_[0-9a-f]{8}\}\}/.exec(JSON.stringify(request.body));
      return {
        status: 200,
        body: JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: `seen ${match?.[0] ?? "none"}` }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }),
      };
    });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "local",
          protocol: "gemini",
          baseUrl: `${upstream.url}/v1beta`,
          models: [{ id: "model-a" }],
        },
      ],
      masking: { enabled: true, allow: [] },
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: `use ${secret}` }],
    });
    const body: unknown = await response.json();

    expect(upstream.requests[0]?.url).toBe("/v1beta/models/model-a:generateContent");
    expect(JSON.stringify(upstream.requests[0]?.body)).not.toContain(secret);
    expect(JSON.stringify(body)).toContain(secret);
    expect(JSON.stringify(body)).not.toContain("{{API_KEY_");
  });

  it("sends a warned kind as written", async () => {
    const secret = ["sk", "testsecretcccccccccccccccc"].join("-");
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        masking: { enabled: true, allow: [], actions: { API_KEY: "warn" } },
      }),
    );

    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: `use ${secret}` }],
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(upstream.requests[0]?.body)).toContain(secret);
  });

  it("holds a blocked request back before it reaches the upstream", async () => {
    const secret = ["sk", "testsecretdddddddddddddddd"].join("-");
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        masking: { enabled: true, allow: [], actions: { API_KEY: "block" } },
      }),
    );

    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: `use ${secret}` }],
    });
    const body = (await response.json()) as { error?: { type?: string } };

    expect(response.status).toBe(400);
    expect(body.error?.type).toBe("masking_blocked");
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("stream failures", () => {
  it("closes the client stream when the upstream dies mid-stream", async () => {
    const broken = await startBrokenStreamUpstream();
    const config = baseConfig(broken, {
      providers: [
        {
          id: "broken",
          protocol: "openai",
          baseUrl: `${broken.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "broken/m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await response.text();

    expect(text).toContain("message_stop");
  });
});

function startBrokenStreamUpstream(): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n');
      setTimeout(() => res.destroy(), 20);
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

describe("continuation", () => {
  it("asks a reasoning loop again before the reply has spoken", async () => {
    const chunk = (delta: Record<string, unknown>, finish: unknown = null): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    let calls = 0;
    const upstream = await startDynamicUpstream(() => {
      calls += 1;
      if (calls === 1) {
        // The reasoning loops with nothing else said yet.
        return {
          status: 200,
          contentType: "text/event-stream",
          body: chunk({ reasoning_content: "Now.\n" }).repeat(300) + "data: [DONE]\n\n",
        };
      }
      return {
        status: 200,
        contentType: "text/event-stream",
        body:
          chunk({ reasoning_content: "Think." }) +
          chunk({ content: "Done" }) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
      };
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "k",
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const response = await postMessages(gateway, {
      model: "local/m",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await response.text();

    expect(upstream.requests).toHaveLength(2);
    expect(text).toContain("Done");
    expect(text).not.toContain("stuck in a loop");
  });

  it("ends a loop that started after the reply spoke", async () => {
    const chunk = (delta: Record<string, unknown>, finish: unknown = null): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const upstream = await startDynamicUpstream(() => ({
      status: 200,
      contentType: "text/event-stream",
      body:
        chunk({ content: "Here." }) + chunk({ content: "Now.\n" }).repeat(300) + "data: [DONE]\n\n",
    }));
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "k",
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const response = await postMessages(gateway, {
      model: "local/m",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    const text = await response.text();

    expect(upstream.requests).toHaveLength(1);
    expect(text).toContain("stuck in a loop");
  });
});

describe("tool calls across protocols", () => {
  it("turns an OpenAI tool call reply into an Anthropic tool_use block", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: '{"cmd":"ls"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }),
    });
    const config = baseConfig(upstream, {
      providers: [
        { id: "open", protocol: "openai", baseUrl: `${upstream.url}/v1`, models: [{ id: "m" }] },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "open/m",
      max_tokens: 32,
      messages: [{ role: "user", content: "list files" }],
    });
    const body: unknown = await response.json();

    expect(body).toMatchObject({
      type: "message",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } }],
    });
  });
});

describe("Claude Code sign-in errors", () => {
  it("tells a 401 as the provider refusing Neox's credential", async () => {
    const upstream = await startUpstream({
      status: 401,
      body: '{"type":"error","error":{"message":"x-api-key is not valid"}}',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-ant-oat01-not-a-gateway-key",
      },
      body: JSON.stringify({ model: "local/model-a", max_tokens: 16, messages: [] }),
    });

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).toContain("refused Neox's credential (HTTP 401)");
    expect(text).not.toContain("x-api-key");
  });
});

describe("gateway auth", () => {
  it("accepts a bearer token as well as x-api-key", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["secret"] }));

    const response = await fetch(`${gateway.url}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
  });

  it("answers 404 while the gateway is disabled", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { enabled: false }));

    const response = await fetch(`${gateway.url}/v1/models`);
    expect(response.status).toBe(404);
  });

  it("requires a configured key when keys are set", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["secret"] }));

    const denied = await fetch(`${gateway.url}/v1/models`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${gateway.url}/v1/models`, {
      headers: { "x-api-key": "secret" },
    });
    expect(allowed.status).toBe(200);
  });
});

describe("access control and budgets", () => {
  it("refuses a model outside the key's allow-list", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "team", models: ["local/model-b"] }] }),
    );
    const send = (model: string) =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "team" },
        body: JSON.stringify({ model, messages: [] }),
      });

    expect((await send("local/model-a")).status).toBe(403);
    expect((await send("local/model-b")).status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
  });

  it("stops serving once the monthly budget is spent", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        pricing: { "local/model-a": { inputPerMTok: 1_000_000, outputPerMTok: 0 } },
        budget: { monthlyUsd: 0.5 },
      }),
    );
    const send = () => postMessages(gateway, { model: "local/model-a", messages: [] });

    expect((await send()).status).toBe(200);
    const refused = await send();
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: { type: "budget_exceeded" } });
    expect(upstream.requests).toHaveLength(1);
  });

  it("refuses a request the key's window can't hold, with Retry-After", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 0 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "small", dailyTokens: 1 }] }),
    );
    const send = () =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "small" },
        body: JSON.stringify({
          model: "local/model-a",
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    expect((await send()).status).toBe(200);
    const refused = await send();

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await refused.json()).toMatchObject({ error: { type: "quota_exceeded" } });
    expect(upstream.requests).toHaveLength(1);
  });

  it("fails over when an account used up its quota window", async () => {
    const spent = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 4 },
      }),
    });
    const spare = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(spent, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${spent.url}/v1`,
          accounts: [
            {
              id: "main",
              apiKey: "key-main",
              priority: 10,
              quota: { tokens5h: 10 },
              baseUrl: `${spent.url}/v1`,
            },
            { id: "spare", apiKey: "key-spare", baseUrl: `${spare.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);
    const send = () => postMessages(gateway, { model: "pool/m", messages: [] });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(spent.requests).toHaveLength(1);
    expect(spare.requests).toHaveLength(1);
  });
});

describe("subscription sign-ins", () => {
  it("skips an account with no sign-in and tries the next one", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "p",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            accounts: [
              {
                id: "sub",
                agent: "copilot",
                subscriptionUser: "nobody@example.com",
                apiKey: "not-used",
                baseUrl: `${upstream.url}/v1`,
              },
              { id: "plain", apiKey: "key-plain", baseUrl: `${upstream.url}/v1` },
            ],
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const response = await postMessages(gateway, { model: "p/m", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]?.headers["x-api-key"]).toBe("key-plain");
  });
});

describe("middleware hooks", () => {
  it("rejects a request from the request hook", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        middleware: {
          aliases: {},
          overrides: [],
          hooks: {
            request:
              "if (ctx.model === 'local/model-a') return { reject: { status: 418, message: 'nope' } };",
          },
        },
      }),
    );

    const response = await postMessages(gateway, { model: "local/model-a", messages: [] });
    expect(response.status).toBe(418);
    expect(upstream.requests).toHaveLength(0);
  });

  it("releases the key's budget hold when the request hook rejects", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "held", limits: [{ period: "month", tokens: 150, cacheReads: false }] }],
        middleware: {
          aliases: {},
          overrides: [],
          hooks: { request: "return { reject: { status: 403, message: 'not here' } };" },
        },
      }),
    );
    const send = () =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "held" },
        body: JSON.stringify({
          model: "local/model-a",
          max_tokens: 8,
          messages: [{ role: "user", content: "x".repeat(400) }],
        }),
      });

    expect((await send()).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect((await send()).status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("lets the provider hook rewrite the upstream body", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        middleware: {
          aliases: {},
          overrides: [],
          hooks: { provider: "ctx.body.temperature = 0.25;" },
        },
      }),
    );

    expect((await postMessages(gateway, { model: "local/model-a", messages: [] })).status).toBe(
      200,
    );
    expect(upstream.requests[0]?.body.temperature).toBe(0.25);
  });

  it("skips an account without resting it", async () => {
    const skipped = await startUpstream({ status: 200, body: '{"ok":true}' });
    const used = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(used, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${skipped.url}/v1`,
          accounts: [
            { id: "one", apiKey: "key-one", baseUrl: `${skipped.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${used.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
      middleware: {
        aliases: {},
        overrides: [],
        hooks: { account: "if (ctx.account === 'one') return { skip: true };" },
      },
    });
    const gateway = await startGateway(config);

    expect((await postMessages(gateway, { model: "pool/m", messages: [] })).status).toBe(200);
    expect(skipped.requests).toHaveLength(0);
    expect(used.requests).toHaveLength(1);
  });

  it("keeps the request when a hook throws", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        middleware: {
          aliases: {},
          overrides: [],
          hooks: { request: "throw new Error('bad hook')" },
        },
      }),
    );

    expect((await postMessages(gateway, { model: "local/model-a", messages: [] })).status).toBe(
      200,
    );
    expect(upstream.requests).toHaveLength(1);
  });
});

describe("myna parity: credit, sink and read-only", () => {
  it("rests a credit failure on the ladder and skips it next time", async () => {
    const broke = await startUpstream({
      status: 402,
      body: '{"error":"insufficient credit"}',
    });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${broke.url}/v1`,
          accounts: [
            { id: "one", apiKey: "key-one", baseUrl: `${broke.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${healthy.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);
    const send = () => postMessages(gateway, { model: "pool/m", messages: [] });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(broke.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(2);
  });

  it("sinks a 429 that still has allowance instead of resting it", async () => {
    const throttled = await startUpstream({
      status: 429,
      body: '{"error":"slow down"}',
      headers: { "anthropic-ratelimit-tokens-remaining": "100" },
    });
    const healthy = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(healthy, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${throttled.url}/v1`,
          sink: true,
          accounts: [
            { id: "one", apiKey: "key-one", priority: 10, baseUrl: `${throttled.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${healthy.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);
    const send = () => postMessages(gateway, { model: "pool/m", messages: [] });

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);

    expect(throttled.requests).toHaveLength(2);
    expect(healthy.requests).toHaveLength(2);
  });

  it("limits a read-only key to read endpoints", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "read", readOnly: true }] }),
    );

    const models = await fetch(`${gateway.url}/v1/models`, { headers: { "x-api-key": "read" } });
    expect(models.status).toBe(200);

    const completion = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "read" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });
    expect(completion.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("accepts a Gemini-style key header", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["secret"] }));

    const listed = await fetch(`${gateway.url}/v1/models`, {
      headers: { "x-goog-api-key": "secret" },
    });
    expect(listed.status).toBe(200);
  });
});

describe("myna parity: response and event hooks", () => {
  it("rewrites the JSON reply", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({ id: "m", type: "message", content: [] }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        middleware: {
          aliases: {},
          overrides: [],
          hooks: {
            response: "ctx.body.hooked = true; return { body: ctx.body };",
          },
        },
      }),
    );

    const response = await postMessages(gateway, { model: "local/model-a", messages: [] });
    const body: unknown = await response.json();
    expect(body).toMatchObject({ hooked: true });
  });

  it("rewrites a streamed event", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"one"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        middleware: {
          aliases: {},
          overrides: [],
          hooks: {
            event:
              "if (ctx.event.type === 'text_delta') return { event: { type: 'text_delta', text: 'two' } };",
          },
        },
      }),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", stream: true, messages: [] }),
    });
    const text = await response.text();
    expect(text).toContain('"text":"two"');
    expect(text).not.toContain('"text":"one"');
  });
});

describe("myna parity: key issuance", () => {
  it("mints a child key from an issuer key and revokes it", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "root", issues: true, models: ["local/model-a"], dailyTokens: 1000 }],
      }),
    );
    const headers = { "content-type": "application/json", "x-api-key": "root" };

    const created = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "child", models: ["local/model-a"], dailyTokens: 9999 }),
    });
    expect(created.status).toBe(201);
    const payload = (await created.json()) as { key: string; data: { dailyTokens: number } };
    expect(payload.key.startsWith("pk_")).toBe(true);
    expect(payload.data.dailyTokens).toBe(1000);

    const listed = await fetch(`${gateway.url}/v1/myna/keys`, {
      headers: { "x-api-key": "root" },
    });
    const list = (await listed.json()) as { data: Array<{ key: string; label: string }> };
    expect(list.data).toContainEqual(expect.objectContaining({ label: "child" }));
    expect(list.data[0]?.key).not.toContain(payload.key);

    const authorized = await fetch(`${gateway.url}/v1/models`, {
      headers: { "x-api-key": payload.key },
    });
    expect(authorized.status).toBe(200);

    const revoked = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ key: payload.key }),
    });
    expect(revoked.status).toBe(204);
    const after = await fetch(`${gateway.url}/v1/models`, {
      headers: { "x-api-key": payload.key },
    });
    expect(after.status).toBe(401);
  });

  it("refuses a child key whose models match none of its issuer's", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "root", issues: true, models: ["local/model-a"] }] }),
    );

    const response = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "root" },
      body: JSON.stringify({ label: "wider", models: ["local/model-b"] }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        message: "The key issuing may not use local/model-b, so the key it issues can't either",
        type: "invalid_request",
      },
    });

    const listed = (await (
      await fetch(`${gateway.url}/v1/myna/keys`, { headers: { "x-api-key": "root" } })
    ).json()) as { data: Array<{ label: string }> };
    expect(listed.data).toHaveLength(0);
  });

  it("lets an issuer's wildcard cover the child's model", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "root", issues: true, models: ["local/*"] }] }),
    );

    const created = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "root" },
      body: JSON.stringify({ label: "child", models: ["local/model-a"] }),
    });

    expect(created.status).toBe(201);
    const payload = (await created.json()) as { data: { models: string[] } };
    expect(payload.data.models).toEqual(["local/model-a"]);
  });

  it("refuses a child wildcard wider than its issuer", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "root", issues: true, models: ["local/model-a"] }] }),
    );

    const created = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "root" },
      body: JSON.stringify({ label: "child", models: ["local/*"] }),
    });

    expect(created.status).toBe(400);
    expect((await created.json()) as { error: { message: string } }).toMatchObject({
      error: {
        message: "The key issuing may not use local/*, so the key it issues can't either",
      },
    });
  });

  it("folds a child key's models through its issuer on every request", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const child = {
      key: "child",
      label: "child",
      models: [] as string[],
      readOnly: false,
      issues: false,
      issuer: "root",
    };
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "root", issues: true, models: ["local/model-a", "local/model-b"] }, child],
      }),
    );
    const send = (model: string) =>
      fetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "child" },
        body: JSON.stringify({ model, messages: [] }),
      });

    expect((await send("local/model-b")).status).toBe(200);

    await gateway.store.write({
      ...gateway.store.get(),
      keys: [{ key: "root", issues: true, models: ["local/model-a"], readOnly: false }, child],
    });

    expect((await send("local/model-b")).status).toBe(403);
    expect((await send("local/model-a")).status).toBe(200);
  });

  it("refuses a child key whose issuer no longer shares a model", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [
          { key: "root", issues: true, models: ["local/model-a", "local/model-b"] },
          {
            key: "child",
            label: "child",
            models: ["local/model-a"],
            readOnly: false,
            issues: false,
            issuer: "root",
          },
        ],
      }),
    );

    await gateway.store.write({
      ...gateway.store.get(),
      keys: [
        { key: "root", issues: true, models: ["local/model-b"], readOnly: false },
        {
          key: "child",
          label: "child",
          models: ["local/model-a"],
          readOnly: false,
          issues: false,
          issuer: "root",
        },
      ],
    });

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "child" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { message: string } }).toMatchObject({
      error: {
        message:
          'the gateway key "child" may use none of its models now: the key it was issued under no longer lets it',
      },
    });
  });

  it("refuses a child key once its issuer is gone", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [
          { key: "root", issues: true, models: ["local/model-a"] },
          {
            key: "child",
            label: "child",
            models: ["local/model-a"],
            readOnly: false,
            issues: false,
            issuer: "root",
          },
        ],
      }),
    );

    await gateway.store.write({
      ...gateway.store.get(),
      keys: [
        {
          key: "child",
          label: "child",
          models: ["local/model-a"],
          readOnly: false,
          issues: false,
          issuer: "root",
        },
      ],
    });

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "child" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });

    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { message: string } }).toMatchObject({
      error: {
        message:
          'the gateway key "child" was issued under a key that is no longer enabled, so it no longer works',
      },
    });
  });

  it("does not let a child key outlive its issuer", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "root", issues: true, models: ["local/model-a"], expiresAt }],
      }),
    );

    const created = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "root" },
      body: JSON.stringify({ label: "child" }),
    });

    expect(created.status).toBe(201);
    const payload = (await created.json()) as { data: { expiresAt: string } };
    expect(payload.data.expiresAt).toBe(expiresAt);
  });

  it("refuses issuance from a key without the flag", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["plain"] }));
    const response = await fetch(`${gateway.url}/v1/myna/keys`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "plain" },
      body: JSON.stringify({ label: "child" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("raw passthrough endpoints", () => {
  it("forwards embeddings to the provider that serves the model", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: '{"data":[{"embedding":[1,2,3]}],"model":"model-b"}',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-b", input: "hello" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ embedding: [1, 2, 3] }],
      model: "model-b",
    });
    expect(upstream.requests[0]?.url).toBe("/v1/embeddings");
    expect(upstream.requests[0]?.body).toEqual({ model: "model-b", input: "hello" });
  });

  it("holds a raw call to the key's models and pace", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"data":[]}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "team", models: ["local/model-b"], ratePerMinute: 1 }],
      }),
    );
    const send = (model: string) =>
      fetch(`${gateway.url}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "team" },
        body: JSON.stringify({ model, input: "hello" }),
      });

    expect((await send("local/model-a")).status).toBe(403);
    expect(upstream.requests).toHaveLength(0);

    expect((await send("local/model-b")).status).toBe(200);
    expect((await send("local/model-b")).status).toBe(429);
    expect(upstream.requests).toHaveLength(1);
  });

  it("holds a raw call to the key's daily tokens", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"data":[]}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "small", dailyTokens: 1 }] }),
    );
    gateway.ledger.record({
      time: new Date().toISOString(),
      requested: "local/model-a",
      provider: "local",
      account: "default",
      model: "model-a",
      protocol: "anthropic",
      status: 200,
      ok: true,
      inputTokens: 10,
      outputTokens: 10,
      attempts: 1,
      durationMs: 1,
      costUsd: 0,
      key: "small",
    });
    await gateway.ledger.flush();

    const response = await fetch(`${gateway.url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "small" },
      body: JSON.stringify({ model: "local/model-a", input: "hello" }),
    });

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { type: "quota_exceeded" } });
    expect(upstream.requests).toHaveLength(0);
  });

  it("holds the native passthrough to the key's models", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "team", models: ["local/model-a"] }] }),
    );

    const response = await fetch(`${gateway.url}/v1/myna/native/local/anything`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "team" },
      body: JSON.stringify({ model: "local/model-b" }),
    });

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("writes the calling key into a native call's ledger record", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "team", models: ["local/model-a"] }] }),
    );

    const response = await fetch(`${gateway.url}/v1/myna/native/local/anything`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "team" },
      body: JSON.stringify({ model: "local/model-a" }),
    });

    expect(response.status).toBe(200);
    expect(gateway.ledger.recentEntries()[0]?.key).toBe("team");
  });

  it("does not duplicate the version segment when the base URL ends with /v1", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream));

    await fetch(`${gateway.url}/v1/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", query: "q", documents: [] }),
    });

    expect(upstream.requests[0]?.url).toBe("/v1/rerank");
  });

  it("fails over to the next group member on an upstream error", async () => {
    const failing = await startUpstream({ status: 500, body: '{"error":"boom"}' });
    const healthy = await startUpstream({ status: 200, body: '{"images":[]}' });
    const config = baseConfig(healthy, {
      providers: [
        { id: "a", protocol: "openai", baseUrl: `${failing.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "openai", baseUrl: `${healthy.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "group/g", prompt: "cat" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ images: [] });
    expect(failing.requests).toHaveLength(1);
    expect(healthy.requests).toHaveLength(1);
  });

  it("masks an image prompt and puts it back in the revised prompt", async () => {
    const key = "sk-ant-api03-B3rWu6Il6Ps7No3Pl7Wr6Yo4Yo9Io4Ut";
    const seen: string[] = [];
    const upstream = await startDynamicUpstream((request) => {
      const prompt = String(request.body.prompt);
      seen.push(prompt);
      return { status: 200, body: JSON.stringify({ data: [{ revised_prompt: prompt }] }) };
    });
    const gateway = await startGateway(baseConfig(upstream, { masking: { enabled: true } }));

    const prompt = `a cat holding ${key}`;
    const response = await fetch(`${gateway.url}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", prompt }),
    });

    expect(response.status).toBe(200);
    expect(seen[0]).not.toContain(key);
    expect(seen[0]).toMatch(/\{\{API_KEY_[0-9a-f]{8}\}\}/);
    const body = (await response.json()) as { data: Array<{ revised_prompt: string }> };
    expect(body.data[0]?.revised_prompt).toBe(prompt);
  });

  it("rejects a model no provider serves", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "missing/model", input: "hi" }),
    });

    expect(response.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it("rewrites the model field inside a multipart upload and keeps the bytes", async () => {
    let received = "";
    let receivedPath = "";
    let receivedType = "";
    const upstreamApp = express();
    upstreamApp.use(express.raw({ type: () => true }));
    upstreamApp.use((req, res) => {
      received = Buffer.isBuffer(req.body) ? req.body.toString("latin1") : "";
      receivedPath = req.originalUrl;
      receivedType = req.headers["content-type"] ?? "";
      res.setHeader("content-type", "application/json");
      res.end('{"text":"ok"}');
    });
    const upstream = await listen(upstreamApp);
    const gateway = await startGateway(baseConfig(upstream));

    const form = new FormData();
    form.append("model", "local/model-a");
    form.append("purpose", "transcription");
    form.append("file", new Blob(["audio-bytes"]), "clip.wav");
    const response = await fetch(`${gateway.url}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "ok" });
    expect(receivedPath).toBe("/v1/audio/transcriptions");
    expect(receivedType).toContain("multipart/form-data");
    expect(received).toContain("audio-bytes");
    expect(received).toContain('name="model"\r\n\r\nmodel-a');
    expect(received).not.toContain("local/model-a");
  });

  it("requires the gateway key when one is configured", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["secret"] }));

    const unauthorized = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a" }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: JSON.stringify({ model: "local/model-a" }),
    });
    // The key is accepted; the model is not a video model, so the request is
    // refused after authentication rather than as unauthorized.
    expect(authorized.status).toBe(400);
  });
});

describe("discovery and inspection endpoints", () => {
  it("answers /v1 with the gateway name and API list", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const info = (await (await fetch(`${gateway.url}/v1`)).json()) as {
      name: string;
      models: number;
      apis: string[];
    };
    expect(info.name).toBe("neolix-gateway");
    expect(info.models).toBe(2);
    expect(info.apis).toContain("/v1/messages");
  });

  it("returns one model by its provider-qualified id", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const found = await fetch(`${gateway.url}/v1/models/local/model-a`);
    expect(found.status).toBe(200);
    expect((await found.json()) as { id: string }).toMatchObject({ id: "local/model-a" });

    const missing = await fetch(`${gateway.url}/v1/models/local/nope`);
    expect(missing.status).toBe(404);
  });

  it("reports account windows and month spend", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "local",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "model-a" }],
          accounts: [
            { id: "main", apiKey: "k1", priority: 10, weight: 1, quota: { tokens5h: 1000 } },
            { id: "spare", apiKey: "k2", priority: 0, weight: 1 },
          ],
        },
      ],
    });
    const gateway = await startGateway(config);

    const body = (await (await fetch(`${gateway.url}/v1/myna/quotas`)).json()) as {
      object: string;
      data: Array<{ account: string; tokens5hCap: number | null }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((entry) => entry.account)).toEqual(["main", "spare"]);
    expect(body.data[0]?.tokens5hCap).toBe(1000);
  });

  it("shows a key only the quotas of what it may use", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "alpha-only", models: ["alpha/*"], quotas: true }],
        providers: [
          {
            id: "alpha",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "a",
            models: [{ id: "m" }],
          },
          {
            id: "beta",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "b",
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const body = (await (
      await fetch(`${gateway.url}/v1/myna/quotas`, { headers: { "x-api-key": "alpha-only" } })
    ).json()) as { data: Array<{ provider: string; account: string }> };
    expect(body.data.map((entry) => entry.provider)).toEqual(["alpha"]);
  });

  it("shows a key quota cards only for the accounts and models it may use", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [
          { key: "alpha-only", models: ["alpha/*"], quotas: true },
          { key: "alpha-quiet", models: ["alpha/*"] },
        ],
        providers: [
          {
            id: "alpha",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            accounts: [{ id: "one", apiKey: "a", quota: { tokens5h: 100 } }],
            models: [{ id: "m" }],
          },
          {
            id: "beta",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            accounts: [{ id: "two", apiKey: "b", quota: { tokens5h: 100 } }],
            models: [{ id: "m" }],
          },
        ],
      }),
    );
    const cards = async (key: string) =>
      (await (
        await fetch(`${gateway.url}/v1/myna/quotas/cards`, { headers: { "x-api-key": key } })
      ).json()) as { accounts: Array<{ provider: string }> };

    expect((await cards("alpha-only")).accounts.map((entry) => entry.provider)).toEqual(["alpha"]);
    expect((await cards("alpha-quiet")).accounts).toHaveLength(0);
  });

  it("reports what a key may spend and what it already spent", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "team", label: "team", models: [], dailyTokens: 1000, monthlyUsd: 5 }],
      }),
    );

    const denied = await fetch(`${gateway.url}/v1/myna/limit`);
    expect(denied.status).toBe(401);

    const body = (await (
      await fetch(`${gateway.url}/v1/myna/limit`, { headers: { authorization: "Bearer team" } })
    ).json()) as { limited: boolean; dailyTokens: number; monthlyUsd: number; key: string };
    expect(body).toMatchObject({ limited: true, dailyTokens: 1000, monthlyUsd: 5 });
    expect(body.key).not.toBe("team");
  });

  it("tells which upstream a conversation is bound to", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream));

    await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-neolix-conversation": "conv-1" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });

    const body = (await (await fetch(`${gateway.url}/v1/myna/route?session=conv-1`)).json()) as {
      session: string;
      route: { model: string } | null;
    };
    expect(body.session).toBe("conv-1");
    expect(body.route?.model).toContain("model-a");

    const missing = await fetch(`${gateway.url}/v1/myna/route`);
    expect(missing.status).toBe(400);
  });

  it("never repeats a key secret in usage or limit replies", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["super-secret-key"] }));

    await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer super-secret-key" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });

    const usage = await (
      await fetch(`${gateway.url}/v1/myna/usage`, {
        headers: { authorization: "Bearer super-secret-key" },
      })
    ).text();
    expect(usage).not.toContain("super-secret-key");
    const parsedUsage = JSON.parse(usage) as { data: Array<{ key: string; count: number }> };
    expect(parsedUsage.data[0]?.key).not.toBe("super-secret-key");

    const requests = await (
      await fetch(`${gateway.url}/v1/myna/usage/requests`, {
        headers: { authorization: "Bearer super-secret-key" },
      })
    ).text();
    expect(requests).not.toContain("super-secret-key");
  });

  it("polls a video id across providers until one knows it", async () => {
    const unknown = await startUpstream({ status: 404, body: '{"error":"no such video"}' });
    const known = await startUpstream({
      status: 200,
      contentType: "video/mp4",
      body: "mp4-bytes",
    });
    const config = baseConfig(unknown, {
      providers: [
        { id: "a", protocol: "openai", baseUrl: `${unknown.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "openai", baseUrl: `${known.url}/v1`, models: [{ id: "m" }] },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/videos/video-1/content`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mp4-bytes");
    expect(unknown.requests[0]?.url).toBe("/v1/videos/video-1/content");
    expect(known.requests[0]?.url).toBe("/v1/videos/video-1/content");
  });

  it("refuses a video poll the key's models cannot reach", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "video/mp4",
      body: "mp4-bytes",
    });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: [{ key: "team", models: ["other/*"] }] }),
    );

    const response = await fetch(`${gateway.url}/v1/videos/video-1`, {
      headers: { "x-api-key": "team" },
    });

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("Ollama compatibility", () => {
  it("advertises the catalog as tags", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const body = (await (await fetch(`${gateway.url}/api/tags`)).json()) as {
      models: Array<{ name: string; details: { family: string } }>;
    };
    expect(body.models.map((entry) => entry.name)).toEqual(["local/model-a", "local/model-b"]);
    expect(body.models[0]?.details.family).toBe("myna");
  });

  it("serves a chat turn as Ollama JSON", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "model-a",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = (await response.json()) as {
      message: { role: string; content: string };
      done: boolean;
      prompt_eval_count: number;
      eval_count: number;
    };

    expect(body.message).toMatchObject({ role: "assistant", content: "hello" });
    expect(body.done).toBe(true);
    expect(body.prompt_eval_count).toBe(3);
    expect(body.eval_count).toBe(2);
    expect(upstream.requests[0]?.url).toBe("/v1/messages");
    expect(upstream.requests[0]?.body.model).toBe("model-a");
  });

  it("streams chat turns as newline-delimited JSON", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hel"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message?: { content?: string }; done: boolean });

    expect(
      lines
        .filter((line) => line.done === false)
        .map((line) => line.message?.content)
        .join(""),
    ).toBe("hello");
    expect(lines.at(-1)?.done).toBe(true);
  });

  it("turns a generate prompt into a chat turn", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "model-a",
        content: [{ type: "text", text: "answer" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const body = (await (
      await fetch(`${gateway.url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "local/model-a", prompt: "question", stream: false }),
      })
    ).json()) as { response: string };
    expect(body.response).toBe("answer");
    expect(upstream.requests[0]?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]);
  });
});

describe("native passthrough and myna inspection", () => {
  it("forwards a vendor path under /v1/myna/native", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: '{"task":{"id":"t1"}}',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/myna/native/local/contents/generations/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "seedream" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ task: { id: "t1" } });
    expect(upstream.requests[0]?.url).toBe("/v1/contents/generations/tasks");
    expect(upstream.requests[0]?.body).toEqual({ model: "seedream" });
  });

  it("reports recent routes and quota history", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });

    const trace = (await (await fetch(`${gateway.url}/v1/myna/trace`)).json()) as {
      object: string;
      routes: Array<{ served: string; status: number }>;
    };
    expect(trace.object).toBe("trace");
    expect(trace.routes[0]).toMatchObject({ served: "local/model-a" });
    expect(trace.routes[0]?.status).toBe(200);

    const history = (await (
      await fetch(`${gateway.url}/v1/myna/quotas/history?days=7`)
    ).json()) as { object: string; data: unknown[] };
    expect(history.object).toBe("list");
    expect(Array.isArray(history.data)).toBe(true);
  });

  it("streams the trace snapshot and then new routes", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const controller = new AbortController();
    const response = await fetch(`${gateway.url}/v1/myna/route-events`, {
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain("event: trace");
    expect(text).toContain('"object":"trace"');
  });

  it("writes a plain-text status line", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/myna/statusline`);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect((await response.text()).trim().length).toBeGreaterThan(0);
  });
});

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(payload: Record<string, unknown>, privateKey: KeyObject): string {
  const header = base64Url({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = base64Url(payload);
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey);
  return `${header}.${body}.${signature.toString("base64url")}`;
}

describe("OIDC key exchange", () => {
  it("trades a token for a short-lived child key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    const issuerApp = express();
    let issuerUrl = "";
    issuerApp.get("/.well-known/openid-configuration", (_req, res) => {
      res.json({ jwks_uri: `${issuerUrl}/jwks` });
    });
    issuerApp.get("/jwks", (_req, res) => {
      res.json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    });
    const issuer = await listen(issuerApp);
    issuerUrl = issuer.url;
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "parent-secret", label: "ci", models: [], issues: true }],
        oidc: {
          rules: [
            {
              key: "ci",
              issuer: issuerUrl,
              audience: "neolix-ci",
              claims: { repository: "acme/*" },
              ttlSeconds: 600,
            },
          ],
        },
      }),
    );
    const token = signJwt(
      {
        iss: issuerUrl,
        aud: "neolix-ci",
        sub: "job",
        repository: "acme/web",
        exp: Math.floor(Date.now() / 1000) + 300,
        jti: "run-1",
      },
      privateKey,
    );

    const response = await fetch(`${gateway.url}/v1/myna/keys/oidc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: "5m", models: ["local/model-a"] }),
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const issued = (await response.json()) as { key: string; data: { issuer: string } };
    expect(issued.key).toMatch(/^pk_/);
    expect(issued.data.issuer).toBe("parent-secret");

    const models = await fetch(`${gateway.url}/v1/models`, {
      headers: { authorization: `Bearer ${issued.key}` },
    });
    expect(models.status).toBe(200);

    const replay = await fetch(`${gateway.url}/v1/myna/keys/oidc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(replay.status).toBe(401);
  });

  it("refuses a token no rule matches", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "parent-secret", label: "ci", models: [], issues: true }],
        oidc: {
          rules: [
            {
              key: "ci",
              issuer: "https://issuer.example",
              audience: "neolix-ci",
              claims: { repository: "acme/web" },
              ttlSeconds: 600,
            },
          ],
        },
      }),
    );
    const token = signJwt(
      {
        iss: "https://issuer.example",
        aud: "someone-else",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      privateKey,
    );

    const response = await fetch(`${gateway.url}/v1/myna/keys/oidc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });
});

describe("structured output", () => {
  it("asks a translated provider for the client's format", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '{"a":1}' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        messages: [{ role: "user", content: "give a" }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "out", schema: { type: "object" } },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.output_config).toEqual({
      format: { type: "json_schema", schema: { type: "object" } },
    });
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('{"a":1}');
  });

  it("takes a fence off an answer the client wanted as JSON", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: '```json\n{"a":1}\n```' }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));
    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: "give a" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: Array<{ type: string; text: string }> };
    expect(body.content[0]?.text).toBe('{"a":1}');
  });
});

describe("Claude Code compatibility", () => {
  it("refuses a request that names a Message Thread", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));
    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
      thread: { type: "create" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: { error_code: string } } };
    expect(body.error.details.error_code).toBe("thread_unsupported_request");
    expect(upstream.requests).toHaveLength(0);
  });

  it("drops Claude Code's billing line for another vendor", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "key",
            models: [{ id: "m" }],
          },
        ],
      }),
    );
    const response = await postMessages(gateway, {
      model: "local/m",
      max_tokens: 16,
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.3; cch=abc;" }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(upstream.requests[0]?.body)).not.toContain("x-anthropic-billing-header");
  });
});

describe("token limits", () => {
  it("asks once more with the reply length the model takes", async () => {
    let calls = 0;
    const upstream = await startDynamicUpstream(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 400,
          body: JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "max_tokens must be greater than 2" },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });
    const gateway = await startGateway(baseConfig(upstream));
    const response = await postMessages(gateway, {
      model: "local/model-a",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.body.max_tokens).toBe(3);
  });

  it("renames Chat's reply-length field when the vendor asks", async () => {
    let calls = 0;
    const upstream = await startDynamicUpstream(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 400,
          body: JSON.stringify({
            error: { message: "Use 'max_completion_tokens' instead." },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "chat_1",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.body.max_completion_tokens).toBe(8);
    expect(upstream.requests[1]?.body.max_tokens).toBeUndefined();
  });
});

describe("thinking back", () => {
  it("asks once more with a filler and remembers it", async () => {
    let calls = 0;
    const upstream = await startDynamicUpstream(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 400,
          body: JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message:
                "The `content[].thinking` in the thinking mode must be passed back to the API.",
            },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "thinking-back-test",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "key",
            models: [{ id: "model-tb" }],
          },
        ],
      }),
    );
    const turn = {
      model: "thinking-back-test/model-tb",
      max_tokens: 16,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "looking" },
            { type: "tool_use", id: "t1", name: "read", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      ],
    };
    const first = await postMessages(gateway, turn);
    expect(first.status).toBe(200);
    expect(calls).toBe(2);
    expect(JSON.stringify(upstream.requests[0]?.body)).not.toContain('"thinking":{"thinking":" "');
    expect(JSON.stringify(upstream.requests[1]?.body)).toContain('"thinking":" "');

    // Filled from the first request on once learned.
    const second = await postMessages(gateway, turn);
    expect(second.status).toBe(200);
    expect(calls).toBe(3);
    expect(JSON.stringify(upstream.requests[2]?.body)).toContain('"thinking":" "');
  });
});

describe("key page and search", () => {
  it("serves the key page and the caller's own limits", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "team-key", label: "team", models: ["local/model-a"], monthlyUsd: 5 }],
      }),
    );

    const page = await fetch(`${gateway.url}/me`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Gateway key");

    const info = await fetch(`${gateway.url}/v1/myna/me`, {
      headers: { authorization: "Bearer team-key" },
    });
    expect(info.status).toBe(200);
    const body = (await info.json()) as { label: string; key: string; monthlyUsd: number };
    expect(body.label).toBe("team");
    expect(body.key).not.toBe("team-key");
    expect(body.monthlyUsd).toBe(5);
  });

  it("charges a search call against the key's monthly allowance", async () => {
    const searchUpstream = await startDynamicUpstream((request) => {
      expect(request.body.query).toBe("neolix release");
      return { status: 200, body: JSON.stringify({ results: [{ title: "hit" }] }) };
    });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "team-key", models: [], searchCallsPerMonth: 1 }],
        search: {
          enabled: true,
          url: `${searchUpstream.url}/search`,
          apiKey: "tvly-test",
          monthlyCalls: 10,
        },
      }),
    );
    const headers = { authorization: "Bearer team-key", "content-type": "application/json" };

    const first = await fetch(`${gateway.url}/v1/alpha/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "neolix release" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ results: [{ title: "hit" }] });

    const second = await fetch(`${gateway.url}/v1/alpha/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "neolix release" }),
    });
    expect(second.status).toBe(429);
  });

  it("masks a search query and puts the answer's stand-in back", async () => {
    const key = "sk-ant-api03-Q7hLm2Vx9Kp4Rw8Tz1Bn6Yc3Jd5Fg0Hs";
    const seen: string[] = [];
    const searchUpstream = await startDynamicUpstream((request) => {
      const query = String(request.body.query);
      seen.push(query);
      return { status: 200, body: JSON.stringify({ results: [{ title: query }] }) };
    });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        masking: { enabled: true },
        search: { enabled: true, url: `${searchUpstream.url}/search` },
      }),
    );

    const response = await fetch(`${gateway.url}/v1/alpha/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `find ${key} in the docs` }),
    });
    expect(response.status).toBe(200);
    expect(seen[0]).not.toContain(key);
    expect(seen[0]).toMatch(/\{\{API_KEY_[0-9a-f]{8}\}\}/);
    const body = (await response.json()) as { results: Array<{ title: string }> };
    expect(body.results[0]?.title).toBe(`find ${key} in the docs`);
  });

  it("asks search APIs in order and a refused key last", async () => {
    const seen: string[] = [];
    const searchUpstream = await startDynamicUpstream((request) => {
      const auth = String(request.headers.authorization ?? "");
      seen.push(auth);
      if (auth === "Bearer bad") {
        return { status: 401, body: JSON.stringify({ error: "refused" }) };
      }
      return {
        status: 200,
        body: JSON.stringify({ results: [{ title: "A", url: "https://a", content: "found" }] }),
      };
    });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        search: {
          enabled: true,
          url: "https://api.tavily.com/search",
          apis: [
            {
              vendor: "tavily",
              key: "bad,good",
              pick: "order",
              url: searchUpstream.url,
            },
          ],
        },
      }),
    );
    const response = await fetch(`${gateway.url}/v1/alpha/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "weather" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { source: string; results: unknown[] };
    expect(body.source).toBe("tavily");
    expect(body.results).toHaveLength(1);
    expect(seen).toEqual(["Bearer bad", "Bearer good"]);
  });

  it("gives a provider that searches its web_search tool untouched", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "key",
            models: [{ id: "model-a" }],
            searches: true,
          },
        ],
      }),
    );
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "weather today" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(upstream.requests[0]?.body.tools)).toContain("web_search");
  });

  it("searches for a provider that can't and gives it the pages", async () => {
    const searchUpstream = await startDynamicUpstream(() => ({
      status: 200,
      body: JSON.stringify({ results: [{ title: "A", url: "https://a", content: "found" }] }),
    }));
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
            searches: false,
          },
        ],
        search: {
          enabled: true,
          url: "https://api.tavily.com/search",
          apis: [{ vendor: "tavily", key: "tv", url: searchUpstream.url }],
        },
      }),
    );
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "weather in Paris" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    const sent = upstream.requests[0]?.body;
    expect(JSON.stringify(sent)).not.toContain("web_search_20250305");
    expect(JSON.stringify(sent?.system)).toContain("https://a");
    expect(JSON.stringify(searchUpstream.requests?.[0]?.body)).toContain("weather in Paris");
  });

  it("asks a searcher's own model when no search API answers", async () => {
    const searcher = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_search",
        type: "message",
        role: "assistant",
        content: [
          { type: "server_tool_use", id: "s1", name: "web_search", input: {} },
          {
            type: "web_search_tool_result",
            tool_use_id: "s1",
            content: [{ type: "web_search_result", title: "Paris", url: "https://paris.example" }],
          },
          { type: "text", text: "It rained in Paris." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
            searches: false,
          },
          {
            id: "web",
            protocol: "anthropic",
            baseUrl: `${searcher.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "search-model" }],
            searches: true,
          },
        ],
        search: { searcher: "web" },
      }),
    );
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "weather in Paris" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(searcher.requests[0]?.body.model).toBe("search-model");
    expect(JSON.stringify(searcher.requests[0]?.body.messages)).toContain("weather in Paris");
    const sent = upstream.requests[0]?.body;
    expect(JSON.stringify(sent)).not.toContain("web_search_20250305");
    expect(JSON.stringify(sent?.system)).toContain("https://paris.example");
  });

  it("tells the client about the search the gateway ran", async () => {
    const searchUpstream = await startDynamicUpstream(() => ({
      status: 200,
      body: JSON.stringify({
        results: [
          { title: "Neox", url: "https://example.com", content: "a phone app" },
          { title: "Docs", url: "https://example.com/docs", content: "how it works" },
        ],
      }),
    }));
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "It is a phone app." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
            searches: false,
          },
        ],
        search: {
          enabled: true,
          url: "https://api.tavily.com/search",
          apis: [{ vendor: "tavily", key: "tv", url: searchUpstream.url }],
        },
      }),
    );
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "what is neolix" }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { content: Array<Record<string, unknown>> };
    const call = body.content[0];
    expect(call?.type).toBe("server_tool_use");
    expect(call?.name).toBe("web_search");
    expect(call?.input).toEqual({ query: "what is neolix" });
    const result = body.content[1];
    expect(result?.type).toBe("web_search_tool_result");
    expect(result?.tool_use_id).toBe(call?.id);
    expect(result?.content).toEqual([
      {
        type: "web_search_result",
        title: "Neox",
        url: "https://example.com",
        encrypted_content: "",
      },
      {
        type: "web_search_result",
        title: "Docs",
        url: "https://example.com/docs",
        encrypted_content: "",
      },
    ]);
    expect(body.content[2]).toEqual({ type: "text", text: "It is a phone app." });
  });

  it("answers the search MCP tools", async () => {
    const searchUpstream = await startUpstream({
      status: 200,
      body: JSON.stringify({ results: [{ title: "hit" }] }),
    });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        search: { enabled: true, url: `${searchUpstream.url}/search` },
      }),
    );

    const list = (await (
      await fetch(`${gateway.url}/mcp/myna/web-search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["web_search", "web_fetch"]),
    );

    const call = (await (
      await fetch(`${gateway.url}/mcp/myna/web-search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "neolix" } },
        }),
      })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(call.result.content[0]?.text).toContain("hit");
  });
});

describe("myna parity surface", () => {
  it("answers every client-facing path myna serves", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const searchUpstream = await startUpstream({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: ["parity-key"],
        search: { enabled: true, url: `${searchUpstream.url}/search` },
        oidc: { rules: [] },
      }),
    );
    const headers = { authorization: "Bearer parity-key", "content-type": "application/json" };

    const gets = [
      "/v1",
      "/v1/models",
      "/models",
      "/v1/models/local/model-a",
      "/v1/myna/quotas",
      "/v1/myna/usage",
      "/v1/myna/usage/requests",
      "/v1/myna/quotas/history",
      "/v1/myna/route",
      "/v1/myna/trace",
      "/v1/myna/route-events/snapshot",
      "/v1/myna/concurrency",
      "/v1/myna/limit",
      "/v1/myna/statusline",
      "/v1/myna/keys",
      "/v1/myna/me",
      "/v1/myna/omarchy",
      "/v1/myna/native/local/models",
      "/api/version",
      "/api/tags",
      "/api/hello",
      "/muse-code/models",
      "/v1/responses",
      "/v1/myna/heap",
      "/v1/myna/goroutines",
      "/v1/myna/claude-runs",
      "/v1/myna/mcp",
      "/v1/codex/models",
    ];
    const posts: Array<[string, Record<string, unknown>]> = [
      ["/v1/chat/completions", { model: "local/model-a", messages: [] }],
      ["/chat/completions", { model: "local/model-a", messages: [] }],
      ["/v1/messages", { model: "local/model-a", messages: [] }],
      ["/messages", { model: "local/model-a", messages: [] }],
      ["/v1/responses", { model: "local/model-a", input: "hi" }],
      ["/responses", { model: "local/model-a", input: "hi" }],
      ["/v1/images/generations", { model: "local/model-a", prompt: "cat" }],
      ["/v1/embeddings", { model: "local/model-a", input: "x" }],
      ["/v1/rerank", { model: "local/model-a", query: "x", documents: [] }],
      ["/v1/audio/speech", { model: "local/model-a", input: "x" }],
      ["/v1/videos", { model: "local/model-a", prompt: "x" }],
      ["/v1/systemone", { model: "local/model-a", query: "x" }],
      ["/api/chat", { model: "local/model-a", stream: false, messages: [] }],
      ["/api/generate", { model: "local/model-a", prompt: "x", stream: false }],
      ["/api/show", { name: "local/model-a" }],
      ["/v1/alpha/search", { query: "x" }],
      ["/v1/myna/usage/requests", { requested: "local/model-a", model: "model-a" }],
      ["/v1/myna/restart", {}],
      ["/backend-api/codex/responses", {}],
      ["/v1/myna/native/local/anything", {}],
      ["/mcp/myna/web-search", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
    ];

    const refused: string[] = [];
    for (const routePath of gets) {
      const response = await fetch(`${gateway.url}${routePath}`, { headers });
      if (response.status === 404) {
        refused.push(`GET ${routePath}`);
      }
    }
    for (const [routePath, body] of posts) {
      const response = await fetch(`${gateway.url}${routePath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (response.status === 404) {
        refused.push(`POST ${routePath}`);
      }
    }
    expect(refused).toEqual([]);

    const page = await fetch(`${gateway.url}/me`);
    expect(page.headers.get("content-type")).toContain("text/html");
  });
});

describe("Section 9 parity routes", () => {
  it("answers the daemon diagnostics myna serves", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["diag"] }));
    const headers = { authorization: "Bearer diag", "content-type": "application/json" };

    const heap = await fetch(`${gateway.url}/v1/myna/heap`, { headers });
    expect(heap.status).toBe(200);
    expect(heap.headers.get("x-magpie-heap-stats")).toContain('"pid"');

    const goroutines = await fetch(`${gateway.url}/v1/myna/goroutines`, { headers });
    expect(goroutines.status).toBe(200);
    const goroutineJson = (await goroutines.json()) as { resources: unknown[] };
    expect(Array.isArray(goroutineJson.resources)).toBe(true);

    const cpu = await fetch(`${gateway.url}/v1/myna/cpu?seconds=0.05`, { headers });
    expect(cpu.status).toBe(200);
    expect((await cpu.json()) as { seconds: number }).toMatchObject({ seconds: 0.05 });

    const restart = await fetch(`${gateway.url}/v1/myna/restart`, {
      method: "POST",
      headers,
      body: JSON.stringify({ version: "next" }),
    });
    // fetch sends Sec-Fetch-Mode, which myna (and Neolix) read as a web page.
    expect(restart.status).toBe(403);
    expect((await restart.json()) as { error: { type: string } }).toMatchObject({
      error: { type: "permission_error" },
    });

    // myna's claude_runs.go answers {object:"claude-runs", runs, live, most,
    // mostWhy, idleMost, idleFor}; a gateway without the bridge lists none.
    const runs = await fetch(`${gateway.url}/v1/myna/claude-runs`, { headers });
    expect(runs.status).toBe(200);
    expect((await runs.json()) as { object: string; runs: unknown[] }).toMatchObject({
      object: "claude-runs",
      runs: [],
    });
  });

  it("forwards a companion MCP request to the configured server", async () => {
    const mcp = await startDynamicUpstream((request) => {
      expect(request.body).toMatchObject({ method: "tools/list" });
      return {
        status: 200,
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [{ name: "search" }] } }),
      };
    });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, { keys: ["mcp-key"], mcp: { tools: `${mcp.url}/mcp` } }),
    );

    const response = await fetch(`${gateway.url}/mcp/myna/tools`, {
      method: "POST",
      headers: { authorization: "Bearer mcp-key", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { tools: [{ name: "search" }] } });
    expect(mcp.requests[0]?.url).toBe("/mcp");

    const unconfigured = await fetch(`${gateway.url}/mcp/myna/vision`, {
      method: "POST",
      headers: { authorization: "Bearer mcp-key", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });
    expect(unconfigured.status).toBe(200);
    // Without the vision service this gateway has no analyze_image; the path
    // is myna's, so /mcp/vision stays free for a server the user configures.
    expect(await unconfigured.json()).toMatchObject({ result: { tools: [] } });
  });

  it("revokes an issued key by id", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [
          { key: "parent", label: "ci", models: [], issues: true },
          { key: "child", label: "kid", models: [], issuer: "parent" },
        ],
      }),
    );

    const gone = await fetch(`${gateway.url}/v1/myna/keys/kid`, {
      method: "DELETE",
      headers: { authorization: "Bearer parent", "content-type": "application/json" },
    });
    expect(gone.status).toBe(204);
  });
});

describe("Codex backend passthrough", () => {
  it("forwards to the configured Codex backend", async () => {
    const codex = await startUpstream({ status: 200, body: '{"ok":true}' });
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: ["codex-key"],
        codexBackend: `${codex.url}/backend-api/codex`,
      }),
    );

    const response = await fetch(`${gateway.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: { authorization: "Bearer codex-key", "content-type": "application/json" },
      body: JSON.stringify({ model: "x" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(codex.requests[0]?.url).toBe("/backend-api/codex/responses");
  });

  it("spends Neox's own ChatGPT account before Codex's own sign-in", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["codex-key"] }));
    await saveCodexAccounts(path.join(gateway.neolixHome, "gateway", "codex-accounts.json"), [
      {
        id: "neolix:acct-1",
        label: "me@example.com",
        plan: "plus",
        accountId: "acct-1",
        accessToken: "pool-token",
        refreshToken: null,
        idToken: null,
        // A token with time left: one whose expiry says nothing is refreshed,
        // and an account with no refresh token can't be.
        expiresAt: Date.now() + 3_600_000,
        addedAt: 1,
      },
    ]);
    const realFetch = globalThis.fetch;
    const seen: Headers[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://chatgpt.com/backend-api/codex")) {
        seen.push(new Headers(init?.headers));
        return Promise.resolve(
          new Response('{"ok":true}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return realFetch(input, init);
    });
    try {
      const response = await fetch(`${gateway.url}/backend-api/codex/responses`, {
        method: "POST",
        headers: { authorization: "Bearer codex-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "x", input: "hi" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      vi.restoreAllMocks();
    }
    expect(seen[0]?.get("authorization")).toMatch(/^Bearer \S+$/);
    expect(seen[0]?.get("chatgpt-account-id")).toBe("acct-1");
  });

  it("answers 401 when no backend is configured and Codex is signed out", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream, { keys: ["codex-key"] }));
    const invalid = await fetch(`${gateway.url}/backend-api/codex/responses`, {
      method: "POST",
      headers: { authorization: "Bearer codex-key", "content-type": "application/json" },
      body: "{}",
    });
    expect(invalid.status).toBe(400);

    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-codex-signed-out-"));
    const before = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      const response = await fetch(`${gateway.url}/backend-api/codex/responses`, {
        method: "POST",
        headers: { authorization: "Bearer codex-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "x", input: "hi" }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { message: "Codex is signed out" },
      });
    } finally {
      if (before === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = before;
      }
    }
  });
});

describe("local calc tools", () => {
  it("runs calc_eval without a configured MCP server", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/mcp/myna/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "calc_eval", arguments: { expression: "0.1+0.2" } },
      }),
    });
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(false);
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toEqual({
      exact: "3/10",
      decimal: "0.3",
    });
  });

  it("runs calc_convert with the myna unit table", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/mcp/myna/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "calc_convert", arguments: { value: "1.5", from: "GiB", to: "MB" } },
      }),
    });
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toEqual({
      exact: "25165824/15625",
      decimal: "1610.612736",
      unit: "MB",
    });
  });
});

describe("POST /v1/videos", () => {
  function customConfig(upstream: { url: string }): GatewayConfig {
    return {
      version: 1,
      enabled: true,
      keys: [],
      providers: [
        {
          id: "video",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          apiKey: "video-key",
          models: [{ id: "custom-video", kind: "video" }],
        },
      ],
      groups: [],
    };
  }

  it("starts a video at a provider's OpenAI-shaped videos API", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/v1/videos") {
        return {
          status: 200,
          body: JSON.stringify({
            id: "vid-1",
            object: "video",
            status: "queued",
            model: "custom-video",
          }),
        };
      }
      return { status: 404, body: "{}" };
    });
    const gateway = await startGateway(customConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video/custom-video", prompt: "a kite sways" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.model).toBe("video/custom-video");
    expect(body.status).toBe("queued");
    expect(String(body.id)).toMatch(/^video_video\.[A-Za-z0-9_-]+\.\d+\.kdefault$/);
    expect(upstream.requests[0]?.url).toBe("/v1/videos");
    expect(upstream.requests[0]?.body).toMatchObject({
      model: "custom-video",
      prompt: "a kite sways",
    });
  });

  it("checks the key's models when it picks the video model", async () => {
    const upstream = await startDynamicUpstream(() => ({
      status: 200,
      body: JSON.stringify({ id: "vid-auto", status: "queued" }),
    }));
    const config = customConfig(upstream);
    config.keys = [{ key: "text-only", models: ["local/model-a"] }];
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "text-only" },
      body: JSON.stringify({ prompt: "a kite" }),
    });

    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });

  it("polls and downloads a URL-started video", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/v1/videos") {
        return { status: 200, body: JSON.stringify({ id: "vid-2", status: "queued" }) };
      }
      if (request.url === "/v1/videos/vid-2") {
        return {
          status: 200,
          body: JSON.stringify({ id: "vid-2", status: "completed", model: "custom-video" }),
        };
      }
      if (request.url === "/v1/videos/vid-2/content") {
        return { status: 200, body: "MP4-BYTES", contentType: "video/mp4" };
      }
      return { status: 404, body: "{}" };
    });
    const gateway = await startGateway(customConfig(upstream));

    const started = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video/custom-video", prompt: "a kite" }),
    });
    const id = ((await started.json()) as { id: string }).id;

    const status = await fetch(`${gateway.url}/v1/videos/${encodeURIComponent(id)}`);
    expect(status.status).toBe(200);
    const object = (await status.json()) as Record<string, unknown>;
    expect(object.id).toBe(id);
    expect(object.status).toBe("completed");
    expect(object.model).toBe("video/custom-video");

    const content = await fetch(`${gateway.url}/v1/videos/${encodeURIComponent(id)}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("video/mp4");
    expect(await content.text()).toBe("MP4-BYTES");
  });

  it("accepts a first frame as multipart", async () => {
    const upstream = await startDynamicUpstream(() => ({
      status: 200,
      body: JSON.stringify({ id: "vid-form", status: "queued" }),
    }));
    const gateway = await startGateway(customConfig(upstream));
    const form = new FormData();
    form.set("model", "video/custom-video");
    form.set("prompt", "animate this");
    form.set("seconds", "6");
    form.set(
      "input_reference",
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
      "frame.png",
    );

    const response = await fetch(`${gateway.url}/v1/videos`, { method: "POST", body: form });

    expect(response.status).toBe(200);
    const sent = upstream.requests[0]?.body as {
      seconds?: string;
      input_reference?: string;
    };
    expect(sent.seconds).toBe("6");
    expect(sent.input_reference).toMatch(/^data:image\/png;base64,/);
  });

  it("validates the prompt, the seconds and the model", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway({
      ...customConfig(upstream),
      providers: [
        ...customConfig(upstream).providers,
        {
          id: "chat",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "text-model" }],
        },
      ],
    });

    const empty = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video/custom-video" }),
    });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { message: string } }).error.message).toBe(
      "say what to film in prompt",
    );

    const badSeconds = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video/custom-video", prompt: "x", seconds: 2.5 }),
    });
    expect(badSeconds.status).toBe(400);
    expect(((await badSeconds.json()) as { error: { message: string } }).error.message).toBe(
      'seconds is a whole number of at least 1, not "2.5"',
    );

    const chat = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chat/text-model", prompt: "x" }),
    });
    expect(chat.status).toBe(400);
    expect(((await chat.json()) as { error: { message: string } }).error.message).toContain(
      "can't make videos",
    );

    const unknown = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nobody/nothing", prompt: "x" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { message: string } }).error.message).toContain(
      "knows no model",
    );
  });

  it("makes an Ark task with frames, duration and size", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/api/v3/contents/generations/tasks") {
        return { status: 200, body: JSON.stringify({ id: "cgt-1" }) };
      }
      if (request.url === "/api/v3/contents/generations/tasks/cgt-1") {
        return {
          status: 200,
          body: JSON.stringify({
            id: "cgt-1",
            status: "succeeded",
            model: "doubao-seedance-1-0",
            content: { video_url: `${upstream.url}/bucket/out.mp4` },
            duration: 6,
            resolution: "720p",
            ratio: "16:9",
          }),
        };
      }
      if (request.url === "/bucket/out.mp4") {
        return { status: 200, body: "ARK-MP4", contentType: "video/mp4" };
      }
      return { status: 404, body: "{}" };
    });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "ark",
          protocol: "openai-responses",
          baseUrl: `${upstream.url}/api/v3`,
          videoApi: "ark",
          apiKey: "ark-key",
          models: [{ id: "doubao-seedance-1-0" }],
        },
      ],
    });

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ark/doubao-seedance-1-0",
        prompt: "a kite",
        seconds: 6,
        size: "1280x720",
      }),
    });

    expect(response.status).toBe(200);
    const started = (await response.json()) as { id: string; status: string; model: string };
    expect(started.status).toBe("queued");
    expect(started.model).toBe("ark/doubao-seedance-1-0");
    const sent = upstream.requests[0]?.body as {
      content?: Array<Record<string, unknown>>;
      duration?: number;
      ratio?: string;
      resolution?: string;
    };
    expect(sent.content?.[0]).toEqual({ type: "text", text: "a kite" });
    expect(sent.duration).toBe(6);
    expect(sent.ratio).toBe("16:9");
    expect(sent.resolution).toBe("720p");

    const status = await fetch(`${gateway.url}/v1/videos/${started.id}`);
    const object = (await status.json()) as Record<string, unknown>;
    expect(object.status).toBe("completed");
    expect(object.seconds).toBe("6");
    expect(object.resolution).toBe("720p");

    const content = await fetch(`${gateway.url}/v1/videos/${started.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe("ARK-MP4");
  });

  it("makes and polls a MiniMax H3 video", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/v2/video_generation") {
        return { status: 200, body: JSON.stringify({ task_id: "t-1" }) };
      }
      if (request.url === "/v2/query/video_generation/t-1") {
        return {
          status: 200,
          body: JSON.stringify({
            task: {
              id: "t-1",
              model: "MiniMax-H3",
              status: "succeeded",
              duration: 5,
              content: { url: `${upstream.url}/bucket/minimax.mp4` },
            },
          }),
        };
      }
      if (request.url === "/bucket/minimax.mp4") {
        return { status: 200, body: "MM-MP4", contentType: "video/mp4" };
      }
      return { status: 404, body: "{}" };
    });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "minimax",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          videoApi: "minimax",
          apiKey: "mm-key",
          models: [],
        },
      ],
    });

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "minimax/MiniMax-H3", prompt: "a kite", size: "1280x720" }),
    });
    expect(response.status).toBe(200);
    const started = (await response.json()) as { id: string; model: string };
    expect(started.model).toBe("minimax/MiniMax-H3");
    expect(upstream.requests[0]?.url).toBe("/v2/video_generation");
    expect(upstream.requests[0]?.body).toMatchObject({
      model: "MiniMax-H3",
      duration: 5,
      resolution: "768P",
      ratio: "16:9",
    });

    const status = await fetch(`${gateway.url}/v1/videos/${started.id}`);
    const object = (await status.json()) as Record<string, unknown>;
    expect(object.status).toBe("completed");
    expect(object.seconds).toBe("5");
  });

  it("starts a Grok Imagine video and reads its request id", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/v1/videos/generations") {
        return { status: 200, body: JSON.stringify({ request_id: "req-1" }) };
      }
      if (request.url === "/v1/videos/req-1") {
        return {
          status: 200,
          body: JSON.stringify({
            status: "done",
            progress: 100,
            model: "grok-imagine-video",
            video: { url: `${upstream.url}/bucket/grok.mp4`, duration: 6 },
          }),
        };
      }
      if (request.url === "/bucket/grok.mp4") {
        return { status: 200, body: "GROK-MP4", contentType: "video/mp4" };
      }
      return { status: 404, body: "{}" };
    });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "grok",
          protocol: "openai-responses",
          baseUrl: `${upstream.url}/v1`,
          videoApi: "grok",
          apiKey: "grok-token",
          models: [{ id: "grok-imagine-video" }],
        },
      ],
    });

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "grok/grok-imagine-video",
        prompt: "a kite sways",
        seconds: 6,
        size: "1280x720",
      }),
    });
    expect(response.status).toBe(200);
    const started = (await response.json()) as { id: string; seconds: string };
    expect(started.id).toMatch(/^video_grok\.req-1\./);
    expect(started.seconds).toBe("6");
    expect(upstream.requests[0]?.body).toMatchObject({
      model: "grok-imagine-video",
      prompt: "a kite sways",
      duration: 6,
      aspect_ratio: "16:9",
      resolution: "720p",
    });

    const status = await fetch(`${gateway.url}/v1/videos/${started.id}`);
    const object = (await status.json()) as Record<string, unknown>;
    expect(object.status).toBe("completed");
    expect(object.model).toBe("grok/grok-imagine-video");

    const content = await fetch(`${gateway.url}/v1/videos/${started.id}/content`);
    expect(await content.text()).toBe("GROK-MP4");
  });

  it("picks the first video model when the request names none", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({ id: "vid-auto" }),
    });
    const gateway = await startGateway(customConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a kite" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe("video/custom-video");
    expect(upstream.requests[0]?.body).toMatchObject({ model: "custom-video" });
  });

  it("explains a MiniMax task that failed", async () => {
    const upstream = await startDynamicUpstream((request) => {
      if (request.url === "/v2/video_generation") {
        return { status: 200, body: JSON.stringify({ task_id: "t-2" }) };
      }
      return {
        status: 200,
        body: JSON.stringify({
          task: {
            id: "t-2",
            model: "MiniMax-H3",
            status: "failed",
            error: { code: "1026", message: "video description contains sensitive content" },
          },
        }),
      };
    });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "minimax",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          videoApi: "minimax",
          apiKey: "mm-key",
          models: [],
        },
      ],
    });
    const started = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "minimax/MiniMax-H3", prompt: "a kite" }),
    });
    const id = ((await started.json()) as { id: string }).id;

    const status = await fetch(`${gateway.url}/v1/videos/${id}`);
    const object = (await status.json()) as {
      status: string;
      error: { code: string; message: string };
    };
    expect(object.status).toBe("failed");
    expect(object.error.code).toBe("1026");
    expect(object.error.message).toContain("sensitive content");
  });

  it("refuses Ark-only fields at other vendors", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(customConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/videos`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "video/custom-video", prompt: "x", seconds: -1 }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
      "Volcengine Ark's alone",
    );
  });
});

describe("routing group rules", () => {
  it("sends a matching rule's requests to its member first", async () => {
    const first = await startUpstream({ status: 200, body: '{"first":true}' });
    const second = await startUpstream({ status: 200, body: '{"second":true}' });
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [{ id: "g", members: ["a/m", "b/m"], strategy: "order", rules: [{ use: "b/m" }] }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
  });

  it("holds a group's provider to the accounts it names", async () => {
    const allowed = await startUpstream({ status: 200, body: '{"ok":true}' });
    const other = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(allowed, {
      providers: [
        {
          id: "pool",
          protocol: "anthropic",
          baseUrl: `${other.url}/v1`,
          accounts: [
            { id: "one", apiKey: "key-one", baseUrl: `${allowed.url}/v1` },
            { id: "two", apiKey: "key-two", baseUrl: `${other.url}/v1` },
          ],
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "g", members: ["pool/m"], strategy: "order", accounts: ["pool/one"] }],
    });
    const gateway = await startGateway(config);

    expect((await postMessages(gateway, { model: "group/g", messages: [] })).status).toBe(200);
    expect((await postMessages(gateway, { model: "group/g", messages: [] })).status).toBe(200);
    expect(other.requests).toHaveLength(0);
    expect(allowed.requests).toHaveLength(2);
  });

  it("sends a member pinned at an effort with that reasoning", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "g", members: ["a/m:high"], strategy: "order" }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.reasoning_effort).toBe("high");
  });

  it("asks for the reasoning a matching rule names", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m"],
          strategy: "order",
          rules: [{ use: "a/m", useEffort: "medium" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.reasoning_effort).toBe("medium");
  });

  it("sends a fast member in its vendor's fast mode", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "g", members: ["a/m"], strategy: "order", fast: ["a/m"] }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.speed).toBe("fast");
  });

  it("turns weighted members by their shares", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m", "b/m"],
          strategy: "order",
          weighted: true,
          weights: { "a/m": 3 },
        },
      ],
    });
    const gateway = await startGateway(config);

    for (let index = 0; index < 4; index += 1) {
      expect((await postMessages(gateway, { model: "group/g", messages: [] })).status).toBe(200);
    }
    expect(first.requests).toHaveLength(3);
    expect(second.requests).toHaveLength(1);
  });
});

describe("routing group reasoning and intent", () => {
  it("sends a pinned Anthropic effort as a thinking budget", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [{ id: "g", members: ["a/m:high"], strategy: "order" }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.thinking).toEqual({
      type: "enabled",
      budget_tokens: 24000,
    });
    expect(upstream.requests[0]?.body.max_tokens).toBe(24000 + 4096);
  });

  it("sends adaptive thinking to Claude 4.5 and later, which refuse a budget", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "anthropic",
          baseUrl: `${upstream.url}/v1`,
          models: [{ id: "claude-haiku-4-5" }],
        },
      ],
      groups: [{ id: "g", members: ["a/claude-haiku-4-5:high"], strategy: "order" }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.thinking).toEqual({ type: "adaptive" });
    expect(upstream.requests[0]?.body.max_tokens).toBeUndefined();
  });

  it("sends a pinned Gemini effort as a thinking level", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "gemini",
          baseUrl: `${upstream.url}/v1beta`,
          models: [{ id: "gemini-3-flash" }],
        },
      ],
      groups: [{ id: "g", members: ["a/gemini-3-flash:medium"], strategy: "order" }],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, { model: "group/g", messages: [] });

    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.generationConfig).toMatchObject({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" },
    });
  });

  it("sends a rule's requests by the intent its classifier names", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const classifier = await startUpstream({
      status: 200,
      body: '{"content":[{"type":"text","text":"1"}]}',
    });
    const hard = "a hard task: designing or debugging";
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
        {
          id: "cls",
          protocol: "anthropic",
          baseUrl: `${classifier.url}/v1`,
          models: [{ id: "small" }],
        },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m", "b/m"],
          strategy: "order",
          classifier: "cls/small",
          rules: [{ use: "b/m", intent: hard }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "group/g",
      messages: [{ role: "user", content: "debug this failing test" }],
    });

    expect(response.status).toBe(200);
    expect(classifier.requests).toHaveLength(1);
    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(1);
  });

  it("routes the classifier's question through the gateway, failover included", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const classifier = await startDynamicUpstream((request) =>
      request.body.model === "bad"
        ? { status: 500, body: '{"error":"boom"}' }
        : { status: 200, body: '{"content":[{"type":"text","text":"1"}]}' },
    );
    const hard = "a hard task: designing or debugging";
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
        {
          id: "c",
          protocol: "anthropic",
          baseUrl: `${classifier.url}/v1`,
          models: [{ id: "bad" }, { id: "good" }],
        },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m", "b/m"],
          strategy: "order",
          classifier: "group/cls",
          rules: [{ use: "b/m", intent: hard }],
        },
        { id: "cls", members: ["c/bad", "c/good"], strategy: "order" },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "group/g",
      messages: [{ role: "user", content: "debug this failing test" }],
    });

    expect(response.status).toBe(200);
    expect(classifier.requests.map((request) => request.body.model)).toEqual(["bad", "good"]);
    expect(second.requests).toHaveLength(1);
    expect(first.requests).toHaveLength(0);
  });

  it("asks no classifier in turn when the classifier's own model has an intent rule", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const classifier = await startUpstream({
      status: 200,
      body: '{"content":[{"type":"text","text":"1"}]}',
    });
    const hard = "a hard task: designing or debugging";
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
        {
          id: "c",
          protocol: "anthropic",
          baseUrl: `${classifier.url}/v1`,
          models: [{ id: "small" }],
        },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m", "b/m"],
          strategy: "order",
          classifier: "group/cls",
          rules: [{ use: "b/m", intent: hard }],
        },
        {
          id: "cls",
          members: ["c/small"],
          strategy: "order",
          classifier: "group/cls",
          rules: [{ use: "c/small", intent: hard }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "group/g",
      messages: [{ role: "user", content: "plan this refactor across files" }],
    });

    expect(response.status).toBe(200);
    expect(classifier.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it("lets no intent match when the classifier fails", async () => {
    const first = await startUpstream({ status: 200, body: '{"ok":true}' });
    const second = await startUpstream({ status: 200, body: '{"ok":true}' });
    const classifier = await startUpstream({ status: 500, body: '{"error":"boom"}' });
    const config = baseConfig(first, {
      providers: [
        { id: "a", protocol: "anthropic", baseUrl: `${first.url}/v1`, models: [{ id: "m" }] },
        { id: "b", protocol: "anthropic", baseUrl: `${second.url}/v1`, models: [{ id: "m" }] },
        {
          id: "cls",
          protocol: "anthropic",
          baseUrl: `${classifier.url}/v1`,
          models: [{ id: "small" }],
        },
      ],
      groups: [
        {
          id: "g",
          members: ["a/m", "b/m"],
          strategy: "order",
          classifier: "cls/small",
          rules: [{ use: "b/m", intent: "a hard task" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await postMessages(gateway, {
      model: "group/g",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.status).toBe(200);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(0);
  });
});

describe("tool refusals", () => {
  it("asks once more without strict when the vendor refuses it", async () => {
    const upstream = await startDynamicUpstream((request) =>
      JSON.stringify(request.body.tools ?? []).includes('"strict"')
        ? {
            status: 400,
            body: '{"error":{"message":"Unsupported Chat Completions API field: tools[0].function.strict"}}',
          }
        : { status: 200, body: '{"id":"r1","choices":[{"message":{"content":"ok"}}]}' },
    );
    const config = baseConfig(upstream, {
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: `${upstream.url}/v1`,
          apiKey: "k",
          models: [{ id: "m" }],
        },
      ],
    });
    const gateway = await startGateway(config);

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "a/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: { name: "f", strict: true, parameters: { type: "object" } },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(JSON.stringify(upstream.requests[1]?.body.tools)).not.toContain('"strict"');
  });
});

describe("GLM flash relayed stream", () => {
  it("cures a tool call's stitched CR in the stream it relays", async () => {
    const chunk =
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{\\"a\\":\\"x\\\\ry\\"}"}}]}}]}\n\n';
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: `${chunk}data: [DONE]\n\n`,
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "glm-5.3-flash" }],
          },
        ],
      }),
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/glm-5.3-flash",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.startsWith("data: {"));
    expect(line).toBeDefined();
    const event = JSON.parse((line ?? "").slice("data: ".length)) as {
      choices: Array<{
        delta: { tool_calls: Array<{ function: { arguments: string } }> };
      }>;
    };
    expect(event.choices[0]?.delta.tool_calls[0]?.function.arguments).toBe('{"a":"xy"}');
    expect(text).toContain("data: [DONE]");
  });
});

describe("Chat relay tidy", () => {
  it("mends empty reasoning, finish reasons and tool_calls lists it relays", async () => {
    const chunk = (delta: Record<string, unknown>, finish: unknown): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        chunk({ role: "assistant", reasoning_content: "The user" }, "") +
        chunk({ content: "Hi", reasoning_content: "", tool_calls: [] }, "") +
        chunk({ content: "!", reasoning_content: "" }, "stop") +
        "data: [DONE]\n\n",
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "k",
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/m",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const text = await response.text();

    expect(text).not.toContain('"reasoning_content":""');
    expect(text).not.toContain('"finish_reason":""');
    expect(text).toContain('"reasoning_content":"The user"');
    expect(text).toContain('"finish_reason":null');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("data: [DONE]");
  });
});

describe("written calls relayed", () => {
  it("makes a call written into a Chat stream's text real", async () => {
    const chunk = (text: string): string =>
      `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      })}\n\n`;
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        chunk('先看看。<tool_call>{"name":"bash","arguments":{"command":"ls"}}') +
        chunk("</tool_call>") +
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n` +
        "data: [DONE]\n\n",
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
      }),
    });

    const text = await response.text();
    expect(text).toContain("先看看。");
    expect(text).toContain('"name":"bash"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain("tool_call>");
  });

  it("makes a call written into a whole Messages reply real", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: '前文<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
          },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await postMessages(gateway, {
      model: "local/model-a",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash", input_schema: { type: "object" } }],
    });

    const body = (await response.json()) as {
      content: Array<{ type: string; text?: string; name?: string }>;
      stop_reason: string;
    };
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0]).toMatchObject({ type: "text", text: "前文" });
    expect(body.content[1]).toMatchObject({ type: "tool_use", name: "bash" });
  });
});

describe("a reply stuck in a loop", () => {
  it("ends the relayed stream with an error the agent can act on", async () => {
    const cycle = ["Now.", "Writing.", "Go.", "Let me write.", "OK.", "Here.", "Produce."];
    let text = "";
    for (let index = 0; index < 300; index += 1) {
      text += `${cycle[index % cycle.length]}\n\n`;
    }
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: text } }],
      })}\n\ndata: [DONE]\n\n`,
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const body = await response.text();
    expect(body).toContain("Neox ended this reply");
    expect(body).toContain('"type":"server_error"');
    // What came of the reply goes first, then the stream's error.
    expect(body.indexOf("Neox ended this reply")).toBeGreaterThan(body.indexOf('"content"'));
  });
});

describe("a conversation stuck in a tool loop", () => {
  it("answers the turn here and sends it nowhere", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));
    const messages: Array<Record<string, unknown>> = [{ role: "user", content: "go" }];
    for (let index = 0; index < 8; index += 1) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${index}`,
            type: "function",
            function: { name: "bash", arguments: '{"command":"ls"}' },
          },
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: `call_${index}`,
        content: "same output",
      });
    }

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", messages }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toContain("Neox stopped this turn");
    expect(upstream.requests).toHaveLength(0);
  });
});

describe("what a reply's model says", () => {
  const reply = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "model-a",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("names the member that answered", async () => {
    const upstream = await startUpstream({ status: 200, body: reply });
    const gateway = await startGateway(
      baseConfig(upstream, {
        replyModel: "member",
        middleware: { aliases: { fast: "local/model-a" }, overrides: [] },
      }),
    );

    const body = (await (await postMessages(gateway, { model: "fast", messages: [] })).json()) as {
      model: string;
    };
    expect(body.model).toBe("local/model-a");
  });

  it("keeps the vendor's own text", async () => {
    const upstream = await startUpstream({ status: 200, body: reply });
    const gateway = await startGateway(
      baseConfig(upstream, {
        replyModel: "vendor",
        middleware: { aliases: { fast: "local/model-a" }, overrides: [] },
      }),
    );

    const body = (await (await postMessages(gateway, { model: "fast", messages: [] })).json()) as {
      model: string;
    };
    expect(body.model).toBe("model-a");
  });

  it("names the member in a translated reply", async () => {
    const upstream = await startUpstream({ status: 200, body: reply });
    const gateway = await startGateway(baseConfig(upstream, { replyModel: "member" }));

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a", messages: [] }),
    });
    const body = (await response.json()) as { model: string };
    expect(body.model).toBe("local/model-a");
  });

  it("names the member in a relayed stream", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"model-a"}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        replyModel: "member",
        middleware: { aliases: { fast: "local/model-a" }, overrides: [] },
      }),
    );

    const response = await postMessages(gateway, { model: "fast", stream: true, messages: [] });
    const text = await response.text();
    expect(text).toContain('"model":"local/model-a"');
    expect(text).not.toContain('"model":"model-a"');
  });
});

describe("a translated reply stuck in a loop", () => {
  it("ends the stream with the loop's error, as the relayed path does", async () => {
    const cycle = ["Now.", "Writing.", "Go.", "Let me write.", "OK.", "Here.", "Produce."];
    let text = "";
    for (let index = 0; index < 300; index += 1) {
      text += `${cycle[index % cycle.length]}\n\n`;
    }
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_1", model: "model-a" },
        })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })}\n\n` +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const body = await response.text();
    expect(body).toContain("Neox ended this reply");
    expect(body).toContain('"type":"server_error"');
    expect(body.indexOf("Neox ended this reply")).toBeGreaterThan(body.indexOf("Now."));
  });
});

describe("a Chat call that came with no id", () => {
  it("is given one before the request goes upstream", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({ id: "c1", choices: [{ message: { content: "ok" } }] }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );

    await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            tool_calls: [{ type: "function", function: { name: "bash", arguments: "{}" } }],
          },
          { role: "tool", content: "ok" },
        ],
      }),
    });

    const sent = upstream.requests[0]?.body as {
      messages: Array<{ tool_calls?: Array<{ id?: string }>; tool_call_id?: string }>;
    };
    const id = sent.messages[1]?.tool_calls?.[0]?.id;
    expect(typeof id).toBe("string");
    expect(sent.messages[2]?.tool_call_id).toBe(id);
  });
});

describe("a translated stream that ends normally", () => {
  it("ends the client's response", async () => {
    const upstream = await startUpstream({
      status: 200,
      contentType: "text/event-stream",
      body:
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { id: "msg_1", model: "model-a" },
        })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        })}\n\n` +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const body = await response.text();
    expect(body).toContain("hello");
    expect(body).toContain("data: [DONE]");
  });
});

describe("Claude Code request shapes", () => {
  afterEach(() => {
    resetAnthropicShapes();
  });

  it("mends two shapes named one after the other in one turn", async () => {
    let calls = 0;
    const upstream = await startDynamicUpstream(() => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 400,
          body: JSON.stringify({
            type: "error",
            error: {
              message: "Failed to deserialize the JSON body: messages[0]: missing field `content`",
            },
          }),
        };
      }
      if (calls === 2) {
        return {
          status: 400,
          body: JSON.stringify({
            type: "error",
            error: { message: "messages.1.output_config: Extra inputs are not permitted" },
          }),
        };
      }
      return {
        status: 200,
        body: JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      };
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "pool",
            protocol: "anthropic",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "key",
            models: [{ id: "m" }],
          },
        ],
      }),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "pool/m",
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                content: [{ type: "tool_reference", tool_name: "grep" }],
              },
            ],
          },
          { role: "system", content: "", output_config: { effort: "high" } },
          { role: "user", content: "go" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({ content: [{ type: "text", text: "ok" }] }),
    );
    expect(upstream.requests).toHaveLength(3);
    expect(JSON.stringify(upstream.requests[0]?.body.messages)).toContain("tool_reference");
    expect(JSON.stringify(upstream.requests[1]?.body.messages)).toContain(
      "Tool grep is loaded and can be called now.",
    );
    expect(JSON.stringify(upstream.requests[2]?.body.messages)).not.toContain("output_config");
  });
});

describe("the request archive", () => {
  it("keeps an Ollama call, upstream wires and all", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "model-a",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    });
    const gateway = await startGateway(baseConfig(upstream, { archive: { local: true } }));

    const response = await fetch(`${gateway.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    await gateway.archive.dispose();

    const root = path.join(gateway.neolixHome, "request-archive");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((name) =>
      name.endsWith(".json"),
    );
    const records = files.map(
      (name) =>
        JSON.parse(readFileSync(path.join(root, name), "utf8")) as {
          request: { path: string };
          upstream?: unknown[];
        },
    );
    const kept = records.find((record) => record.request.path === "/api/chat");
    expect(kept).toBeDefined();
    expect(kept?.upstream?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("provider fallbacks and caps", () => {
  const reply = JSON.stringify({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it("goes on to a provider's fallback once its own candidates fail", async () => {
    const primary = await startUpstream({
      status: 500,
      body: JSON.stringify({ error: { message: "down" } }),
    });
    const fallback = await startUpstream({ status: 200, body: reply });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "local",
          protocol: "anthropic",
          baseUrl: `${primary.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "model-a" }],
          fallback: ["other/model-b"],
        },
        {
          id: "other",
          protocol: "anthropic",
          baseUrl: `${fallback.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "model-b" }],
        },
      ],
    });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(primary.requests.length).toBeGreaterThan(0);
    expect(fallback.requests).toHaveLength(1);
  });

  it("answers 429 at a provider's caps instead of its fallback", async () => {
    const primary = await startUpstream({ status: 200, body: reply });
    const fallback = await startUpstream({ status: 200, body: reply });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "local",
          protocol: "anthropic",
          baseUrl: `${primary.url}/v1`,
          models: [{ id: "model-a" }],
          accounts: [{ id: "one", capPercent: 90 }],
          stopAtCap: true,
          fallback: ["other/model-b"],
        },
        {
          id: "other",
          protocol: "anthropic",
          baseUrl: `${fallback.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "model-b" }],
        },
      ],
    });
    gateway.runtime.accountState.usage.set("local/one", {
      remaining: null,
      limit: null,
      usedPercent: 95,
      resetAt: null,
      readAt: Date.now(),
    });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(429);
    expect(primary.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(0);
  });
});

describe("deferred tools on a Responses upstream", () => {
  const responsesReply = JSON.stringify({
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const anthropicRequest = JSON.stringify({
    model: "local/model-a",
    max_tokens: 16,
    messages: [
      { role: "user", content: "find a tool" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "tool_search", input: { query: "shell" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "tool_reference", tool_name: "shell" }],
          },
        ],
      },
    ],
    tools: [
      {
        name: "shell",
        description: "run",
        input_schema: { type: "object" },
        defer_loading: true,
      },
    ],
  });

  it("offers a loaded tool in an additional_tools item when the provider takes one", async () => {
    const upstream = await startUpstream({ status: 200, body: responsesReply });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "local",
          protocol: "openai-responses",
          baseUrl: `${upstream.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "model-a" }],
          additionalTools: "on",
        },
      ],
    });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: anthropicRequest,
    });
    expect(response.status).toBe(200);
    const sent = upstream.requests[0]?.body as {
      input?: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
    };
    const loaded = sent.input?.find((item) => item.type === "additional_tools");
    expect(loaded?.tools).toMatchObject([{ type: "function", name: "shell" }]);
    expect(sent.tools?.some((tool) => tool.name === "shell") ?? false).toBe(false);
  });

  it("puts a loaded tool back in the top-level tools when additional tools are off", async () => {
    const upstream = await startUpstream({ status: 200, body: responsesReply });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "local",
          protocol: "openai-responses",
          baseUrl: `${upstream.url}/v1`,
          apiKey: "upstream-key",
          models: [{ id: "model-a" }],
          additionalTools: "off",
        },
      ],
    });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: anthropicRequest,
    });
    expect(response.status).toBe(200);
    const sent = upstream.requests[0]?.body as {
      input?: Array<Record<string, unknown>>;
      tools?: Array<Record<string, unknown>>;
    };
    expect(sent.input?.some((item) => item.type === "additional_tools") ?? false).toBe(false);
    expect(sent.tools?.some((tool) => tool.name === "shell") ?? false).toBe(true);
  });
});

describe("Copilot Auto refusals", () => {
  interface AutoPickReply {
    model: string;
    token?: string;
    endpoints?: string[];
  }

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** A fetch standing in for Copilot's /auto and /models/session. */
  function autoFetch(picks: readonly AutoPickReply[]): typeof fetch {
    let index = 0;
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (!url.endsWith("/auto") && !url.endsWith("/models/session")) {
        return jsonResponse({}, 404);
      }
      const pick = picks[Math.min(index, picks.length - 1)];
      index += 1;
      return jsonResponse({
        selected_model: {
          id: pick?.model,
          ...(pick?.endpoints === undefined ? {} : { supported_endpoints: pick.endpoints }),
        },
        session_token: pick?.token ?? null,
      });
    }) as unknown as typeof fetch;
  }

  /** A Copilot sign-in kept for the gateway, its API pointed at `apiUrl`. */
  async function primeCopilotSignIn(gateway: GatewayServer, apiUrl: string): Promise<void> {
    const account: CopilotAccount = {
      agent: "copilot",
      id: "copilot:main",
      user: "dev@example.com",
      plan: null,
      addedAt: Date.now(),
      lapsed: null,
      githubToken: "github-token",
      host: "",
    };
    await saveSubscriptionAccounts(
      subscriptionAccountsFile(path.join(gateway.neolixHome, "gateway"), "copilot"),
      [account],
    );
    await subscriptionAuth(account, {
      fetchImpl: (async () =>
        jsonResponse({
          token: "copilot-session",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: apiUrl },
        })) as unknown as typeof fetch,
    });
  }

  async function startCopilotGateway(
    upstream: { url: string },
    auto: typeof fetch,
  ): Promise<GatewayServer> {
    return startGateway(
      {
        version: 1,
        enabled: true,
        keys: [],
        groups: [],
        providers: [
          {
            id: "copilot",
            protocol: "openai-responses",
            baseUrl: `${upstream.url}/v1`,
            accounts: [
              {
                id: "main",
                agent: "copilot",
                subscriptionUser: "dev@example.com",
                baseUrl: `${upstream.url}/v1`,
              },
            ],
            models: [{ id: "auto" }],
          },
        ],
      },
      { copilotFetch: auto },
    );
  }

  const responsesReply = JSON.stringify({
    id: "resp_1",
    object: "response",
    status: "completed",
    output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  function askAuto(gateway: GatewayServer): Promise<Response> {
    return fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "copilot/auto",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  }

  it("asks Auto again for another model when Copilot refuses the pick", async () => {
    clearCopilotAutoPicks();
    clearCopilotSessions();
    const upstream = await startReplying([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: "model_not_supported", message: "The requested model is not supported." },
        }),
      },
      { status: 200, body: responsesReply },
    ]);
    const gateway = await startCopilotGateway(
      upstream,
      autoFetch([{ model: "bad" }, { model: "good" }]),
    );
    await primeCopilotSignIn(gateway, upstream.url);

    const response = await askAuto(gateway);

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.body.model).toBe("good");
  });

  it("asks Auto again with a new session when the token no longer holds the model", async () => {
    clearCopilotAutoPicks();
    clearCopilotSessions();
    const upstream = await startReplying([
      {
        status: 400,
        body: JSON.stringify({ error: { message: "Requested model not available for session" } }),
      },
      { status: 200, body: responsesReply },
    ]);
    const gateway = await startCopilotGateway(
      upstream,
      autoFetch([
        { model: "bad", token: "session-one" },
        { model: "good", token: "session-two" },
      ]),
    );
    await primeCopilotSignIn(gateway, upstream.url);

    const response = await askAuto(gateway);

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.body.model).toBe("good");
    expect(upstream.requests[1]?.headers["copilot-session-token"]).toBe("session-two");
  });

  it("asks the same pick on the model's next endpoint when that one refuses it", async () => {
    clearCopilotAutoPicks();
    clearCopilotSessions();
    const upstream = await startReplying([
      {
        status: 400,
        body: JSON.stringify({
          error: { message: "model is not accessible via the /responses endpoint" },
        }),
      },
      {
        status: 200,
        body: JSON.stringify({
          id: "chat_1",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      },
    ]);
    const gateway = await startCopilotGateway(
      upstream,
      autoFetch([{ model: "model-one", endpoints: ["/responses", "/chat/completions"] }]),
    );
    await primeCopilotSignIn(gateway, upstream.url);

    const response = await askAuto(gateway);

    expect(response.status).toBe(200);
    expect(upstream.requests).toHaveLength(2);
    expect(upstream.requests[1]?.url).toContain("/chat/completions");
    expect(upstream.requests[1]?.body.model).toBe("model-one");
  });
});

describe("usage report fields", () => {
  it("records the host, effort, kind, tier and credits of a served turn", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "chat_1",
        object: "chat.completion",
        service_tier: "flex",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, credit: 7 },
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );
    const rows: UsageRecord[] = [];
    gateway.ledger.onRecord = (record) => rows.push(record);

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "review" },
      body: JSON.stringify({
        model: "local/model-a",
        service_tier: "priority",
        reasoning_effort: "high",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    await gateway.ledger.flush();

    expect(rows.at(-1)).toMatchObject({
      host: "127.0.0.1",
      effort: "high",
      kind: "review",
      providerKeyId: "default",
      endpoint: "/v1/chat/completions",
      tierAsked: "priority",
      tierSent: "priority",
      tierServed: "flex",
      upstreamStop: "end_turn",
      credits: 7,
    });
  });

  it("records a refusal's own words", async () => {
    const upstream = await startUpstream({
      status: 403,
      body: JSON.stringify({ error: { type: "server_error", message: "the vendor broke" } }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "local",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            apiKey: "upstream-key",
            models: [{ id: "model-a" }],
          },
        ],
      }),
    );
    const rows: UsageRecord[] = [];
    gateway.ledger.onRecord = (record) => rows.push(record);

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "local/model-a",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(502);
    await gateway.ledger.flush();

    expect(rows.at(-1)).toMatchObject({
      errorType: "server_error",
      errorMessage: "the vendor broke",
    });
  });
});

describe("gateway aliases and metadata", () => {
  it("answers the bare /models path and a myna-style 404 for an unknown gateway path", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const listed = await fetch(`${gateway.url}/models`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);

    // "/" is the daemon's own route, so the gateway's fallback covers only
    // the paths it owns (myna serves the gateway on a port of its own).
    const unknown = await fetch(`${gateway.url}/v1/unknown`);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as Record<string, unknown>).toMatchObject({
      error: { type: "not_found_error" },
    });
  });

  it("answers OPTIONS for the Omarchy theme to the site's page", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1/myna/omarchy`, {
      method: "OPTIONS",
      headers: { origin: "https://github.com/istoo/myna" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("GET");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://github.com/istoo/myna",
    );
  });

  it("counts tokens for Gemini's countTokens method", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/v1beta/models/local/model-a:countTokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello there" }] }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { totalTokens: number };
    expect(body.totalTokens).toBeGreaterThan(0);
    expect(upstream.requests).toHaveLength(0);
  });

  it("serves the remote quota cards and names the daemon version", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const cards = await fetch(`${gateway.url}/v1/myna/quotas/cards`);
    expect(cards.status).toBe(200);
    expect((await cards.json()) as Record<string, unknown>).toMatchObject({
      accounts: expect.any(Array),
    });

    const hello = (await (await fetch(`${gateway.url}/api/hello`)).json()) as {
      version: string;
    };
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("Ollama API", () => {
  it("answers a version every Ollama client takes", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const response = await fetch(`${gateway.url}/api/version`);
    const body = (await response.json()) as { version: string };

    // VS Code's Copilot refuses a server older than 0.6.4.
    const [major = 0, minor = 0, patch = 0] = body.version.split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(6_004);
  });

  it("lists and shows a model as Ollama's own API does", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" });
    const gateway = await startGateway(baseConfig(upstream));

    const tags = await fetch(`${gateway.url}/api/tags`);
    const listed = (await tags.json()) as {
      models: Array<Record<string, unknown>>;
    };
    expect(listed.models[0]).toMatchObject({
      name: "local/model-a",
      model: "local/model-a",
      size: 0,
      details: { family: "myna" },
      capabilities: ["completion", "tools"],
    });
    expect(String(listed.models[0]?.digest)).toMatch(/^[0-9a-f]{64}$/);

    const show = await fetch(`${gateway.url}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "local/model-a:latest" }),
    });
    const shown = (await show.json()) as Record<string, unknown>;
    expect(shown).toMatchObject({
      modelfile: "",
      details: { family: "myna" },
      model_info: {
        "general.architecture": "myna",
        "general.parameter_count": 0,
        "myna.context_length": 32768,
        "myna.embedding_length": 0,
      },
      capabilities: ["completion", "tools"],
    });
  });
});

describe("Factory wires and model preferences", () => {
  it("sends each Factory model on the wire droid lists", () => {
    const config = baseConfig(
      { url: "http://127.0.0.1:1" },
      {
        providers: [
          {
            id: "factory",
            protocol: "openai",
            baseUrl: "https://api.factory.ai",
            accounts: [{ id: "main", agent: "factory" }],
            models: [
              { id: "claude-opus-5-5" },
              { id: "gpt-5.5" },
              { id: "glm-5.3" },
              { id: "gemini-3.8-flash" },
            ],
          },
        ],
      },
    );
    const candidate = (model: string) => {
      const found = resolveGatewayCandidates(config, `factory/${model}`)[0];
      if (found === undefined) {
        throw new Error(`Missing candidate for ${model}`);
      }
      return found;
    };

    expect(candidate("claude-opus-5-5").provider.protocol).toBe("anthropic");
    expect(candidate("gpt-5.5").provider.protocol).toBe("openai-responses");
    expect(candidate("glm-5.3").provider.protocol).toBe("openai");
    expect(candidate("gemini-3.8-flash").provider.protocol).toBe("gemini");
    expect(buildUpstreamUrl(candidate("claude-opus-5-5").provider, "claude-opus-5-5", false)).toBe(
      "https://api.factory.ai/v1/messages",
    );
    expect(buildUpstreamUrl(candidate("gpt-5.5").provider, "gpt-5.5", false)).toBe(
      "https://api.factory.ai/v1/responses",
    );
    expect(buildUpstreamUrl(candidate("glm-5.3").provider, "glm-5.3", false)).toBe(
      "https://api.factory.ai/v1/chat/completions",
    );
    expect(
      buildUpstreamUrl(candidate("gemini-3.8-flash").provider, "gemini-3.8-flash", false),
    ).toBe("https://api.factory.ai/api/llm/g/v1/generate");

    // A model droid's list doesn't name is tried on all three wires in
    // turn (myna's factoryAPIs order).
    const unknownConfig = baseConfig(
      { url: "http://127.0.0.1:1" },
      {
        providers: [
          {
            id: "factory",
            protocol: "openai",
            baseUrl: "https://api.factory.ai",
            accounts: [{ id: "main", agent: "factory" }],
            models: [{ id: "not-in-droid-wires" }],
          },
        ],
      },
    );
    expect(
      resolveGatewayCandidates(unknownConfig, "factory/not-in-droid-wires").map(
        (entry) => entry.provider.protocol,
      ),
    ).toEqual(["anthropic", "openai-responses", "openai"]);
  });

  it("tries a Factory model on the next wire when one doesn't serve it", async () => {
    const upstream = await startReplying([
      { status: 404, body: '{"error":{"message":"not here"}}' },
      { status: 404, body: '{"error":{"message":"not here"}}' },
      {
        status: 200,
        body: JSON.stringify({
          id: "r1",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        }),
      },
    ]);
    const gateway = await startGateway(
      baseConfig(
        { url: upstream.url },
        {
          providers: [
            {
              id: "factory",
              protocol: "openai",
              baseUrl: upstream.url,
              accounts: [{ id: "main", agent: "factory", subscriptionUser: "dev@example.com" }],
              models: [{ id: "not-in-droid-wires" }],
            },
          ],
        },
      ),
    );
    const account: FactorySubscriptionAccount = {
      agent: "factory",
      id: "factory:main",
      user: "dev@example.com",
      plan: null,
      addedAt: Date.now(),
      lapsed: null,
      key: "fk-retry-21180433",
      orgId: null,
      region: null,
      prem: upstream.url,
    };
    await saveSubscriptionAccounts(
      subscriptionAccountsFile(path.join(gateway.neolixHome, "gateway"), "factory"),
      [account],
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "factory/not-in-droid-wires",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests.map((request) => request.url)).toEqual([
      "/v1/messages",
      "/v1/responses",
      "/v1/chat/completions",
    ]);
  });

  it("puts a Codex subagent on its lead's model when set to lead", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(baseConfig(upstream, { codexSubagentModel: "lead" }));
    const lead = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "lead-thread" }),
      },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "lead" }],
      }),
    });
    await lead.text();

    const subagent = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
        "x-codex-turn-metadata": JSON.stringify({ parent_thread_id: "lead-thread" }),
      },
      body: JSON.stringify({
        model: "local/model-b",
        max_tokens: 16,
        messages: [{ role: "user", content: "task" }],
      }),
    });
    expect(subagent.status).toBe(200);
    expect(upstream.requests.map((request) => request.body.model)).toEqual(["model-a", "model-a"]);
  });

  it("leaves a subagent on its model when its task was sealed", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { codexSubagentModel: "local/model-b" }),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
      },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "task" }],
        input: [
          {
            type: "agent_message",
            content: [{ type: "encrypted_content", encrypted_content: "gAAAAAsealed-task" }],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.model).toBe("model-a");
  });

  it("leaves a subagent on its model when the key may not use the one set", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, {
        keys: [{ key: "team", models: ["local/model-a"] }],
        codexSubagentModel: "local/model-b",
      }),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer team",
        originator: "codex_cli_rs",
        "x-openai-subagent": "collab_spawn",
      },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "task" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.model).toBe("model-a");
  });

  it("resolves a listed model id and asks the vendor by its wire name", () => {
    const config = baseConfig(
      { url: "http://127.0.0.1:1" },
      {
        modelIDs: { "local/listed": "model-a" },
        modelWires: { "local/model-a": "vendor-c/sol" },
      },
    );

    const listed = resolveGatewayCandidates(config, "local/listed")[0];
    expect(listed?.model.id).toBe("model-a");
    expect(listed?.model.upstreamName).toBe("vendor-c/sol");

    const bare = resolveGatewayCandidates(config, "listed")[0];
    expect(bare?.model.id).toBe("model-a");
  });

  it("sends the wire name the user set to the vendor", async () => {
    const upstream = await startUpstream({
      status: 200,
      body: JSON.stringify({
        id: "r1",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    });
    const gateway = await startGateway(
      baseConfig(upstream, {
        providers: [
          {
            id: "relay",
            protocol: "openai",
            baseUrl: `${upstream.url}/v1`,
            models: [{ id: "vendor-model" }],
          },
        ],
        modelIDs: { "relay/listed": "vendor-model" },
        modelWires: { "relay/vendor-model": "vendor-c/sol" },
      }),
    );

    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "relay/listed",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.model).toBe("vendor-c/sol");
  });

  it("puts a Codex subagent's task on the model the user set", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway(
      baseConfig(upstream, { codexSubagentModel: "local/model-b" }),
    );

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openai-subagent": "collab_spawn",
        originator: "codex_cli_rs",
      },
      body: JSON.stringify({
        model: "local/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "task" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(upstream.requests[0]?.body.model).toBe("model-b");
  });
});

describe("Codex credits last", () => {
  it("asks a fallback before an account that spends its credits last", async () => {
    const primary = await startUpstream({ status: 200, body: '{"ok":true}' });
    const backup = await startUpstream({ status: 200, body: '{"ok":true}' });
    const gateway = await startGateway({
      version: 1,
      enabled: true,
      keys: [],
      groups: [],
      providers: [
        {
          id: "primary",
          protocol: "anthropic",
          baseUrl: `${primary.url}/v1`,
          accounts: [{ id: "sub", creditsMode: "last" }],
          fallback: ["backup/model-c"],
          models: [{ id: "model-a" }],
        },
        {
          id: "backup",
          protocol: "anthropic",
          baseUrl: `${backup.url}/v1`,
          models: [{ id: "model-c" }],
        },
      ],
    });
    gateway.runtime.accountState.usage.set("primary/sub", {
      remaining: 0,
      limit: 100,
      usedPercent: 100,
      resetAt: null,
      readAt: 0,
    });

    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "primary/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(200);
    expect(primary.requests).toHaveLength(0);
    expect(backup.requests).toHaveLength(1);
  });
});
