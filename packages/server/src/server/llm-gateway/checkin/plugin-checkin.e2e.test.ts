import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestNeolixDaemon } from "../../test-utils/neolix-daemon.js";

const FIXTURE = path.join(import.meta.dirname, "test-fixtures", "checkin-subscription-plugin");
const PLUGIN_ID = "checkin-subscription-plugin";

test("a plugin's check-in row appears in status and runs through the daemon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "neolix-plugin-checkin-daemon-"));
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, ".config");
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const directory = path.join(root, "plugin");
  await cp(FIXTURE, directory, { recursive: true });

  let daemon: Awaited<ReturnType<typeof createTestNeolixDaemon>> | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestNeolixDaemon({
      daemonVersion: "0.14.0-beta.1",
      mcpEnabled: false,
      pluginsEnabled: true,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.14.0-beta.1",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.installDirectoryPlugin(directory);

    const accountsDir = path.join(daemon.neolixHome, "plugin-settings", PLUGIN_ID);
    await mkdir(accountsDir, { recursive: true });
    await writeFile(
      path.join(accountsDir, "accounts.json"),
      `${JSON.stringify({ version: 1, accounts: { ann: { accountId: "Ann" } } })}\n`,
    );

    const before = await client.getGatewayCheckin();
    expect(before.switches).toMatchObject({ "demo-checkin": false });
    expect(before.accounts).toEqual([
      expect.objectContaining({
        by: "plugin:demo-checkin",
        key: `${PLUGIN_ID}|demo-checkin|ann`,
        user: "Ann",
        on: true,
      }),
    ]);

    await client.setGatewayCheckinSwitch("demo-checkin", true);
    const run = await client.runGatewayCheckin();
    expect(run.entries).toEqual([
      expect.objectContaining({
        by: "plugin:demo-checkin",
        outcome: "claimed",
        credit: 42,
        msg: "checked in ann",
        asked: true,
      }),
    ]);

    const after = await client.getGatewayCheckin();
    expect(after.accounts[0]?.record).toMatchObject({ outcome: "claimed", credit: 42 });

    // A second press the same Beijing day is settled, so the plugin is not asked again.
    const again = await client.runGatewayCheckin();
    expect(again.entries).toEqual([
      expect.objectContaining({ by: "plugin:demo-checkin", outcome: "claimed", asked: false }),
    ]);
  } finally {
    await client?.close();
    await daemon?.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});
