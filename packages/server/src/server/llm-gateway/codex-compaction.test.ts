import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import {
  CODEX_COMPACT_PROMPT,
  CODEX_SUMMARY_PREFIX,
  encryptedSummary,
  localCompactionTurn,
  rewriteCodexInput,
  summaryMessage,
} from "./codex-compaction.js";
import { createGatewayRouter } from "./routes.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });

interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface TestServer {
  url: string;
  requests: RecordedRequest[];
}

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

function listen(app: express.Express): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

function upstreamServer(reply: { status: number; body: string }): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    requests.push({ url: req.originalUrl, headers: req.headers, body: req.body });
    res.status(reply.status).setHeader("content-type", "application/json");
    res.end(reply.body);
  });
  return listen(app).then((server) => ({ url: server.url, requests }));
}

function dynamicUpstream(
  reply: (body: Record<string, unknown>) => { status: number; body: string },
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, res) => {
    const record = { url: req.originalUrl, headers: req.headers, body: req.body };
    requests.push(record);
    const answer = reply(req.body);
    res.status(answer.status).setHeader("content-type", "application/json");
    res.end(answer.body);
  });
  return listen(app).then((server) => ({ url: server.url, requests }));
}

function responsesReply(text: string, status = "completed"): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      id: "r1",
      object: "response",
      status,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
  };
}

async function gatewayServer(config: GatewayConfig): Promise<TestServer> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-codex-"));
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  const ledger = new UsageLedger({ neolixHome, logger });
  await ledger.start();
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker: new Masker({
        neolixHome,
        logger,
        allow: () => [],
        actions: () => ({}),
        shape: () => false,
      }),
      ledger,
      logger,
    }),
  );
  return listen(app);
}

function providerConfig(
  url: string,
  overrides: Partial<GatewayConfig["providers"][number]>,
): GatewayConfig["providers"][number] {
  return {
    id: "fake",
    protocol: "anthropic",
    baseUrl: `${url}/v1`,
    apiKey: "upstream-key",
    models: [{ id: "m1" }],
    ...overrides,
  };
}

function fixture(): { body: Record<string, unknown>; turn: string } {
  const raw = readFileSync(new URL("./testdata/codex-26.1007-compaction.json", import.meta.url));
  const body = JSON.parse(raw.toString("utf8")) as {
    client_metadata: Record<string, string>;
  } & Record<string, unknown>;
  return { body, turn: body.client_metadata["x-codex-turn-metadata"] ?? "" };
}

/** myna's compact404Request: a conversation with ids and a tool call in it. */
function compactionRequest(): Record<string, unknown> {
  return {
    model: "fake/m1",
    stream: true,
    store: false,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "fix the login bug" }],
      },
      { type: "reasoning", id: "rs_1", summary: [] },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "shell",
        arguments: '{"cmd":"ls"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "main.go" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I fixed main.go" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "now add a test" }] },
      { type: "compaction_trigger" },
    ],
  };
}

function compactionItem(response: string): { id: string; encrypted_content: string } {
  for (const line of response.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const event = JSON.parse(line.slice("data:".length)) as {
      type?: string;
      response?: { output?: { id: string; encrypted_content: string }[] };
    };
    if (event.type === "response.completed") {
      const item = event.response?.output?.[0];
      if (item !== undefined) {
        return item;
      }
    }
  }
  throw new Error(`no compaction item in: ${response.slice(0, 400)}`);
}

describe("Codex summaries", () => {
  it("reads the gateway's summary back as Codex's own summary message", () => {
    const read = summaryMessage(encryptedSummary("done: a, b"));
    expect(read.ours).toBe(true);
    expect(read.message).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${CODEX_SUMMARY_PREFIX}\ndone: a, b` }],
    });
  });

  it("leaves another vendor's compaction item alone", () => {
    expect(summaryMessage("gAAAAABopaque==")).toEqual({ ours: false, message: null });
  });

  it("leaves out a summary it cannot read", () => {
    expect(summaryMessage("neolix1:%%%")).toEqual({ ours: true, message: null });
  });

  it("makes Codex's remote compaction say it is local", () => {
    const cases: [string, string, boolean][] = [
      [
        '{"request_kind":"compaction","compaction":{"trigger":"auto","implementation":"responses_compaction_v2","phase":"pre_turn"},"source":"codex"}',
        '{"request_kind":"compaction","compaction":{"trigger":"auto","implementation":"responses","phase":"pre_turn"},"source":"codex"}',
        true,
      ],
      [
        '{"compaction":{"implementation":"responses"}}',
        '{"compaction":{"implementation":"responses"}}',
        false,
      ],
      [
        '{"request_kind":"turn","source":"codex"}',
        '{"request_kind":"turn","source":"codex"}',
        false,
      ],
      ['{"compaction":{"trigger":"manual"}}', '{"compaction":{"trigger":"manual"}}', false],
      ['{"compaction":', '{"compaction":', false],
      ["", "", false],
    ];
    for (const [input, meta, changed] of cases) {
      expect(localCompactionTurn(input)).toEqual({ meta, changed });
    }
  });

  it("turns the trigger into a summary ask and leaves reasoning out", () => {
    const rewrite = rewriteCodexInput(
      {
        model: "fake/m1",
        input: [
          { type: "reasoning", content: [{ type: "summary_text", text: "thought" }] },
          { type: "compaction_trigger" },
          { type: "additional_tools", tools: [] },
        ],
        tools: [{ type: "function", name: "run" }],
        client_metadata: {
          "x-codex-turn-metadata": '{"compaction":{"implementation":"responses_compaction_v2"}}',
          thread_id: "t1",
        },
      },
      false,
    );
    expect(rewrite.compact).toBe(true);
    expect(rewrite.body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: CODEX_COMPACT_PROMPT }],
      },
    ]);
    expect(rewrite.body.tools).toEqual([]);
    expect(rewrite.body.tool_choice).toBe("auto");
    expect(rewrite.body.parallel_tool_calls).toBe(false);
    expect(rewrite.body.client_metadata).toEqual({
      "x-codex-turn-metadata": '{"compaction":{"implementation":"responses"}}',
      thread_id: "t1",
    });
  });

  it("keeps the trigger and the reasoning when the provider compacts natively", () => {
    const rewrite = rewriteCodexInput(
      {
        model: "fake/m1",
        input: [{ type: "compaction_trigger" }, { type: "reasoning", encrypted_content: "SEALED" }],
      },
      true,
    );
    expect(rewrite.compact).toBe(false);
    expect(rewrite.changed).toBe(false);
    expect(rewrite.body.input).toEqual([
      { type: "compaction_trigger" },
      { type: "reasoning", encrypted_content: "SEALED" },
    ]);
  });
});

describe("POST /v1/responses compaction", () => {
  it("summarises a compaction for a model that cannot carry Codex's own", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: JSON.stringify({
        id: "r1",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "SUMMARY" }],
          },
        ],
      }),
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, { protocol: "openai-responses" })],
      groups: [],
    });
    const { body, turn } = fixture();

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": turn },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    const item = compactionItem(text);
    expect(Buffer.from(item.encrypted_content.slice("neolix1:".length), "base64").toString()).toBe(
      "SUMMARY",
    );

    const sent = upstream.requests[0];
    expect(sent).toBeDefined();
    const raw = JSON.stringify(sent?.body);
    expect(raw).not.toContain("compaction_trigger");
    expect(raw).toContain("CONTEXT CHECKPOINT COMPACTION");
    // The Responses request the gateway builds offers no tools at all: the
    // summary ask offers none, so no model can answer it with a tool call.
    expect(sent?.body.tools).toEqual([]);
    const metadata = sent?.body.client_metadata as Record<string, string>;
    const rewritten = localCompactionTurn(turn).meta;
    expect(metadata["x-codex-turn-metadata"]).toBe(rewritten);
    expect(metadata.thread_id).toBe(JSON.parse(turn).thread_id);
    expect(sent?.headers["x-codex-turn-metadata"]).toBe(rewritten);
  });

  it("restores the gateway's summary as a message on the next turn", async () => {
    const upstream = await upstreamServer({ status: 200, body: '{"ok":true}' });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, { id: "fake" })],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fake/m1",
        input: [
          {
            type: "compaction",
            id: "cmp_1",
            encrypted_content: encryptedSummary("what came before"),
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const sent = JSON.stringify(upstream.requests[0]?.body);
    expect(sent).toContain(CODEX_SUMMARY_PREFIX.replace(/\n/g, "\\n"));
    expect(sent).toContain("what came before");
    expect(sent).toContain("go on");
    expect(sent).not.toContain("neolix1:");
  });

  it("asks again as text when the first summary request fails", async () => {
    const upstream = await dynamicUpstream((body) =>
      JSON.stringify(body).includes('"fc_1"')
        ? { status: 404, body: '{"error":{"message":"Upstream request failed"}}' }
        : responsesReply("SUMMARY"),
    );
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, { protocol: "openai-responses" })],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(compactionRequest()),
    });

    expect(response.status).toBe(200);
    const item = compactionItem(await response.text());
    expect(Buffer.from(item.encrypted_content.slice("neolix1:".length), "base64").toString()).toBe(
      "SUMMARY",
    );
    expect(upstream.requests).toHaveLength(2);
    const plain = JSON.stringify(upstream.requests[1]?.body);
    expect(plain).toContain("This is the conversation so far");
    expect(plain).toContain("now add a test");
    expect(plain).not.toContain('"fc_1"');
  });

  it("compacts without a model when the text request fails too", async () => {
    const upstream = await dynamicUpstream(() => ({
      status: 404,
      body: '{"error":{"message":"Upstream request failed"}}',
    }));
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, { protocol: "openai-responses" })],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(compactionRequest()),
    });

    expect(response.status).toBe(200);
    const item = compactionItem(await response.text());
    const summary = Buffer.from(
      item.encrypted_content.slice("neolix1:".length),
      "base64",
    ).toString();
    for (const want of [
      "fix the login bug",
      "now add a test",
      "I fixed main.go",
      "404",
      "Upstream request failed",
    ]) {
      expect(summary).toContain(want);
    }
    expect(summary).not.toContain("CONTEXT CHECKPOINT COMPACTION");
  });

  it("sends an auth failure back without asking again", async () => {
    const upstream = await dynamicUpstream(() => ({
      status: 401,
      body: '{"error":{"message":"nope"}}',
    }));
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, { protocol: "openai-responses" })],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(compactionRequest()),
    });

    // The gateway's own failover turns the provider's 401 into its 502; what
    // matters here is that it is sent back without the text retry.
    expect(response.status).toBe(502);
    expect(upstream.requests).toHaveLength(1);
  });

  it("passes a native compaction through with its metadata untouched", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: JSON.stringify({
        id: "r1",
        object: "response",
        status: "completed",
        output: [{ type: "compaction", id: "cmp_1", encrypted_content: "SEALED" }],
      }),
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [
        providerConfig(upstream.url, {
          protocol: "openai-responses",
          nativeCompaction: true,
        }),
      ],
      groups: [],
    });
    const { body, turn } = fixture();

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": turn },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("SEALED");
    const sent = upstream.requests[0];
    expect(JSON.stringify(sent?.body)).toContain("compaction_trigger");
    const metadata = sent?.body.client_metadata as Record<string, string>;
    expect(metadata["x-codex-turn-metadata"]).toBe(turn);
    expect(sent?.headers["x-codex-turn-metadata"]).toBe(turn);
  });

  it("refuses native compaction on a provider whose wire cannot carry it", async () => {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-codex-"));
    const store = new GatewayConfigStore({ neolixHome, logger });
    await expect(
      store.write({
        version: 1,
        enabled: true,
        providers: [
          {
            id: "fake",
            protocol: "anthropic",
            baseUrl: "https://example.test/v1",
            nativeCompaction: true,
            models: [{ id: "m1" }],
          },
        ],
      }),
    ).rejects.toThrow(
      "fake can't carry Codex's native compaction: only a provider with a Responses API can",
    );
  });
});

describe("Codex hidden turns", () => {
  it("shapes a title request's answer as the JSON Codex reads", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: '{"content":[{"type":"text","text":"  \\"Fix the bug\\"  "}]}',
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "thread_title" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        text: {
          format: {
            type: "json_schema",
            schema: {
              properties: { title: { type: "string", maxLength: 60 } },
              required: ["title"],
            },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Fix the bug");
    expect(text).toContain('\\"title\\"');
    expect(upstream.requests).toHaveLength(1);
  });

  it("shapes a composer prediction as {'suggestion'}", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: '{"content":[{"type":"text","text":"{\\"suggestion\\":\\"run the tests\\"}"}]}',
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "composer_predictions" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("run the tests");
  });

  it("shapes a description request's answer", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: '{"content":[{"type":"text","text":"A plain description"}]}',
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "thread_description" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('\\"description\\"');
  });

  it("reads a summary turn's kind from Codex's metadata", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: '{"content":[{"type":"text","text":"{\\"summary\\":\\"did things\\"}"}]}',
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        client_metadata: { "x-codex-turn-metadata": '{"thread_source":"thread_summary"}' },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("did things");
  });

  it("answers a title request with none when titles are off, sending it nowhere", async () => {
    const upstream = await upstreamServer({ status: 200, body: '{"ok":true}' });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      codexTitles: "off",
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "thread_title" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    await response.text();
    expect(upstream.requests).toHaveLength(0);
  });

  it("sends a title request to the model its setting names", async () => {
    const upstream = await upstreamServer({
      status: 200,
      body: '{"content":[{"type":"text","text":"A title"}]}',
    });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      codexTitles: "fake/other",
      providers: [
        providerConfig(upstream.url, {
          models: [{ id: "m1" }, { id: "other" }],
        }),
      ],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "thread_title" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("A title");
    expect(upstream.requests[0]?.body.model).toBe("other");
  });

  it("answers a prediction with none when predictions are off", async () => {
    const upstream = await upstreamServer({ status: 200, body: '{"ok":true}' });
    const gateway = await gatewayServer({
      version: 1,
      enabled: true,
      keys: [],
      codexPredictions: "off",
      providers: [providerConfig(upstream.url, {})],
      groups: [],
    });

    const response = await fetch(`${gateway.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openai-subagent": "composer_predictions" },
      body: JSON.stringify({
        model: "fake/m1",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("suggestion");
    expect(upstream.requests).toHaveLength(0);
  });
});
