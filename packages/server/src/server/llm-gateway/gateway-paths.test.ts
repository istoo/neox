import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { isGatewayRequestPath } from "./gateway-paths.js";
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

function configStore(config: GatewayConfig): GatewayConfigStore {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-gateway-paths-"));
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  return new GatewayConfigStore({ neolixHome, logger });
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      openServers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("isGatewayRequestPath", () => {
  it("names the paths the gateway answers", () => {
    for (const pathname of [
      "/v1/models",
      "/v1/messages",
      "/v1beta/models",
      "/backend-api/codex/responses",
      "/mcp/myna/web-search",
      "/_neolix/claude-mcp/token",
      "/me",
      "/api/show",
      "/api/hello",
      "/muse-code/models",
      "/models",
      "/responses",
      "/chat/completions",
      "/audio/speech",
      "/videos",
      "/images/generations",
    ]) {
      expect(isGatewayRequestPath(pathname), pathname).toBe(true);
    }
  });

  it("leaves the daemon's own routes to the daemon", () => {
    for (const pathname of [
      "/api/health",
      "/api/status",
      "/api/pair",
      "/api/terminal-activity",
      "/ws",
      "/mcp/agents",
      "/public/logo.png",
      "/index.html",
      "/",
      "/files/x",
    ]) {
      expect(isGatewayRequestPath(pathname), pathname).toBe(false);
    }
  });
});

describe("the gateway router", () => {
  it("judges gateway calls only, leaving the app's own routes to Neox's auth", async () => {
    // A gateway switched off answers every gateway call with 404; the app's
    // own API beside it must still answer.
    const store = configStore({
      enabled: false,
      keys: [{ key: "k-1" }],
    } as GatewayConfig);
    await store.start();
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-gateway-paths-home-"));
    const app = express();
    app.use(
      createGatewayRouter({
        configStore: store,
        masker: new Masker({ neolixHome, logger, allow: () => [] }),
        ledger: new UsageLedger({ neolixHome, logger }),
        logger,
      }),
    );
    app.get("/api/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    const url = await listen(app);

    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const gateway = await fetch(`${url}/v1/models`, {
      headers: { authorization: "Bearer k-1" },
    });
    expect(gateway.status).toBe(404);
  });

  it("leaves the app's own WebSocket upgrade alone on a shared LAN listen", async () => {
    const store = configStore({
      enabled: true,
      allowIPs: ["10.0.0.0/8"],
      keys: [{ key: "k-1" }],
    } as GatewayConfig);
    await store.start();
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-gateway-paths-ws-"));
    const app = express();
    app.use(
      createGatewayRouter({
        configStore: store,
        masker: new Masker({ neolixHome, logger, allow: () => [] }),
        ledger: new UsageLedger({ neolixHome, logger }),
        logger,
      }),
    );
    const server = createServer(app);
    // The daemon's own socket server claims /ws; the gateway's allow list and
    // key check never see it.
    server.on("upgrade", (req, socket) => {
      if (req.url === "/ws") {
        socket.end(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
        );
        return;
      }
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    openServers.push(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const reply = await new Promise<string>((resolve) => {
      const client = net.connect({ host: "127.0.0.1", port: address.port }, () => {
        client.write(
          "GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
      });
      client.once("data", (chunk) => {
        resolve(chunk.toString());
        client.destroy();
      });
      client.once("error", () => resolve(""));
    });
    expect(reply).toContain("101 Switching Protocols");
  });
});
