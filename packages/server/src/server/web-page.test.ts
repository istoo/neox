import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  WEB_PAGE_DEFAULT_PORT,
  WebPageServer,
  checkWebPageKey,
  checkWebPagePort,
  isDaemonPath,
  loadWebPageSettings,
  webPageLinks,
  newWebPageKey,
  publicPageUrl,
  saveWebPageSettings,
} from "./web-page.js";

const logger = pino({ level: "silent" });
const COOKIE = "neolix_web";
const servers: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.dispose();
  }
});

async function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "neolix-web-page-"));
}

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
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

async function distDir(home: string): Promise<string> {
  const dir = path.join(home, "dist");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Neox</title>");
  return dir;
}

async function upgrade(host: string, port: number, cookie: string | null): Promise<string> {
  return new Promise((resolve) => {
    const client = net.connect({ host: "127.0.0.1", port }, () => {
      const lines = [
        "GET /ws HTTP/1.1",
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
      ];
      if (cookie !== null) {
        lines.push(`Cookie: ${cookie}`);
      }
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    client.once("data", (chunk) => {
      resolve(chunk.toString());
      client.destroy();
    });
    client.once("error", () => resolve(""));
    client.once("close", () => resolve(""));
  });
}

async function requestAs(
  port: number,
  pathname: string,
  host: string,
  cookie?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
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
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("web page settings", () => {
  it("is off with the default port until a file says otherwise", async () => {
    const settings = await loadWebPageSettings(await tempHome());
    expect(settings).toEqual({ mode: "off", port: WEB_PAGE_DEFAULT_PORT, key: "" });
  });

  it("keeps the key in a file only its owner may read", async () => {
    const home = await tempHome();
    await saveWebPageSettings(home, { mode: "local", port: 3431, key: "0123456789abcdef" });
    const mode = (await stat(path.join(home, "web-page.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(home, "web-page.json"), "utf8"))).toEqual({
      mode: "local",
      port: 3431,
      key: "0123456789abcdef",
    });
    expect(await loadWebPageSettings(home)).toEqual({
      mode: "local",
      port: 3431,
      key: "0123456789abcdef",
    });
  });

  it("refuses ports and keys myna refuses", () => {
    expect(checkWebPagePort(80)).not.toBeNull();
    expect(checkWebPagePort(65536)).not.toBeNull();
    expect(checkWebPagePort(3430)).toBeNull();
    expect(checkWebPagePort(3430, 3430)).toBe("port 3430 is the daemon's: pick another one");
    expect(checkWebPageKey("short")).not.toBeNull();
    expect(checkWebPageKey("0123456789abcdef")).toBeNull();
    expect(newWebPageKey()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the browser page", () => {
  it("serves the page behind the link's key and passes the daemon's API on", async () => {
    const home = await tempHome();
    const port = await freePort();
    const daemon = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", () => resolve()));
    const daemonAddress = daemon.address();
    if (daemonAddress === null || typeof daemonAddress === "string") {
      throw new Error("Expected a TCP address");
    }
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => ({ host: "127.0.0.1", port: daemonAddress.port }),
    });
    servers.push(page);
    await page.start();
    const state = await page.update({ mode: "local", port, newKey: true });
    expect(state.serving).toBe(true);
    expect(state.link).toContain(`http://127.0.0.1:${port}/?k=`);
    const key = new URL(state.link ?? "").searchParams.get("k") ?? "";

    const denied = await fetch(`http://127.0.0.1:${port}/`);
    expect(denied.status).toBe(401);

    const signedIn = await fetch(`http://127.0.0.1:${port}/?k=${key}`, { redirect: "manual" });
    expect(signedIn.status).toBe(303);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const pageHtml = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } });
    expect(await pageHtml.text()).toContain("<title>Neox</title>");

    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { cookie } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    await daemon.close();
  });

  it("passes the daemon's WebSocket upgrade on, and only for a browser that signed in", async () => {
    const home = await tempHome();
    const port = await freePort();
    const daemon = createServer();
    daemon.on("upgrade", (req, socket) => {
      if (req.headers.cookie?.includes(COOKIE) !== true) {
        socket.destroy();
        return;
      }
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", () => resolve()));
    const address = daemon.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => ({ host: "127.0.0.1", port: address.port }),
    });
    servers.push(page);
    await page.start();
    const state = await page.update({ mode: "local", port, newKey: true });
    const key = new URL(state.link ?? "").searchParams.get("k") ?? "";
    expect(state.serving, JSON.stringify(state)).toBe(true);

    const refused = await upgrade("127.0.0.1", port, null);
    expect(refused).toBe("");

    const accepted = await upgrade("127.0.0.1", port, `${COOKIE}=${key}`);
    expect(accepted).toContain("101 Switching Protocols");
    await daemon.close();
  });

  it("answers only the names it is served under, so a rebinding page gets nothing", async () => {
    const home = await tempHome();
    const port = await freePort();
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => null,
    });
    servers.push(page);
    await page.start();
    const state = await page.update({ mode: "local", port, newKey: true });
    const key = new URL(state.link ?? "").searchParams.get("k") ?? "";

    expect((await requestAs(port, "/", "evil.example")).status).toBe(403);
    expect((await requestAs(port, "/api/health", "evil.example", `${COOKIE}=${key}`)).status).toBe(
      403,
    );
    expect((await requestAs(port, "/", `localhost:${port}`)).status).toBe(401);
    const refusedUpgrade = await upgrade("evil.example", port, `${COOKIE}=${key}`);
    expect(refusedUpgrade).toBe("");
  });

  it("signs an old cookie out when the key is made anew", async () => {
    const home = await tempHome();
    const port = await freePort();
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => null,
    });
    servers.push(page);
    await page.start();
    const first = await page.update({ mode: "local", port, newKey: true });
    const oldKey = new URL(first.link ?? "").searchParams.get("k") ?? "";
    const signedIn = await fetch(`http://127.0.0.1:${port}/?k=${oldKey}`, { redirect: "manual" });
    expect(signedIn.status).toBe(303);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const second = await page.update({ newKey: true });
    const newKey = new URL(second.link ?? "").searchParams.get("k") ?? "";
    expect(newKey).not.toBe(oldKey);

    const stale = await requestAs(port, "/", "127.0.0.1", cookie);
    expect(stale.status).toBe(401);
    const fresh = await requestAs(port, "/", "127.0.0.1", `${COOKIE}=${newKey}`);
    expect(fresh.status).toBe(200);
  });

  it("stops serving when it is turned off, and gives a new key on demand", async () => {
    const home = await tempHome();
    const port = await freePort();
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => null,
    });
    servers.push(page);
    await page.start();
    const first = await page.update({ mode: "local", port, newKey: true });
    const second = await page.update({ newKey: true });
    expect(second.link).not.toBe(first.link);

    const off = await page.update({ mode: "off" });
    expect(off.serving).toBe(false);
    expect(off.link).toBeNull();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it("lets the daemon's own routes past the page and answers nothing else as the daemon's", () => {
    expect(isDaemonPath("/api/health")).toBe(true);
    expect(isDaemonPath("/ws")).toBe(true);
    expect(isDaemonPath("/public/logo.png")).toBe(true);
    expect(isDaemonPath("/mcp/agents")).toBe(true);
    expect(isDaemonPath("/")).toBe(false);
    expect(isDaemonPath("/h/server/workspace")).toBe(false);
  });

  it("reads a tunnel's public address, refusing what is not a plain base URL", () => {
    expect(publicPageUrl({ NEOLIX_PUBLIC_URL: "https://neolix.example.com" })).toBe(
      "https://neolix.example.com",
    );
    expect(publicPageUrl({ NEOLIX_PUBLIC_URL: "neolix.example.com/" })).toBe(
      "http://neolix.example.com",
    );
    for (const value of [
      "https://neolix.example.com/?a=1",
      "https://neolix.example.com/#x",
      "https://user:pw@neolix.example.com",
      "ftp://neolix.example.com",
      "",
    ]) {
      expect(publicPageUrl({ NEOLIX_PUBLIC_URL: value }), value).toBeNull();
    }
    expect(webPageLinks({ mode: "lan", port: 3430, key: "0123456789abcdef" }).network).toEqual(
      expect.arrayContaining([expect.stringContaining("0123456789abcdef")]),
    );
  });

  it("answers a tunnel's own name only when NEOLIX_PUBLIC_URL names it", async () => {
    const home = await tempHome();
    const port = await freePort();
    const page = new WebPageServer({
      neolixHome: home,
      distDir: await distDir(home),
      logger,
      daemonAddress: () => null,
    });
    servers.push(page);
    await page.start();
    await page.update({ mode: "local", port, newKey: true });
    const previous = process.env.NEOLIX_PUBLIC_URL;
    try {
      delete process.env.NEOLIX_PUBLIC_URL;
      expect((await requestAs(port, "/", "neolix.example.com")).status).toBe(403);
      process.env.NEOLIX_PUBLIC_URL = "https://neolix.example.com";
      expect((await requestAs(port, "/", "neolix.example.com")).status).toBe(401);
      expect((await requestAs(port, "/", "neolix.example.com:443")).status).toBe(401);
    } finally {
      if (previous === undefined) {
        delete process.env.NEOLIX_PUBLIC_URL;
      } else {
        process.env.NEOLIX_PUBLIC_URL = previous;
      }
    }
  });
});
