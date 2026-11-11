import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import { ProviderDirectory } from "./providers.ts";
import { providerStatuses, serverSettings } from "./serverInfo.ts";

function client(overrides: Record<string, unknown>): DaemonClient {
  return {
    listAvailableProviders: async () => ({
      providers: [
        { provider: "claude", available: false, error: null },
        { provider: "claude-work", available: true, error: null },
      ],
    }),
    getDaemonConfig: async () => ({ requestId: "r1", config: { providers: overrides } }),
  } as unknown as DaemonClient;
}

describe("providerStatuses", () => {
  it("names plugin providers with the daemon's label and asks for it once", async () => {
    let snapshots = 0;
    const daemon = {
      listAvailableProviders: async () => ({
        providers: [
          { provider: "claude", available: true, error: null },
          { provider: "muse", available: false, error: "not installed" },
          { provider: "unnamed", available: true, error: null },
        ],
      }),
      getProvidersSnapshot: async () => {
        snapshots += 1;
        return { entries: [{ provider: "muse", label: "Muse Code" }] };
      },
    } as unknown as DaemonClient;

    const statuses = await providerStatuses(daemon, new ProviderDirectory());
    expect(statuses.map((status) => status.displayName)).toEqual([
      "Claude",
      "Muse Code",
      "unnamed",
    ]);

    // Every provider has been asked about once, so a later read does not fetch again.
    await providerStatuses(daemon, new ProviderDirectory());
    expect(snapshots).toBe(1);
  });
});

describe("serverSettings", () => {
  it("derives provider instances from the daemon's provider config", async () => {
    const settings = await serverSettings(
      client({
        "claude-work": {
          extends: "claude",
          label: "Work",
          env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
          command: ["/opt/claude"],
        },
      }),
      new ProviderDirectory(),
    );

    expect(settings.providerInstances["claude-work"]).toMatchObject({
      driver: "claudeAgent",
      displayName: "Work",
      enabled: true,
      config: { configDir: "/tmp/claude-work", binaryPath: "/opt/claude" },
    });
  });

  it("shows default-provider overrides in the provider settings", async () => {
    const settings = await serverSettings(
      client({
        claude: {
          command: ["/opt/claude"],
          env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home" },
          enabled: false,
        },
      }),
      new ProviderDirectory(),
    );

    expect(settings.providers.claudeAgent).toMatchObject({
      binaryPath: "/opt/claude",
      homePath: "/tmp/claude-home",
      enabled: false,
    });
  });

  it("starts opt-in drivers disabled until the daemon config turns them on", async () => {
    const settings = await serverSettings(client({}), new ProviderDirectory());

    for (const driver of ["omp", "cursor", "grok", "droid", "devin"] as const) {
      expect(settings.providers[driver].enabled).toBe(false);
    }
    expect(settings.providers.claudeAgent.enabled).toBe(true);

    const configured = await serverSettings(
      client({
        omp: { enabled: true },
        cursor: { extends: "acp", command: ["cursor-agent", "acp"], label: "Cursor" },
      }),
      new ProviderDirectory(),
    );
    expect(configured.providers.omp.enabled).toBe(true);
    expect(configured.providers.cursor.enabled).toBe(true);
  });

  it("keeps Cursor disabled when its daemon entry is not an ACP provider", async () => {
    const settings = await serverSettings(
      client({ cursor: { enabled: true } }),
      new ProviderDirectory(),
    );
    expect(settings.providers.cursor.enabled).toBe(false);
  });
});
