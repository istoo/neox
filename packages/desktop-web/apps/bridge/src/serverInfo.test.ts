import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import { ProviderDirectory } from "./providers.ts";
import {
  channelFromVersion,
  environmentDescriptor,
  environmentIdFor,
  legacyEnvironmentId,
  providerStatuses,
  runtimeStatus,
  serverConfig,
  serverSettings,
  worktreesDirFor,
} from "./serverInfo.ts";

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

function infoClient(serverInfo: unknown): DaemonClient {
  return {
    getLastServerInfoMessage: () => serverInfo,
    listAvailableProviders: async () => ({ providers: [] }),
  } as unknown as DaemonClient;
}

describe("environmentDescriptor", () => {
  it("reports the daemon's version and derives its channel", () => {
    const descriptor = environmentDescriptor({
      environmentId: "srv-1",
      serverVersion: "0.16.5",
      features: { connectedHosts: true, hostMultiplexing: true },
    });
    expect(descriptor).toMatchObject({
      environmentId: "srv-1",
      channel: "stable",
      serverVersion: "0.16.5",
      capabilities: { remoteConnections: true, repositoryIdentity: false },
    });
  });

  it("does not claim remote connections without the daemon's host features", () => {
    const descriptor = environmentDescriptor({
      environmentId: "srv-1",
      serverVersion: "0.16.5-beta.2",
      features: { connectedHosts: true },
    });
    expect(descriptor.channel).toBe("beta");
    expect(descriptor.capabilities.remoteConnections).toBe(false);
  });

  it("says unknown rather than inventing a build before server_info arrives", () => {
    const descriptor = environmentDescriptor({ environmentId: "srv-1" });
    expect(descriptor.serverVersion).toBe("unknown");
    expect(descriptor.channel).toBeUndefined();
  });

  it("maps only release suffixes to channels", () => {
    expect(channelFromVersion("1.2.3")).toBe("stable");
    expect(channelFromVersion("1.2.3-canary.4")).toBe("canary");
    expect(channelFromVersion("1.2.3-dev")).toBe("dev");
    expect(channelFromVersion("next")).toBeNull();
    expect(channelFromVersion(null)).toBeNull();
  });

  it("takes the environment id from server_info and keeps the address out of it", () => {
    expect(environmentIdFor(infoClient({ serverId: "srv-1" }), "legacy")).toBe("srv-1");
    expect(environmentIdFor(infoClient(undefined), "legacy")).toBe("legacy");
    expect(legacyEnvironmentId("127.0.0.1:6768")).toBe("neolix-127-0-0-1-6768");
  });
});

describe("serverConfig", () => {
  it("uses the host's paths instead of this machine's home", async () => {
    const config = await serverConfig(infoClient(undefined), new ProviderDirectory(), {
      cwd: "/remote/home",
      homeDir: "/remote/home",
      worktreesDir: "/remote/home/worktrees",
      keybindings: {
        path: "/bridge/desktop-web/keybindings.json",
        resolved: {},
        issues: [],
      } as never,
    });
    expect(config).toMatchObject({
      cwd: "/remote/home",
      homeDir: "/remote/home",
      worktreesDir: "/remote/home/worktrees",
      keybindingsConfigPath: "/bridge/desktop-web/keybindings.json",
    });
  });
});

describe("worktreesDirFor", () => {
  it("uses the daemon's resolved root, including a custom worktrees.root", async () => {
    const daemon = {
      getLastServerInfoMessage: () => ({ features: { daemonWorktreesRoot: true } }),
      getDaemonStatus: async () => ({ worktreesRoot: "/srv/custom-worktrees" }),
    } as unknown as DaemonClient;

    await expect(worktreesDirFor(daemon, "/home/worktrees")).resolves.toBe("/srv/custom-worktrees");
  });

  it("keeps the documented default for a daemon that predates the field", async () => {
    const daemon = {
      getLastServerInfoMessage: () => ({ features: {} }),
      getDaemonStatus: async () => {
        throw new Error("the old host has no status RPC");
      },
    } as unknown as DaemonClient;

    await expect(worktreesDirFor(daemon, "/home/worktrees")).resolves.toBe("/home/worktrees");
  });
});

describe("runtimeStatus", () => {
  it("maps the daemon's sampled event-loop window to the contract", async () => {
    const daemon = {
      getLastServerInfoMessage: () => ({ features: { daemonRuntimeStatus: true } }),
      getDaemonRuntimeStatus: async () => ({
        sampleWindowMs: 12_000,
        sampleCount: 1_193,
        delayP50Ms: 1.2,
        delayP99Ms: 8.4,
        delayMaxMs: 14.1,
        utilization: 0.42,
        stallWindowCount: 1,
        maxStallMs: 640,
        lastStall: { durationMs: 640, ageMs: 2_500 },
      }),
    } as unknown as DaemonClient;

    await expect(runtimeStatus(daemon)).resolves.toEqual({
      available: true,
      sampleWindowMs: 12_000,
      sampleCount: 1_193,
      delayP50Ms: 1.2,
      delayP99Ms: 8.4,
      delayMaxMs: 14.1,
      utilization: 0.42,
      stallWindowCount: 1,
      maxStallMs: 640,
      lastStall: { durationMs: 640, ageMs: 2_500 },
    });
  });

  it("asks for a host update instead of inventing zeros", async () => {
    const daemon = infoClient({ features: {} });
    await expect(runtimeStatus(daemon)).rejects.toThrow("Update the host to read runtime status.");
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
