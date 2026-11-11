import { WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { makeHandlers } from "./handlers.ts";
import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { ProjectPins } from "./projectPins.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("server.updateSettings provider wiring", () => {
  it("writes a provider instance to the daemon and keeps its launch config out of the local file", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-provider-settings-"));
    dirs.push(home);
    const patched: unknown[] = [];
    let daemonProviders: Record<string, unknown> = {};
    const client = {
      listAvailableProviders: async () => ({
        providers: [{ provider: "claude", available: true, error: null }],
      }),
      getDaemonConfig: async () => ({
        requestId: "r1",
        config: { providers: daemonProviders },
      }),
      patchDaemonConfig: async (patch: unknown) => {
        patched.push(patch);
        const providers = (patch as { providers?: Record<string, unknown> }).providers ?? {};
        daemonProviders = { ...daemonProviders, ...providers };
        return { requestId: "r2", config: { providers: daemonProviders } };
      },
    } as unknown as DaemonClient;
    const model = { client } as unknown as BridgeModel;
    const projectPins = new ProjectPins({
      file: path.join(home, "desktop-web", "project-pins.json"),
      scope: "test",
      log: () => {},
    });
    await projectPins.load();
    const handlers = makeHandlers(model, {
      environmentId: "env-test",
      home,
      log: () => {},
      projectPins,
    });

    await Effect.runPromise(
      handlers[WS_METHODS.serverUpdateSettings]!(
        {
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              displayName: "Work",
              config: { configDir: "/tmp/a5-claude-work" },
            },
          },
        },
        undefined,
      ) as never,
    );

    expect(patched).toEqual([
      {
        providers: {
          "claude-work": {
            extends: "claude",
            label: "Work",
            env: { CLAUDE_CONFIG_DIR: "/tmp/a5-claude-work" },
          },
        },
      },
    ]);
    const saved = JSON.parse(
      await fs.readFile(path.join(home, "desktop-web", "settings.json"), "utf8"),
    );
    expect(saved.providerInstances).toEqual({
      claude_work: { driver: "claudeAgent", displayName: "Work" },
    });
  });
});
