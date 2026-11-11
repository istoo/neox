import { describe, expect, it } from "vitest";

import {
  daemonPatchForSettingsPatch,
  daemonProviderIdForInstanceId,
  deriveProviderSettingsFromDaemon,
  localProviderSettingsPatch,
  providerInstancesToDaemonPatch,
  providerSettingsToDaemonPatch,
} from "./providerConfig.ts";
import { providerInstanceConfigs } from "./providers.ts";

describe("provider config translation", () => {
  it("maps default-instance fields onto the daemon's built-in provider", () => {
    expect(
      providerSettingsToDaemonPatch({
        claudeAgent: { binaryPath: "/opt/claude", homePath: "/tmp/claude-work" },
        opencode: { binaryPath: "/opt/opencode", serverUrl: "http://127.0.0.1:4096" },
      }),
    ).toEqual({
      providers: {
        claude: {
          command: ["/opt/claude"],
          env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
        },
        opencode: {
          command: ["/opt/opencode"],
          env: { NEOLIX_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" },
        },
      },
    });
  });

  it("restores the default binary when the override is cleared", () => {
    expect(providerSettingsToDaemonPatch({ claudeAgent: { binaryPath: "" } })).toEqual({
      providers: { claude: { command: ["claude"] } },
    });
  });

  it("writes Cursor as an ACP provider the daemon can register", () => {
    expect(providerSettingsToDaemonPatch({ cursor: { enabled: true } })).toEqual({
      providers: {
        cursor: {
          enabled: true,
          extends: "acp",
          label: "Cursor",
          command: ["cursor-agent", "acp"],
        },
      },
    });
    expect(
      providerSettingsToDaemonPatch(
        { cursor: { binaryPath: "/opt/cursor-agent" } },
        { cursor: { extends: "acp", label: "Cursor", command: ["cursor-agent", "acp"] } },
      ),
    ).toEqual({
      providers: {
        cursor: { extends: "acp", label: "Cursor", command: ["/opt/cursor-agent", "acp"] },
      },
    });
    expect(
      providerInstancesToDaemonPatch(
        { cursor: { driver: "cursor", enabled: false } },
        { cursor: { extends: "acp", command: ["/opt/cursor-agent", "acp"] } },
      ),
    ).toEqual({
      providers: {
        cursor: {
          enabled: false,
          extends: "acp",
          label: "Cursor",
          command: ["/opt/cursor-agent", "acp"],
        },
      },
    });
  });

  it("clears the daemon's custom models when the last one is removed", () => {
    expect(
      providerSettingsToDaemonPatch(
        { codex: { customModels: [] } },
        { codex: { additionalModels: [{ id: "qa-model", label: "qa-model" }] } },
      ),
    ).toEqual({ providers: { codex: { additionalModels: [] } } });
    expect(
      providerInstancesToDaemonPatch(
        { codex: { driver: "codex", config: { customModels: [] } } },
        { codex: { additionalModels: [{ id: "qa-model", label: "qa-model" }] } },
      ),
    ).toMatchObject({ providers: { codex: { additionalModels: [] } } });
    // Nothing to clear: an untouched provider stays out of the patch.
    expect(providerSettingsToDaemonPatch({ codex: { customModels: [] } }, {})).toBeNull();
  });

  it("replaces the env map from the current daemon entry when clearing a field", () => {
    expect(
      providerSettingsToDaemonPatch(
        { claudeAgent: { homePath: "" } },
        { claude: { env: { CLAUDE_CONFIG_DIR: "/tmp/old", ANTHROPIC_BASE_URL: "http://x" } } },
      ),
    ).toEqual({
      providers: { claude: { env: { ANTHROPIC_BASE_URL: "http://x" } } },
    });
  });

  it("creates a derived daemon provider for an extra account", () => {
    expect(
      providerInstancesToDaemonPatch({
        claude_work: {
          driver: "claudeAgent",
          displayName: "Work",
          enabled: true,
          config: { binaryPath: "/opt/claude", configDir: "/tmp/claude-work" },
          environment: [{ name: "ANTHROPIC_BASE_URL", value: "https://proxy.example" }],
        },
      }),
    ).toEqual({
      providers: {
        "claude-work": {
          extends: "claude",
          label: "Work",
          enabled: true,
          command: ["/opt/claude"],
          env: {
            ANTHROPIC_BASE_URL: "https://proxy.example",
            CLAUDE_CONFIG_DIR: "/tmp/claude-work",
          },
        },
      },
    });
  });

  it("removes the daemon provider when its only account is deleted", () => {
    expect(
      providerInstancesToDaemonPatch(
        { codex: { driver: "codex" } },
        {
          codex: { command: ["codex"] },
          "codex-work": { extends: "codex", label: "Work", enabled: true },
        },
      ),
    ).toEqual({ providers: {}, removeProviders: ["codex-work"] });
    // An account that is still in the map keeps its daemon provider, even when the map only
    // carries presentation fields for it.
    expect(
      providerInstancesToDaemonPatch(
        { codex_work: { driver: "codex", displayName: "Work", accentColor: "#2563eb" } },
        { "codex-work": { extends: "codex", label: "Work" } },
      ),
    ).toBeNull();
  });

  it("keeps redacted environment values from the daemon", () => {
    expect(
      providerInstancesToDaemonPatch(
        {
          claude_work: {
            driver: "claudeAgent",
            config: { configDir: "/tmp/claude-work" },
            environment: [{ name: "ANTHROPIC_API_KEY", value: "", valueRedacted: true }] as never,
          },
        },
        {
          "claude-work": {
            env: {
              ANTHROPIC_API_KEY: "{{SECRET_zz91kk2a}}",
              CLAUDE_CONFIG_DIR: "/tmp/old",
            },
          },
        },
      ),
    ).toEqual({
      providers: {
        "claude-work": {
          extends: "claude",
          label: "claude_work",
          env: {
            ANTHROPIC_API_KEY: "{{SECRET_zz91kk2a}}",
            CLAUDE_CONFIG_DIR: "/tmp/claude-work",
          },
        },
      },
    });
  });

  it("keeps a redacted OpenCode server password", () => {
    expect(
      providerInstancesToDaemonPatch(
        {
          opencode_work: {
            driver: "opencode",
            config: { serverUrl: "http://127.0.0.1:4096", serverPasswordRedacted: true },
          },
        },
        {
          "opencode-work": {
            env: { NEOLIX_OPENCODE_SERVER_PASSWORD: "{{SECRET_qq0w1e2r}}" },
          },
        },
      ),
    ).toMatchObject({
      providers: {
        "opencode-work": {
          env: {
            NEOLIX_OPENCODE_SERVER_URL: "http://127.0.0.1:4096",
            NEOLIX_OPENCODE_SERVER_PASSWORD: "{{SECRET_qq0w1e2r}}",
          },
        },
      },
    });
  });

  it("keeps the default account's home while editing its environment", () => {
    expect(
      providerInstancesToDaemonPatch(
        {
          claudeAgent: {
            driver: "claudeAgent",
            environment: [{ name: "FOO", value: "2" }],
          },
        },
        {
          claude: { env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home", FOO: "1", BAR: "gone" } },
        },
      ),
    ).toEqual({
      providers: {
        claude: { env: { FOO: "2", CLAUDE_CONFIG_DIR: "/tmp/claude-home" } },
      },
    });
  });

  it("skips catalog-only instances for plugin providers", () => {
    expect(
      providerInstancesToDaemonPatch({
        "neolix-gateway": { driver: "claudeAgent", displayName: "Neox Gateway", enabled: true },
      }),
    ).toBeNull();
  });

  it("skips accounts the daemon cannot derive", () => {
    expect(
      providerInstancesToDaemonPatch({
        grok_work: {
          driver: "grok",
          config: { binaryPath: "/opt/grok" },
        },
      }),
    ).toBeNull();
  });

  it("marks providers without a driver of their own so they are not shown as Claude accounts", () => {
    const derived = deriveProviderSettingsFromDaemon({
      "neolix-gateway": { extends: "claude", label: "Neox Gateway" },
      copilot: { extends: "acp", label: "GitHub Copilot" },
    });
    expect(derived.providerInstances["copilot"]).toMatchObject({
      driver: "claudeAgent",
      config: { ownIdentity: true },
    });
    expect(derived.providerInstances["neolix-gateway"]?.config).not.toHaveProperty("ownIdentity");
    expect(
      providerInstanceConfigs([{ provider: "copilot", available: true }], () => "GitHub Copilot"),
    ).toEqual({
      copilot: {
        driver: "claudeAgent",
        displayName: "GitHub Copilot",
        enabled: true,
        config: { ownIdentity: true },
      },
    });
  });

  it("derives the settings view from daemon overrides", () => {
    const derived = deriveProviderSettingsFromDaemon({
      claude: {
        command: ["/opt/claude"],
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work" },
      },
      "claude-work": {
        extends: "claude",
        label: "Work",
        env: { CLAUDE_CONFIG_DIR: "/tmp/claude-work", ANTHROPIC_API_KEY: "test-value" },
        additionalModels: [{ id: "glm-5", label: "GLM 5" }],
      },
      "usage-source": { enabled: false },
    });

    expect(derived.providers.claudeAgent).toEqual({
      binaryPath: "/opt/claude",
      homePath: "/tmp/claude-work",
    });
    expect(derived.providerInstances["claude-work"]).toMatchObject({
      driver: "claudeAgent",
      displayName: "Work",
      enabled: true,
      config: {
        configDir: "/tmp/claude-work",
        customModels: ["glm-5"],
      },
    });
    expect(derived.providerInstances["usage-source"]).toMatchObject({
      driver: "claudeAgent",
      enabled: false,
    });
  });

  it("normalizes instance ids to daemon provider ids", () => {
    expect(daemonProviderIdForInstanceId("claudeAgent")).toBe("claude");
    expect(daemonProviderIdForInstanceId("claude_work")).toBe("claude-work");
    expect(daemonProviderIdForInstanceId("Work")).toBe("work");
  });

  it("keeps only presentation fields in the bridge-local file", () => {
    const local = localProviderSettingsPatch({
      providers: {
        claudeAgent: { binaryPath: "/opt/claude", enableArtifacts: true },
      },
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          displayName: "Work",
          accentColor: "#fff",
          config: { binaryPath: "/opt/claude" },
        },
      },
    });

    expect(local).toEqual({
      providers: { claudeAgent: { enableArtifacts: true } },
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Work", accentColor: "#fff" },
      },
    });
  });

  it("combines provider and instance patches for one daemon write", () => {
    expect(
      daemonPatchForSettingsPatch({
        providers: { codex: { enabled: false } },
        providerInstances: {
          codex_work: { driver: "codex", config: { homePath: "/tmp/codex-work" } },
        },
      }),
    ).toEqual({
      providers: {
        codex: { enabled: false },
        "codex-work": {
          extends: "codex",
          label: "codex_work",
          env: { CODEX_HOME: "/tmp/codex-work" },
        },
      },
    });
  });
});
