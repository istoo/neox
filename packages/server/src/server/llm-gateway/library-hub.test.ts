import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { setLibraryHub } from "../library/hub-registry.js";
import type { LibraryHub } from "../library/hub.js";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });
const open: Server[] = [];

afterEach(async () => {
  setLibraryHub(null);
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function storeHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-hub-mask-"));
}

async function storeWith(config: Partial<GatewayConfig>): Promise<GatewayConfigStore> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-hub-"));
  writeFileSync(
    path.join(neolixHome, "gateway.json"),
    JSON.stringify({ enabled: true, ...config }),
  );
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  return store;
}

async function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      open.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function hub(calls: unknown[]): LibraryHub {
  return {
    listTools: async () => [
      { server: "docs", tool: "search", description: "Find docs", inputSchema: { type: "object" } },
    ],
    callTool: async (_agent, server, tool, args, meta) => {
      calls.push(meta ? { server, tool, args, meta } : { server, tool, args });
      return { content: [{ type: "text", text: "found" }] };
    },
    reset: async () => undefined,
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("library MCP hub route", () => {
  test("lists the library's tools as <server>__<tool> and calls them", async () => {
    const calls: unknown[] = [];
    setLibraryHub(hub(calls));
    const app = express();
    const home = storeHome();
    app.use(
      createGatewayRouter({
        configStore: await storeWith({}),
        masker: new Masker({ neolixHome: home, logger }),
        ledger: new UsageLedger({
          neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-ledger-")),
        }),
        logger,
      }),
    );
    const base = await listen(app);

    const init = await post(`${base}/mcp/neox/hub/claude`, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(init.status).toBe(200);
    expect((init.body.result as { serverInfo: { name: string } }).serverInfo.name).toBe("neox");

    const list = await post(`${base}/mcp/neox/hub/claude`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (list.body.result as { tools: { name: string; description: string }[] }).tools;
    expect(tools[0]?.name).toBe("docs__search");
    expect(tools[0]?.description).toContain("[docs]");

    const call = await post(`${base}/mcp/neox/hub/claude`, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "docs__search", arguments: { q: "x" } },
    });
    expect(calls).toEqual([{ server: "docs", tool: "search", args: { q: "x" } }]);
    expect(call.body.result).toEqual({ content: [{ type: "text", text: "found" }] });

    const alias = await post(`${base}/mcp/myna/hub`, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
    });
    expect((alias.body.result as { tools: unknown[] }).tools).toHaveLength(1);

    const stream = await fetch(`${base}/mcp/neox/hub`, { method: "GET" });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel();
  });

  test("calls a tool the server no longer lists", async () => {
    const calls: unknown[] = [];
    const provider = hub(calls);
    let listed = true;
    setLibraryHub({
      ...provider,
      listTools: async () => (listed ? provider.listTools("") : []),
    });
    const app = express();
    const home = storeHome();
    app.use(
      createGatewayRouter({
        configStore: await storeWith({}),
        masker: new Masker({ neolixHome: home, logger }),
        ledger: new UsageLedger({
          neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-ledger-")),
        }),
        logger,
      }),
    );
    const base = await listen(app);

    const first = await post(`${base}/mcp/neox/hub`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect((first.body.result as { tools: unknown[] }).tools).toHaveLength(1);
    listed = false;
    const call = await post(`${base}/mcp/neox/hub`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "docs__search", arguments: { q: "still" }, _meta: { "neolix/roots": [] } },
    });
    expect(call.body.error).toBeUndefined();
    expect(calls).toEqual([
      { server: "docs", tool: "search", args: { q: "still" }, meta: { "neolix/roots": [] } },
    ]);
  });

  test("refuses another machine when the gateway has keys and none was sent", async () => {
    setLibraryHub(hub([]));
    const app = express();
    const home = storeHome();
    app.use(
      createGatewayRouter({
        configStore: await storeWith({ keys: ["secret"] }),
        masker: new Masker({ neolixHome: home, logger }),
        ledger: new UsageLedger({
          neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-ledger-")),
        }),
        logger,
      }),
    );
    const base = await listen(app);
    // A test request comes from loopback, but a keyed gateway still asks for the key.
    const refused = await post(`${base}/mcp/neox/hub`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(refused.status).toBe(401);
    const allowed = await post(
      `${base}/mcp/neox/hub`,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { authorization: "Bearer secret" },
    );
    expect(allowed.status).toBe(200);
  });

  test("lists nothing when no hub provider is registered", async () => {
    setLibraryHub(null);
    const app = express();
    app.use(
      createGatewayRouter({
        configStore: await storeWith({}),
        masker: new Masker({ neolixHome: storeHome(), logger }),
        ledger: new UsageLedger({
          neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-ledger-")),
        }),
        logger,
      }),
    );
    const base = await listen(app);
    const list = await post(`${base}/mcp/neox/hub`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect((list.body.result as { tools: unknown[] }).tools).toEqual([]);
  });
});
