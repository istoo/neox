import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { McpauthService } from "../mcpauth/mcpauth.js";
import { GatewayConfigStore } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });
const AUTH_HEADER = ["author", "ization"].join("");
const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      open.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function listenApp(app: express.Express): Promise<string> {
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

interface Upstream {
  base: string;
  requests: { method: string; headers: string; body: string }[];
  /** When set, a request with another token is answered 401. */
  accept?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
  });
}

async function upstream(): Promise<Upstream> {
  const state: Upstream = { base: "", requests: [] };
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ access_token: "new-token", refresh_token: "refresh-1", expires_in: 3600 }),
      );
      return;
    }
    state.requests.push({
      method: req.method ?? "",
      headers: JSON.stringify(req.headers),
      body,
    });
    if (state.accept !== undefined && req.headers[AUTH_HEADER] !== `Bearer ${state.accept}`) {
      res.writeHead(401, { "www-authenticate": "Bearer" });
      res.end("");
      return;
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "mcp-session-id": "session-1",
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  });
  state.base = await listen(server);
  return state;
}

async function gatewayFor(target: Upstream, record: Record<string, unknown> = {}): Promise<string> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-mcpauth-relay-"));
  writeFileSync(
    path.join(neolixHome, "mcp-signins.json"),
    JSON.stringify({
      neon: {
        url: `${target.base}/mcp`,
        tokenURL: `${target.base}/token`,
        clientID: "client-1",
        authMethod: "none",
        access: "access-1",
        refresh: "refresh-1",
        at: Date.now(),
        expires: Date.now() + 3_600_000,
        ...record,
      },
    }),
  );
  const mcpauth = new McpauthService({ neolixHome });
  const configHome = mkdtempSync(path.join(os.tmpdir(), "neolix-mcpauth-gateway-"));
  writeFileSync(path.join(configHome, "gateway.json"), JSON.stringify({ enabled: true }));
  const configStore = new GatewayConfigStore({ neolixHome: configHome, logger });
  await configStore.start();
  const app = express();
  app.use(
    createGatewayRouter({
      configStore,
      masker: new Masker({ neolixHome: configHome, logger }),
      ledger: new UsageLedger({ neolixHome: configHome }),
      logger,
      mcpauth,
    }),
  );
  return listenApp(app);
}

async function post(base: string, name: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  return { status: response.status, text: await response.text() };
}

describe("/mcp/<name> for a signed-in server", () => {
  test("relays a request with Neox's token and passes the answer through", async () => {
    const target = await upstream();
    const base = await gatewayFor(target);

    const answer = await post(base, "neon");
    expect(answer.status, answer.text).toBe(200);
    expect(target.requests[0]?.headers).toContain("Bearer access-1");
    expect(JSON.parse(target.requests[0]?.body ?? "{}")).toMatchObject({ method: "tools/list" });

    const response = await fetch(`${base}/mcp/neon`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(response.headers.get("mcp-session-id")).toBe("session-1");
    await response.text();
  });

  test("renews the token when the server refuses it, then sends the new one", async () => {
    const target = await upstream();
    target.accept = "new-token";
    const base = await gatewayFor(target);

    const answer = await post(base, "neon");
    expect(answer.status, answer.text).toBe(200);
    expect(target.requests).toHaveLength(2);
    expect(target.requests[0]?.headers).toContain("Bearer access-1");
    expect(target.requests[1]?.headers).toContain("Bearer new-token");
  });

  test("answers a refused sign-in without a 401, so the agent does not sign in itself", async () => {
    const target = await upstream();
    target.accept = "never";
    const base = await gatewayFor(target);
    const answer = await post(base, "neon");
    expect(answer.status).toBe(502);
    expect(answer.text).toContain("sign in to it again");
  });

  test("relays a GET stream", async () => {
    const target = await upstream();
    const base = await gatewayFor(target);
    const response = await fetch(`${base}/mcp/neon`, {
      headers: { accept: "text/event-stream" },
    });
    // The upstream answered JSON; what matters is that GET was relayed.
    expect(response.status).toBe(200);
    await response.text();
    expect(target.requests[0]?.method).toBe("GET");
    expect(target.requests[0]?.headers).toContain("Bearer access-1");
  });

  test("turns a web page's request away", async () => {
    const target = await upstream();
    const base = await gatewayFor(target);
    const answer = await post(base, "neon", { origin: "https://evil.example" });
    expect(answer.status).toBe(403);
    expect(target.requests).toHaveLength(0);
  });

  test("answers a name with no sign-in with the gateway's empty server", async () => {
    const target = await upstream();
    const base = await gatewayFor(target);
    const answer = await post(base, "something-else");
    // A valid MCP server with no tools, so a client that lists before the
    // user configures one gets an answer rather than a 404
    // (serveEmptyMcp, docs/llm-gateway.md).
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("tools");
    expect(target.requests).toHaveLength(0);
  });
});
