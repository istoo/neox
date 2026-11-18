import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestNeolixDaemon } from "../test-utils/neolix-daemon.js";

const FIXTURE = path.join(import.meta.dirname, "test-fixtures", "derived-provider-plugin");

test("a plugin provider supporting account derivation serves a derived provider, and a bad extends blocks nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neolix-derived-provider-"));
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const directory = path.join(root, "derived-provider-plugin");
  await cp(FIXTURE, directory, { recursive: true });

  const daemon = await createTestNeolixDaemon({
    daemonVersion: "0.14.0-beta.1",
    mcpEnabled: false,
    pluginsEnabled: true,
    providerOverrides: {
      "plugin-account": { extends: "plugin-base", label: "Plugin account" },
      "typo-account": { extends: "absent-provider", label: "Typo account" },
    },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.installDirectoryPlugin(directory);
    await vi.waitFor(
      async () => {
        const snapshot = await client.getProvidersSnapshot({ cwd: root });
        const base = snapshot.entries.find((entry) => entry.provider === "plugin-base");
        const derived = snapshot.entries.find((entry) => entry.provider === "plugin-account");
        if (base?.status === "loading" || derived?.status === "loading") {
          throw new Error("plugin providers are still loading");
        }
      },
      { timeout: 20_000, interval: 100 },
    );
    const snapshot = await client.getProvidersSnapshot({ cwd: root });
    expect(snapshot.entries.find((entry) => entry.provider === "plugin-base")?.status).toBe(
      "ready",
    );
    expect(snapshot.entries.find((entry) => entry.provider === "plugin-account")?.status).toBe(
      "ready",
    );
    // The provider whose base is absent is skipped; it never takes the rest down.
    expect(snapshot.entries.some((entry) => entry.provider === "typo-account")).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
  }
});
