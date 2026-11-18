import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestNeolixDaemon, type TestNeolixDaemon } from "../test-utils/neolix-daemon.js";
import { disposeSharedAgentConnectServices } from "./service.js";

/** A free loopback port other than `exclude`: a stopped daemon's port may be reused. */
async function freePort(exclude: number): Promise<number> {
  for (;;) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (typeof address === "object" && address !== null) resolve(address.port);
          else reject(new Error("No port"));
        });
      });
    });
    if (port !== exclude) return port;
  }
}

async function startDaemon(homeRoot: string, staticName: string, port = 0) {
  return createTestNeolixDaemon({
    daemonVersion: "0.14.0-beta.1",
    mcpEnabled: false,
    neolixHomeRoot: homeRoot,
    staticDir: path.join(homeRoot, staticName),
    listenPort: port,
    cleanup: false,
  });
}

async function connect(daemon: TestNeolixDaemon): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  return client;
}

async function claudeBaseUrl(file: string): Promise<string | undefined> {
  const written = JSON.parse(await readFile(file, "utf8")) as {
    env?: { ANTHROPIC_BASE_URL?: string };
  };
  return written.env?.ANTHROPIC_BASE_URL;
}

test("a connected agent follows the gateway to a new port", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neolix-agent-connect-follow-"));
  const previousHome = process.env.HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const claudeConfig = path.join(root, "claude-config");
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  onTestFinished(async () => {
    disposeSharedAgentConnectServices();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  });
  const settings = path.join(claudeConfig, "settings.json");

  const first = await startDaemon(root, "static-a");
  let client: DaemonClient | undefined;
  try {
    client = await connect(first);
    const set = await client.setAgentConnect({ provider: "claude", connected: true });
    expect(set.snapshot.error).toBeNull();
    expect(await claudeBaseUrl(settings)).toBe(`http://127.0.0.1:${first.port}`);
  } finally {
    await client?.close();
    await first.close();
    disposeSharedAgentConnectServices();
  }

  const secondPort = await freePort(first.port);
  const second = await startDaemon(root, "static-b", secondPort);
  client = undefined;
  try {
    expect(second.port).not.toBe(first.port);
    client = await connect(second);
    await vi.waitFor(
      async () => expect(await claudeBaseUrl(settings)).toBe(`http://127.0.0.1:${second.port}`),
      { timeout: 10_000, interval: 100 },
    );
  } finally {
    await client?.close();
    await second.close();
  }
});

test("an address the user edited is not rewritten when the gateway moves", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neolix-agent-connect-kept-"));
  const previousHome = process.env.HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const claudeConfig = path.join(root, "claude-config");
  process.env.HOME = root;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  onTestFinished(async () => {
    disposeSharedAgentConnectServices();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
  });
  const settings = path.join(claudeConfig, "settings.json");
  await mkdir(path.dirname(settings), { recursive: true });

  const first = await startDaemon(root, "static-a");
  let client: DaemonClient | undefined;
  try {
    client = await connect(first);
    expect(
      (await client.setAgentConnect({ provider: "claude", connected: true })).snapshot.error,
    ).toBeNull();
  } finally {
    await client?.close();
    await first.close();
    disposeSharedAgentConnectServices();
  }

  // The user points Claude somewhere of their own.
  const written = JSON.parse(await readFile(settings, "utf8")) as {
    env: { ANTHROPIC_BASE_URL: string };
  };
  written.env.ANTHROPIC_BASE_URL = "https://api.anthropic.example";
  await writeFile(settings, JSON.stringify(written, null, 2));

  const secondPort = await freePort(first.port);
  const second = await startDaemon(root, "static-b", secondPort);
  client = undefined;
  try {
    client = await connect(second);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await claudeBaseUrl(settings)).toBe("https://api.anthropic.example");
  } finally {
    await client?.close();
    await second.close();
  }
});
