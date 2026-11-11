import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserRelay } from "./browser.js";
import { BROWSER_FILE_TOKEN, BrowserFileStore, type BrowserFileRead } from "./browser-files.js";
import { BrowserRecordings, RECORD_IDLE_MS, RECORD_MOST } from "./browser-record.js";
import { GatewayConfigStore } from "./config.js";
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
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface Harness {
  url: string;
  relay: BrowserRelay;
}

async function startHarness(): Promise<Harness> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-browser-"));
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  const relay = new BrowserRelay({ logger });
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker: new Masker({ neolixHome, logger, allow: () => [] }),
      ledger: new UsageLedger({ neolixHome, logger }),
      logger,
      browser: relay,
    }),
  );
  const server = createServer(app);
  server.on("upgrade", (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return { url: `http://127.0.0.1:${address.port}`, relay };
}

function connectExtension(url: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${url.replace("http", "ws")}/v1/myna/browser/extension`, {
      origin,
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

async function rpc(
  url: string,
  method: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/mcp/myna/browser`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("browser extension bridge", () => {
  it("lists one browser tool and relays its actions", async () => {
    const harness = await startHarness();
    const socket = await connectExtension(
      harness.url,
      "chrome-extension://dmlhojidlfnkgamkekjhacgkpanbkeko",
    );
    socket.send(JSON.stringify({ type: "hello", version: "0.1.4", agent: "Chrome/140" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = (await (await fetch(`${harness.url}/v1/myna/browser`)).json()) as {
      connected: boolean;
      browser: string;
    };
    expect(status.connected).toBe(true);
    expect(status.browser).toBe("Chrome/140");

    const listed = await rpc(harness.url, "tools/list");
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["browser"]);

    const pending = nextMessage(socket);
    const call = rpc(harness.url, "tools/call", {
      name: "browser",
      arguments: { action: "tabs" },
    });
    const forwarded = await pending;
    expect(forwarded.tool).toBe("browser_tabs");
    expect(forwarded.args).toEqual({});
    socket.send(
      JSON.stringify({
        id: forwarded.id,
        result: { content: [{ type: "text", text: "tab t1: example" }] },
      }),
    );
    const answered = (await call) as {
      result: { content: Array<{ text: string }> };
    };
    expect(answered.result.content[0]?.text).toBe("tab t1: example");
    socket.close();
  });

  it("unfolds an action into the extension's tool and arguments", async () => {
    const harness = await startHarness();
    const socket = await connectExtension(
      harness.url,
      "chrome-extension://dmlhojidlfnkgamkekjhacgkpanbkeko",
    );
    socket.send(JSON.stringify({ type: "hello", version: "0.1.4", agent: "Chrome/140" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const pending = nextMessage(socket);
    const call = rpc(harness.url, "tools/call", {
      name: "browser",
      arguments: { action: "back", tab: "t3" },
    });
    const forwarded = await pending;
    expect(forwarded.tool).toBe("browser_navigate");
    expect(forwarded.args).toEqual({ go: "back", tab: "t3" });
    socket.send(
      JSON.stringify({ id: forwarded.id, result: { content: [{ type: "text", text: "ok" }] } }),
    );
    await call;
    socket.close();
  });

  it("refuses a connection from anything but the extension", async () => {
    const harness = await startHarness();
    await expect(connectExtension(harness.url, "https://example.com")).rejects.toThrow();
  });

  it("says the extension is away when none is connected", async () => {
    const harness = await startHarness();
    const response = await rpc(harness.url, "tools/call", {
      name: "browser",
      arguments: { action: "tabs" },
    });
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("isn't connected");
  });
});

/** A small PNG the extension hands back as a screenshot. */
const PICTURE =
  "iVBORw0KGgoAAAANSUhEUgAAAAwAAAAICAYAAADN5B7xAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAO0lEQVR4nGM4oKDwHydWUvp/vaAAjA8oKoLFGPBpACmEgWsgTVTXcEBREazwWn4+wkkKDgf+k4IHoQYAyWLTUW9j1kUAAAAASUVORK5CYII=";

/** Answers the extension's side of every call: a picture for screenshots,
 * text for everything else. */
function serveExtension(socket: WebSocket, picture: string): void {
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Record<string, unknown>;
    const tool = typeof message.tool === "string" ? message.tool : "";
    if (tool === "") {
      return;
    }
    const content =
      tool === "browser_screenshot"
        ? [{ type: "image", data: picture, mimeType: "image/png" }]
        : [{ type: "text", text: `${tool} ok` }];
    socket.send(JSON.stringify({ id: message.id, result: { content } }));
  });
}

async function browserCall(
  url: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await rpc(url, "tools/call", { name: "browser", arguments: args });
  return response.result as Record<string, unknown>;
}

function textOf(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : "";
}

function writtenFiles(result: Record<string, unknown>): Array<{ url: string }> {
  const meta = result._meta as Record<string, unknown> | undefined;
  const files = meta?.["github.com/istoo/myna/files"];
  return Array.isArray(files) ? (files as Array<{ url: string }>) : [];
}

interface GifFrame {
  delay: number;
  width: number;
  height: number;
}

interface GifInfo {
  width: number;
  height: number;
  frames: GifFrame[];
  loops: boolean;
}

/** Reads a GIF's structure, enough to judge what a recording made. */
function gifInfo(bytes: Buffer): GifInfo {
  expect(bytes.subarray(0, 6).toString("latin1")).toBe("GIF89a");
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const packed = bytes[10] ?? 0;
  let at = 13;
  if ((packed & 0x80) !== 0) {
    at += 3 * (1 << ((packed & 0x07) + 1));
  }
  const frames: GifFrame[] = [];
  let loops = false;
  let delay = 0;
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x3b) {
      break;
    }
    if (block === 0x21) {
      const label = bytes[at + 1];
      if (label === 0xf9) {
        delay = bytes.readUInt16LE(at + 4);
      }
      if (label === 0xff && bytes.subarray(at + 3, at + 14).toString("latin1") === "NETSCAPE2.0") {
        loops = true;
      }
      at = skipGifSubBlocks(bytes, at + 2);
      continue;
    }
    if (block === 0x2c) {
      const frameWidth = bytes.readUInt16LE(at + 5);
      const frameHeight = bytes.readUInt16LE(at + 7);
      const framePacked = bytes[at + 9] ?? 0;
      at += 10;
      if ((framePacked & 0x80) !== 0) {
        at += 3 * (1 << ((framePacked & 0x07) + 1));
      }
      at = skipGifSubBlocks(bytes, at + 1);
      frames.push({ delay, width: frameWidth, height: frameHeight });
      delay = 0;
      continue;
    }
    throw new Error(`unexpected GIF block 0x${(block ?? 0).toString(16)}`);
  }
  return { width, height, frames, loops };
}

function skipGifSubBlocks(bytes: Buffer, at: number): number {
  let cursor = at;
  for (;;) {
    const size = bytes[cursor];
    if (size === undefined) {
      throw new Error("the GIF ends inside its data");
    }
    cursor += 1 + size;
    if (size === 0) {
      return cursor;
    }
  }
}

function refusal(result: BrowserFileRead): number | undefined {
  return result.ok ? undefined : result.status;
}

describe("browser recording", () => {
  it("records the actions between record_start and record_stop as a GIF", async () => {
    const harness = await startHarness();
    const socket = await connectExtension(
      harness.url,
      "chrome-extension://dmlhojidlfnkgamkekjhacgkpanbkeko",
    );
    socket.send(JSON.stringify({ type: "hello", version: "0.1.4", agent: "Chrome/140" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    serveExtension(socket, PICTURE);

    const started = await browserCall(harness.url, { action: "record_start" });
    expect(started.isError).toBe(false);
    expect(textOf(started)).toContain("Recording");

    for (const ref of ["e1", "e2", "e3"]) {
      const clicked = await browserCall(harness.url, { action: "click", ref });
      expect(clicked.isError).toBeFalsy();
    }

    const stopped = await browserCall(harness.url, { action: "record_stop" });
    expect(stopped.isError).toBe(false);
    expect(textOf(stopped)).toContain("Recorded 3 frames");
    const files = writtenFiles(stopped);
    expect(files).toHaveLength(1);
    const url = files[0]?.url ?? "";
    expect(url).toContain("/mcp/myna/browser/files/");

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/gif");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    // A web page elsewhere is refused; this computer's own pages are not.
    expect((await fetch(url, { headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(url, { headers: { origin: "http://localhost:8081" } })).status).toBe(200);
    const gif = Buffer.from(await response.arrayBuffer());
    const info = gifInfo(gif);
    expect(info.width).toBe(800);
    expect(info.frames).toHaveLength(3);
    expect(info.frames.map((frame) => frame.delay)).toEqual([100, 100, 300]);
    expect(info.loops).toBe(true);
    expect(info.frames[0]?.width).toBe(800);

    // The action is written under each picture: white glyphs in the strip.
    const decoded = await sharp(gif).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = decoded.info;
    let white = 0;
    for (let y = height - 22; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * channels;
        if ((decoded.data[at] ?? 0) > 240 && (decoded.data[at + 1] ?? 0) > 240) {
          white += 1;
        }
      }
    }
    expect(white).toBeGreaterThan(0);
    socket.close();
  });

  it("keeps no frame for an action that changes nothing", async () => {
    const harness = await startHarness();
    const socket = await connectExtension(
      harness.url,
      "chrome-extension://dmlhojidlfnkgamkekjhacgkpanbkeko",
    );
    socket.send(JSON.stringify({ type: "hello", version: "0.1.4", agent: "Chrome/140" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    serveExtension(socket, PICTURE);

    await browserCall(harness.url, { action: "record_start" });
    await browserCall(harness.url, { action: "snapshot" });
    const stopped = await browserCall(harness.url, { action: "record_stop" });
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toContain("no frames");
    socket.close();
  });

  it("keeps the first 300 frames and drops a recording nobody stopped", () => {
    let now = 1_000_000;
    const recordings = new BrowserRecordings({ now: () => now });
    recordings.start("a");
    for (let i = 0; i < RECORD_MOST + 1; i += 1) {
      recordings.add("a", Buffer.from([i & 0xff]));
    }
    expect(recordings.count("a")).toBe(RECORD_MOST);
    expect(recordings.stop("a")?.full).toBe(true);

    recordings.start("b");
    now += RECORD_IDLE_MS + 1;
    recordings.start("c");
    expect(recordings.on("b")).toBe(false);
    expect(recordings.on("c")).toBe(true);
  });

  it("opens a kept file with its link, the key that made it, or on this computer", () => {
    let now = 1_000_000;
    let named = 0;
    const store = new BrowserFileStore({ now: () => now, name: () => `file${(named += 1)}` });
    const kept = store.keep(Buffer.from("GIF89a"), "image/gif", "key-a");
    const [name = "", token = ""] = kept.split(`?${BROWSER_FILE_TOKEN}=`);
    const live = (): boolean => true;

    expect(store.read({ name, token: null, key: null, local: true, keyLive: live }).ok).toBe(true);
    expect(refusal(store.read({ name, token: null, key: null, local: false, keyLive: live }))).toBe(
      403,
    );
    expect(store.read({ name, token, key: null, local: false, keyLive: live }).ok).toBe(true);
    expect(
      refusal(store.read({ name, token: "1.nope", key: null, local: false, keyLive: live })),
    ).toBe(401);
    expect(store.read({ name, token: null, key: "key-a", local: false, keyLive: live }).ok).toBe(
      true,
    );
    expect(
      refusal(store.read({ name, token: null, key: "key-b", local: false, keyLive: live })),
    ).toBe(404);
    // Revoking the key takes its links with it.
    expect(
      refusal(store.read({ name, token, key: null, local: false, keyLive: () => false })),
    ).toBe(401);
    // A file is kept for an hour.
    now += 60 * 60 * 1000 + 1;
    expect(store.read({ name, token, key: null, local: true, keyLive: live }).ok).toBe(false);
  });
});
