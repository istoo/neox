import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pino from "pino";
import { WebSocket } from "ws";

import { createTestNeolixDaemon, type TestNeolixDaemon } from "../test-utils/neolix-daemon.js";
import { resolveWebAppPaths, webAppCandidates } from "../web-app.js";
import { saveWebPageSettings } from "../web-page.js";

// The desktop web app on the daemon's own port, served from this checkout's builds of
// `packages/desktop-web` (`bun run build:bundle` in apps/bridge, `build` in apps/web).
const paths = await resolveWebAppPaths(webAppCandidates({ env: process.env }));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function pageRequest(
  port: number,
  pathname: string,
  host: string,
  cookie?: string,
): Promise<{ status: number; body: string; contentType: string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        headers: { host, ...(cookie === undefined ? {} : { cookie }) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers["content-type"] ?? null,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe.skipIf(paths === null)("desktop web app on the daemon port", () => {
  let daemon: TestNeolixDaemon;
  let base: string;
  /** The daemon's connection diagnostics, so the test can see how the bridge attached. */
  const logLines: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    const logger = pino({ level: "info" }, {
      write(chunk: string) {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            logLines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // A partial fragment; the rest of the line arrives on the next write.
          }
        }
      },
    } as unknown as pino.DestinationStream);
    daemon = await createTestNeolixDaemon({
      webApp: paths ? [paths] : null,
      mcpEnabled: false,
      logger,
    });
    base = `http://127.0.0.1:${daemon.port}`;
    // The app connects to the daemon after it starts; its routes answer 503 until then.
    const deadline = Date.now() + 30_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await fetch(`${base}/`)).status;
      if (status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (status !== 200) throw new Error(`The web app answered ${status} instead of starting`);
  }, 60_000);

  afterAll(async () => {
    await daemon?.close();
  });

  test("serves the page and its history fallback", async () => {
    const root = await fetch(`${base}/`);
    expect(root.headers.get("content-type")).toContain("text/html");
    expect(await root.text()).toContain('id="root"');
    const deep = await fetch(`${base}/settings/general`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get("content-type")).toContain("text/html");
  });

  test("answers its RPC negotiation itself", async () => {
    // Without the negotiation query the app refuses with its own 426, not the daemon's 401/404.
    const response = await fetch(`${base}/rpc/negotiate`);
    expect(response.status).toBe(426);
  });

  test("opens its RPC socket beside the daemon's own", async () => {
    const opened = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/rpc/bootstrap`);
      socket.once("open", () => {
        socket.close();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    expect(opened).toBe(true);
  });

  test("connects the bridge inside the daemon process, not over loopback TCP", () => {
    const hellos = logLines.filter((line) => line.msg === "Client connected via hello");
    const bridge = hellos.find((line) => line.clientId === "neolix-desktop-web-bridge");
    expect(bridge).toBeDefined();
    expect(bridge?.transport).toBe("web-app");
    // The page's own `/rpc` sockets live inside the embed and never reach the daemon's
    // WebSocket server; the bridge's only connection is the in-process one.
    expect(hellos.filter((line) => line.clientId === "neolix-desktop-web-bridge")).toHaveLength(1);
  });

  test("refuses a page from another origin", async () => {
    const response = await fetch(`${base}/rpc/negotiate`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    const socketStatus = await new Promise<number | null>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${daemon.port}/rpc/bootstrap`, {
        headers: { Origin: "https://evil.example" },
      });
      socket.once("unexpected-response", (_request, reply) => resolve(reply.statusCode ?? null));
      socket.once("open", () => {
        socket.close();
        resolve(101);
      });
      socket.once("error", () => resolve(null));
    });
    expect(socketStatus).toBe(403);
  });

  test("leaves the daemon's own routes to the daemon", async () => {
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok" });
  });

  // Settings › Network › Browser access on the LAN: its own port, its own key,
  // and the web app answered in-process after that guard instead of over TCP.
  describe("behind Browser access on the LAN", () => {
    const COOKIE = "neolix_web";
    const LAN_NAME = "neolix.lan.test";
    let lanDaemon: TestNeolixDaemon;
    let homeRoot: string;
    let pagePort: number;
    let key: string;
    let lanHost: string;
    let previousPublicUrl: string | undefined;

    function openBootstrapSocket(cookie?: string): Promise<number> {
      return new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${pagePort}/rpc/bootstrap`, {
          headers: {
            host: lanHost,
            origin: `http://${lanHost}`,
            ...(cookie === undefined ? {} : { cookie }),
          },
        });
        socket.once("open", () => {
          socket.close();
          resolve(101);
        });
        socket.once("unexpected-response", (_request, reply) => resolve(reply.statusCode ?? 0));
        socket.once("error", () => resolve(0));
      });
    }

    beforeAll(async () => {
      if (paths === null) throw new Error("The web app build is missing");
      homeRoot = await mkdtemp(path.join(os.tmpdir(), "neolix-web-app-lan-"));
      pagePort = await freePort();
      key = "0123456789abcdef0123456789abcdef";
      // LAN mode, no addr: it listens on every address. The public URL names the
      // non-loopback Host the tests send (allowedHost, web-page.ts).
      await saveWebPageSettings(path.join(homeRoot, ".neox"), { mode: "lan", port: pagePort, key });
      lanDaemon = await createTestNeolixDaemon({
        webApp: [paths],
        webUi: { enabled: true, distDir: paths.distDir },
        neolixHomeRoot: homeRoot,
        mcpEnabled: false,
      });
      lanHost = `${LAN_NAME}:${pagePort}`;
      previousPublicUrl = process.env.NEOLIX_PUBLIC_URL;
      process.env.NEOLIX_PUBLIC_URL = `http://${LAN_NAME}`;
      const cookie = `${COOKIE}=${key}`;
      const deadline = Date.now() + 30_000;
      for (;;) {
        let status = 0;
        try {
          status = (await pageRequest(pagePort, "/", lanHost, cookie)).status;
        } catch {
          status = 0;
        }
        if (status === 200) break;
        if (Date.now() > deadline) throw new Error(`Browser access answered ${status}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }, 60_000);

    afterAll(async () => {
      if (previousPublicUrl === undefined) delete process.env.NEOLIX_PUBLIC_URL;
      else process.env.NEOLIX_PUBLIC_URL = previousPublicUrl;
      await lanDaemon?.close();
      if (homeRoot !== undefined) await rm(homeRoot, { recursive: true, force: true });
    });

    test("serves the page and its RPC under the LAN name, not a 403", async () => {
      const cookie = `${COOKIE}=${key}`;
      const page = await pageRequest(pagePort, "/", lanHost, cookie);
      expect(page.status).toBe(200);
      expect(page.contentType).toContain("text/html");
      expect(page.body).toContain('id="root"');
      const negotiate = await pageRequest(pagePort, "/rpc/negotiate", lanHost, cookie);
      expect(negotiate.status).toBe(426);
    });

    /** The app's real feature socket: negotiate, then upgrade with that generation. */
    async function featureSocketStatus(cookie: string, origin: string): Promise<number> {
      const query = new URLSearchParams({
        "x-synara-protocol-epoch": "1",
        "x-synara-protocol-min-revision": "3",
        "x-synara-protocol-max-revision": "3",
        "x-synara-client-build": "e2e",
      });
      const negotiation = await pageRequest(
        pagePort,
        `/rpc/negotiate?${query.toString()}`,
        lanHost,
        cookie,
      );
      if (negotiation.status !== 200) return negotiation.status;
      const { serverInstanceId } = JSON.parse(negotiation.body) as { serverInstanceId: string };
      query.delete("x-synara-protocol-min-revision");
      query.delete("x-synara-protocol-max-revision");
      query.set("x-synara-protocol-revision", "3");
      query.set("x-synara-server-instance", serverInstanceId);
      return new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${pagePort}/rpc?${query.toString()}`, {
          headers: { host: lanHost, origin, cookie },
        });
        socket.once("open", () => {
          socket.close();
          resolve(101);
        });
        socket.once("unexpected-response", (_request, reply) => resolve(reply.statusCode ?? 0));
        socket.once("error", () => resolve(0));
      });
    }

    test("opens its RPC socket under the LAN name", async () => {
      expect(await openBootstrapSocket(`${COOKIE}=${key}`)).toBe(101);
    });

    test("opens the feature socket from its own page and refuses another origin", async () => {
      const cookie = `${COOKIE}=${key}`;
      expect(await featureSocketStatus(cookie, `http://${lanHost}`)).toBe(101);
      expect(await featureSocketStatus(cookie, "http://evil.example")).toBe(403);
    });

    test("stays behind the key", async () => {
      expect((await pageRequest(pagePort, "/rpc/negotiate", lanHost)).status).toBe(401);
      expect((await pageRequest(pagePort, "/", lanHost)).status).toBe(401);
      expect(await openBootstrapSocket()).toBe(0);
    });

    test("refuses a name it is not served under", async () => {
      const cookie = `${COOKIE}=${key}`;
      const refused = await pageRequest(pagePort, "/rpc/negotiate", "evil.example", cookie);
      expect(refused.status).toBe(403);
    });

    test("leaves the daemon's own API to the daemon", async () => {
      const health = await pageRequest(pagePort, "/api/health", lanHost, `${COOKIE}=${key}`);
      expect(health.status).toBe(200);
    });
  });

  // Once the 101 is sent the socket belongs to WebSocket framing. A response written
  // after it is frame garbage, and Chromium reports "Invalid frame header" for the
  // connection. The daemon's shutdown 503 used to land exactly there.
  test("keeps an upgraded socket in WebSocket framing when the daemon stops", async () => {
    const own = await createTestNeolixDaemon({ webApp: [paths], mcpEnabled: false });
    const ownBase = `http://127.0.0.1:${own.port}`;
    const readyBy = Date.now() + 30_000;
    for (;;) {
      const status = await fetch(`${ownBase}/`)
        .then((response) => response.status)
        .catch(() => 0);
      if (status === 200) break;
      if (Date.now() > readyBy) throw new Error(`The web app answered ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const query = new URLSearchParams({
      "x-synara-protocol-epoch": "1",
      "x-synara-protocol-min-revision": "3",
      "x-synara-protocol-max-revision": "3",
      "x-synara-client-build": "e2e",
    });
    const negotiation = await fetch(`${ownBase}/rpc/negotiate?${query}`, {
      headers: { origin: ownBase },
    });
    expect(negotiation.status).toBe(200);
    const { serverInstanceId } = (await negotiation.json()) as { serverInstanceId: string };
    query.delete("x-synara-protocol-min-revision");
    query.delete("x-synara-protocol-max-revision");
    query.set("x-synara-protocol-revision", "3");
    query.set("x-synara-server-instance", serverInstanceId);

    const socket = net.connect({ host: "127.0.0.1", port: own.port });
    let received = "";
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("latin1");
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write(
          `GET /rpc?${query.toString()} HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${own.port}\r\n` +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
            `Origin: ${ownBase}\r\n\r\n`,
        );
        resolve();
      });
    });
    const handshakeDeadline = Date.now() + 10_000;
    while (!received.includes("\r\n\r\n")) {
      if (Date.now() > handshakeDeadline) {
        throw new Error("The RPC socket never answered the upgrade");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const handshakeEnd = received.indexOf("\r\n\r\n") + 4;
    expect(received.slice(0, handshakeEnd)).toContain("101 Switching Protocols");
    try {
      await own.close();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } finally {
      socket.destroy();
    }
    expect(received.slice(handshakeEnd)).not.toMatch(/HTTP\/1\.1/);
  }, 60_000);
});
