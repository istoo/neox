import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeBridge } from "./claude/bridge.js";
import { installFakeClaude } from "./claude/testing/fake-claude.js";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { createGatewayRuntime } from "./runtime.js";
import { SearchLedger } from "./search.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });
const cleanup: string[] = [];
const servers: Server[] = [];
const bridges: ClaudeBridge[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.abortAll();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const SCRIPT = `
while read -r line; do
  printf '%s\\n' \\
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"model-a","usage":{"input_tokens":3}}}}' \\
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from claude"}}}' \\
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}}' \\
    '{"type":"stream_event","event":{"type":"message_stop"}}'
done
`;

interface Gateway {
  url: string;
  dir: string;
}

async function startGateway(
  options: { masking?: boolean; script?: (dir: string) => string } = {},
): Promise<Gateway> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-gateway-"));
  cleanup.push(dir);
  const fake = await installFakeClaude(options.script?.(dir) ?? SCRIPT);
  cleanup.push(fake.dir);
  const config: GatewayConfig = {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "claude",
        protocol: "anthropic",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [{ id: "model-a" }],
        accounts: [{ id: "main", agent: "claude-code", enabled: true, weight: 1, priority: 0 }],
      },
    ],
    groups: [],
    ...(options.masking === true
      ? {
          masking: {
            enabled: true,
            allow: [],
            categories: [],
            actions: {},
            shape: false,
            categorySwitches: {},
            alert: false,
            rules: [],
          },
        }
      : {}),
  };
  await writeFile(path.join(dir, "gateway.json"), JSON.stringify(config));
  const store = new GatewayConfigStore({ neolixHome: dir, logger });
  await store.start();
  const masker = new Masker({
    neolixHome: dir,
    logger,
    allow: () => [],
    actions: () => ({}),
    shape: () => false,
    categorySwitches: () => ({}),
  });
  const ledger = new UsageLedger({ neolixHome: dir, logger });
  const searchLedger = new SearchLedger({ neolixHome: dir, logger });
  await searchLedger.start();
  const bridge = new ClaudeBridge({ resolveBinary: async () => fake.binary });
  bridges.push(bridge);
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker,
      ledger,
      logger,
      searchLedger,
      runtime: createGatewayRuntime(ledger),
      claude: {
        bridge,
        helperPath: "/tmp/mcp-helper.mjs",
        callbackBaseUrl: () => "http://127.0.0.1:1",
        claudeConfigDir: () => path.join(dir, "claude"),
        workDir: path.join(dir, "work"),
      },
    }),
  );
  return { ...(await listen(app)), dir };
}

function listen(app: express.Express): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}` });
    });
  });
}

const SECRET = "sk-live-abcdEFGH12345678ijklMNOP";

/** A reply that says the placeholder it was sent, so masking can be checked. */
const maskingScript = (dir: string): string => `
while read -r line; do
  printf '%s' "$line" > ${JSON.stringify(path.join(dir, "input"))}
  token=$(printf '%s' "$line" | grep -o '{{API_KEY_[0-9a-f]*}}' | head -1)
  printf '%s\\n' \\
    '{"type":"stream_event","event":{"type":"message_start","message":{"id":"m","model":"model-a","usage":{"input_tokens":3}}}}' \\
    '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"key is '"$token"'"}}}' \\
    '{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}}' \\
    '{"type":"stream_event","event":{"type":"message_stop"}}'
done
`;

const ask = (stream: boolean) =>
  JSON.stringify({
    model: "claude/model-a",
    max_tokens: 16,
    stream,
    messages: [{ role: "user", content: "hi" }],
  });

describe("POST /v1/messages on a Claude subscription account", () => {
  it("answers from Claude Code and never calls the provider's base URL", async () => {
    const gateway = await startGateway();
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ask(false),
    });
    const raw = await response.clone().text();
    expect(response.status, raw).toBe(200);
    const body = (await response.json()) as {
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
    };
    expect(body.content).toEqual([{ type: "text", text: "hello from claude" }]);
    expect(body.stop_reason).toBe("end_turn");
  });

  it("streams Anthropic SSE when the client asked", async () => {
    const gateway = await startGateway();
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: ask(true),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"text":"hello from claude"');
    expect(text).toContain("event: message_stop");
  });

  it("masks the request and restores the reply", async () => {
    const gateway = await startGateway({ masking: true, script: maskingScript });
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude/model-a",
        max_tokens: 16,
        messages: [{ role: "user", content: `my key is ${SECRET}` }],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const sent = await readFile(path.join(gateway.dir, "input"), "utf8");
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain("{{API_KEY_");
    const body = (await response.json()) as { content: Array<{ text?: string }> };
    expect(body.content[0]?.text).toBe(`key is ${SECRET}`);
  });

  it("answers the helper's callback with 404 for an unknown run", async () => {
    const gateway = await startGateway();
    const response = await fetch(`${gateway.url}/_neolix/claude-mcp/missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_call_id: "t", name: "read", arguments: {} }),
    });
    expect(response.status).toBe(404);
  });

  it("lists the bridge's runs", async () => {
    const gateway = await startGateway();
    const response = await fetch(`${gateway.url}/v1/myna/claude-runs`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: "claude-runs", runs: [], live: 0 });
  });
});
