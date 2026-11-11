import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { createGatewayRuntime } from "./runtime.js";
import { SearchLedger } from "./search.js";
import { UsageLedger } from "./usage.js";
import { VisionService } from "./vision.js";

const logger = pino({ level: "silent" });
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface Upstream {
  url: string;
  models: string[];
}

function listen(app: express.Express): Promise<{ url: string }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** An OpenAI upstream: the eye describes every image as a red square. */
async function upstream(): Promise<Upstream> {
  const models: string[] = [];
  const app = express();
  app.use(express.json({ limit: "32mb" }));
  app.use((request, response) => {
    const body = request.body as { model?: string };
    models.push(body.model ?? "");
    const answer =
      body.model === "eye" ? "A red square with the word HELLO in it." : "answered in text";
    response.json({
      id: "x",
      choices: [
        { index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" },
      ],
    });
  });
  const { url } = await listen(app);
  return { url, models };
}

function configFor(upstreamUrl: string): GatewayConfig {
  return {
    version: 1,
    enabled: true,
    keys: [],
    providers: [
      {
        id: "probe",
        protocol: "openai",
        baseUrl: `${upstreamUrl}/v1`,
        apiKey: "key",
        models: [
          { id: "text", images: false },
          { id: "eye", images: true },
        ],
      },
    ],
    groups: [],
    vision: { model: "probe/eye" },
  };
}

async function gateway(
  config: GatewayConfig,
): Promise<{ url: string; ledger: UsageLedger; vision: VisionService }> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-vision-routing-"));
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
  await ledger.start();
  const searchLedger = new SearchLedger({ neolixHome, logger });
  await searchLedger.start();
  const vision = new VisionService({ neolixHome, logger });
  await vision.start();
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker,
      ledger,
      logger,
      searchLedger,
      runtime: createGatewayRuntime(ledger),
      vision,
    }),
  );
  return { ...(await listen(app)), ledger, vision };
}

const image = `data:image/png;base64,${Buffer.from("HELLO").toString("base64")}`;

describe("describing through the gateway's own routing", () => {
  it("routes the description and bills it to neolix-vision", async () => {
    const up = await upstream();
    const gate = await gateway(configFor(up.url));
    const response = await fetch(`${gate.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "probe/text",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              { type: "image_url", image_url: image },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(up.models).toEqual(["eye", "text"]);
    await gate.ledger.flush();
    const records = gate.ledger.recentEntries();
    expect(
      records.some((record) => record.model === "eye" && record.client === "neolix-vision"),
    ).toBe(true);
  });

  it("keeps /mcp/vision for the user's own server and serves /mcp/myna/vision", async () => {
    const up = await upstream();
    const gate = await gateway(configFor(up.url));
    const listed = await mcp(gate, "/mcp/myna/vision", "tools/list");
    expect(JSON.stringify(listed)).toContain("analyze_image");

    const theirs = await mcp(gate, "/mcp/vision", "tools/list");
    expect(JSON.stringify(theirs)).toContain("tools");
    expect(JSON.stringify(theirs)).not.toContain("analyze_image");
  });
});

async function mcp(
  gate: { url: string },
  mcpPath: string,
  method: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${gate.url}${mcpPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
  });
  return (await response.json()) as Record<string, unknown>;
}
