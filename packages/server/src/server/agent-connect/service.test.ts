import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "../llm-gateway/config.js";
import type { LibraryService } from "../library/index.js";
import {
  AgentConnectService,
  disposeSharedAgentConnectServices,
  sharedAgentConnectService,
} from "./service.js";
import type { AgentConnectDriver, ConnectEnvironment } from "./drivers.js";
import { tomlString } from "./config-files.js";

function gateway(): GatewayConfig {
  return {
    ...EMPTY_GATEWAY_CONFIG,
    providers: [
      {
        id: "deepseek",
        label: "DeepSeek",
        protocol: "openai",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        models: [
          { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
          { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
        ],
        accounts: [],
        headers: {},
        enabled: true,
        maxAccounts: 1,
        queueWaitMs: 0,
        sink: false,
        priceRate: 1,
        videoApi: undefined,
      },
    ],
    groups: [],
    keys: ["gateway-key"],
  } as unknown as GatewayConfig;
}

function emptyGateway(): GatewayConfig {
  return { ...EMPTY_GATEWAY_CONFIG };
}

function gatewayWithoutProModel(): GatewayConfig {
  const base = gateway();
  return {
    ...base,
    providers: base.providers.map((provider) =>
      Object.assign({}, provider, {
        models: provider.models.filter((model) => model.id !== "deepseek-v4-pro"),
      }),
    ),
  };
}

function findEntry(
  snapshot: { entries: Array<{ provider: string; connected: boolean; drift?: string | null }> },
  provider: string,
) {
  return snapshot.entries.find((entry) => entry.provider === provider);
}

/** The model ids a Pi models.json names under Neolix's provider. */
function piModelIds(root: unknown): string[] {
  const models =
    (root as { providers?: { neolix?: { models?: { id?: string }[] } } }).providers?.neolix
      ?.models ?? [];
  return models.map((model) => model.id ?? "");
}

/** The model ids an OpenCode config names under Neolix's provider. */
function openCodeModelIds(root: unknown): string[] {
  const models =
    (root as { provider?: { neolix?: { models?: Record<string, unknown> } } }).provider?.neolix
      ?.models ?? {};
  return Object.keys(models);
}

describe("AgentConnectService", () => {
  let home: string;
  let neolixHome: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-agent-connect-home-"));
    neolixHome = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-agent-connect-daemon-"));
  });

  afterEach(async () => {
    disposeSharedAgentConnectServices();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(neolixHome, { recursive: true, force: true });
  });

  function service(
    options: {
      config?: GatewayConfig;
      baseUrl?: string | null;
      pluginProviders?: () => Array<{ pluginId: string; providers: string[] }>;
      library?: () => LibraryService | null;
      run?: (command: string, args: string[], input?: string) => Promise<string>;
      probeVersions?: boolean;
      writeAgentPref?: (
        key: "codexSubagentModel" | "codexLogin" | "codexMemories",
        value: string | undefined,
      ) => Promise<void>;
    } = {},
  ) {
    return new AgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      gatewayConfig: () => options.config ?? gateway(),
      gatewayBaseUrl: () =>
        options.baseUrl === undefined ? "http://127.0.0.1:6768" : options.baseUrl,
      ...(options.pluginProviders === undefined
        ? {}
        : { pluginProviders: options.pluginProviders }),
      ...(options.library === undefined ? {} : { library: options.library }),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.probeVersions === undefined ? {} : { probeVersions: options.probeVersions }),
      ...(options.writeAgentPref === undefined ? {} : { writeAgentPref: options.writeAgentPref }),
    });
  }

  it("points Claude Code at the gateway and puts its settings back", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    const original = {
      model: "claude-opus-4-7",
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.example",
        ANTHROPIC_AUTH_TOKEN: "sk-user-token",
      },
      permissions: { allow: ["Bash"] },
    };
    await fs.writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

    const connected = await service().set({
      provider: "claude",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const entry = connected.entries.find((item) => item.provider === "claude");
    expect(entry?.connected).toBe(true);
    expect(entry?.model).toBe("deepseek/deepseek-v4-pro");
    expect(entry?.modelCount).toBe(2);
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:6768");
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBe("gateway-key");
    expect(written.model).toBe("deepseek/deepseek-v4-pro");
    expect(written.permissions).toEqual({ allow: ["Bash"] });
    // The pre-connect file is kept on disk as well as in the undo record.
    const backupPath = path.join(neolixHome, "agent-connect", "backups", "claude", "settings.json");
    expect(JSON.parse(await fs.readFile(backupPath, "utf8"))).toEqual(original);

    await service().set({ provider: "claude", connected: false });
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(original);
  });

  it("writes a Codex managed block and restores the file byte for byte", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = 'model = "gpt-5"\n\n[projects."/repo"]\ntrust_level = "trusted"\n';
    await fs.writeFile(configPath, original);

    const connected = await service().set({ provider: "codex", connected: true });
    const entry = connected.entries.find((item) => item.provider === "codex");
    expect(entry?.connected).toBe(true);
    const written = await fs.readFile(configPath, "utf8");
    expect(written).toContain("[model_providers.neolix]");
    expect(written).toContain('model_provider = "neolix"');
    expect(written).toContain('base_url = "http://127.0.0.1:6768/v1"');
    expect(written).toContain('trust_level = "trusted"');
    // The user's own model choice is displaced, not lost.
    expect(written.match(/^model = "gpt-5"$/m)).toBeNull();
    // Codex's picker reads the gateway's models from the catalog the file names.
    const catalogPath = path.join(home, ".codex", "neolix-codex-models.json");
    expect(written).toContain(`model_catalog_json = ${tomlString(catalogPath)}`);
    const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
      models: { slug: string; base_instructions: string }[];
    };
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.models[0]).toMatchObject({ slug: expect.stringContaining("/") });

    await service().set({ provider: "codex", connected: false });
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
    await expect(fs.access(catalogPath)).rejects.toThrow();
  });

  it("writes Pi's settings.json and models.json, then restores them", async () => {
    const dir = path.join(home, ".pi", "agent");
    await fs.mkdir(dir, { recursive: true });
    const settingsPath = path.join(dir, "settings.json");
    const modelsPath = path.join(dir, "models.json");
    await fs.writeFile(settingsPath, '{"defaultProvider":"anthropic","theme":"dark"}\n');
    await fs.writeFile(modelsPath, '{"providers":{"anthropic":{"models":[]}}}\n');

    await service().set({
      provider: "pi",
      connected: true,
      model: "deepseek/deepseek-v4-flash",
    });
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(settings.defaultProvider).toBe("neolix");
    expect(settings.defaultModel).toBe("deepseek/deepseek-v4-flash");
    expect(settings.theme).toBe("dark");
    const models = JSON.parse(await fs.readFile(modelsPath, "utf8"));
    expect(models.providers.neolix.baseUrl).toBe("http://127.0.0.1:6768/v1");
    expect(models.providers.neolix.models).toHaveLength(2);
    expect(models.providers.anthropic).toEqual({ models: [] });

    await service().set({ provider: "pi", connected: false });
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual({
      defaultProvider: "anthropic",
      theme: "dark",
    });
    expect(JSON.parse(await fs.readFile(modelsPath, "utf8"))).toEqual({
      providers: { anthropic: { models: [] } },
    });
  });

  it("reads and writes Claude Code's own fields", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await service().set({
      provider: "claude",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const setField = async (field: string, value: string) => {
      const snapshot = await service().set({ provider: "claude", connected: true, field, value });
      expect(snapshot.error).toBeNull();
      return snapshot.entries.find((item) => item.provider === "claude")?.settings;
    };
    const read = async () => JSON.parse(await fs.readFile(settingsPath, "utf8"));

    let settings = await setField("effort", "high");
    expect(settings?.find((item) => item.key === "effort")?.value).toBe("high");
    expect((await read()).effortLevel).toBe("high");

    settings = await setField("subagent", "deepseek/deepseek-v4-flash");
    expect(settings?.find((item) => item.key === "subagent")?.value).toBe(
      "deepseek/deepseek-v4-flash",
    );
    settings = await setField("subagent_effort", "high");
    expect(settings?.find((item) => item.key === "subagent_effort")?.value).toBe("high");
    expect((await read()).env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek/deepseek-v4-flash:high");

    await setField("auto_mode", "deepseek/deepseek-v4-flash");
    await setField("ultracode", "on");
    await setField("statusline", "on");
    let written = await read();
    expect(written.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(written.ultracode).toBe(true);
    expect(written.statusLine).toEqual({ type: "command", command: "neox statusline" });

    settings = await setField("login", "claudeai");
    expect(settings?.find((item) => item.key === "login")?.value).toBe("claudeai");
    written = await read();
    expect(written.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    // Default takes each one back to the agent's own.
    await setField("statusline", "");
    await setField("ultracode", "");
    await setField("auto_mode", "");
    await setField("subagent", "");
    written = await read();
    expect(written.statusLine).toBeUndefined();
    expect(written.ultracode).toBeUndefined();
    expect(written.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
  });

  it("reads and writes Codex's own fields", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    const prefs: Array<[string, string | undefined]> = [];
    const config = gateway();
    const codex = () =>
      service({
        config,
        writeAgentPref: async (key, value) => {
          prefs.push([key, value]);
          // The daemon keeps these in gateway.json, which the next read sees.
          if (value === undefined) delete (config as Record<string, unknown>)[key];
          else (config as Record<string, unknown>)[key] = value;
        },
      });
    await codex().set({ provider: "codex", connected: true });
    const setField = async (field: string, value: string) => {
      const snapshot = await codex().set({ provider: "codex", connected: true, field, value });
      expect(snapshot.error).toBeNull();
      return snapshot.entries.find((item) => item.provider === "codex")?.settings;
    };
    const read = () => fs.readFile(configPath, "utf8");

    await setField("model", "deepseek/deepseek-v4-flash");
    expect(await read()).toContain('model = "deepseek/deepseek-v4-flash"');
    await setField("effort", "high");
    expect(await read()).toContain('model_reasoning_effort = "high"');
    await setField("subagent", "deepseek/deepseek-v4-pro");
    expect(await read()).toContain('default_subagent_model = "deepseek/deepseek-v4-pro"');
    await setField("subagent_effort", "high");
    expect(await read()).toContain('default_subagent_reasoning_effort = "high"');
    await setField("memories", "deepseek/deepseek-v4-pro");
    const withMemories = await read();
    expect(withMemories).toContain('extract_model = "deepseek/deepseek-v4-pro"');
    expect(withMemories).toContain('consolidation_model = "deepseek/deepseek-v4-pro"');
    expect(prefs).toContainEqual(["codexMemories", undefined]);

    const settings = await setField("subagent_model", "lead");
    expect(settings?.find((item) => item.key === "subagent_model")?.value).toBe("lead");
    expect(prefs).toContainEqual(["codexSubagentModel", "lead"]);
    expect(await read()).not.toContain("default_subagent_model");

    await setField("login", "api");
    expect(prefs).toContainEqual(["codexLogin", "api"]);

    await setField("memories", "");
    const withoutMemories = await read();
    expect(withoutMemories).not.toContain("extract_model");
    expect(withoutMemories).not.toContain("consolidation_model");
  });

  it("reads and writes OpenCode's and Pi's model fields", async () => {
    const openCodePath = path.join(home, ".config", "opencode", "opencode.json");
    await service().set({
      provider: "opencode",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const openCode = await service().set({
      provider: "opencode",
      connected: true,
      field: "small",
      value: "deepseek/deepseek-v4-flash",
    });
    expect(
      openCode.entries
        .find((item) => item.provider === "opencode")
        ?.settings?.find((item) => item.key === "small")?.value,
    ).toBe("deepseek/deepseek-v4-flash");
    let written = JSON.parse(await fs.readFile(openCodePath, "utf8"));
    expect(written.small_model).toBe("neolix/deepseek/deepseek-v4-flash");

    await service().set({ provider: "opencode", connected: true, field: "model", value: "" });
    written = JSON.parse(await fs.readFile(openCodePath, "utf8"));
    expect(written.model).toBeUndefined();
    expect(written.small_model).toBe("neolix/deepseek/deepseek-v4-flash");

    const piPath = path.join(home, ".pi", "agent", "settings.json");
    await service().set({
      provider: "pi",
      connected: true,
      model: "deepseek/deepseek-v4-flash",
    });
    const pi = await service().set({
      provider: "pi",
      connected: true,
      field: "model",
      value: "deepseek/deepseek-v4-pro",
    });
    expect(
      pi.entries
        .find((item) => item.provider === "pi")
        ?.settings?.find((item) => item.key === "model")?.value,
    ).toBe("deepseek/deepseek-v4-pro");
    expect(JSON.parse(await fs.readFile(piPath, "utf8")).defaultModel).toBe(
      "deepseek/deepseek-v4-pro",
    );
  });

  it("writes OpenCode's provider entry and restores its model", async () => {
    const dir = path.join(home, ".config", "opencode");
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "opencode.json");
    const original = { theme: "dark", model: "anthropic/claude-sonnet-4" };
    await fs.writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`);

    const snapshot = await service().set({
      provider: "opencode",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    expect(snapshot.entries.find((item) => item.provider === "opencode")?.connected).toBe(true);
    const written = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(written.model).toBe("neolix/deepseek/deepseek-v4-pro");
    expect(written.provider.neolix.options.baseURL).toBe("http://127.0.0.1:6768/v1");
    expect(written.theme).toBe("dark");

    await service().set({ provider: "opencode", connected: false });
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(original);
  });

  it("saves and applies a profile", async () => {
    const connect = service();
    await connect.set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });
    const saved = await connect.saveProfile("Work");
    expect(saved.profiles.map((profile) => profile.name)).toEqual(["Work"]);

    await connect.set({ provider: "claude", connected: false });
    const applied = await connect.applyProfile("Work");
    const entry = applied.entries.find((item) => item.provider === "claude");
    expect(entry?.connected).toBe(true);
    expect(entry?.model).toBe("deepseek/deepseek-v4-pro");

    const deleted = await connect.deleteProfile("Work");
    expect(deleted.profiles).toEqual([]);
  });

  it("saves and applies the library's assignments with a profile", async () => {
    const calls: string[] = [];
    const library = {
      getSnapshot: async () => ({
        mcp: [{ name: "fs", agents: ["claude"] }],
        skills: [{ name: "review", agents: ["claude", "codex"] }],
        hooks: [{ name: "lint", agents: ["claude"] }],
        subagents: [{ name: "planner", agents: ["claude"] }],
        instructions: {
          agents: [
            { agent: "claude", on: true },
            { agent: "codex", on: false },
          ],
        },
        mcpHub: true,
      }),
      setMcpAgents: async (name: string, agents: string[]) => {
        calls.push(`mcp ${name} ${agents.join(",")}`);
      },
      setSkillAgents: async (name: string, agents: string[]) => {
        calls.push(`skill ${name} ${agents.join(",")}`);
      },
      setHookAgents: async (name: string, agents: string[]) => {
        calls.push(`hook ${name} ${agents.join(",")}`);
      },
      setSubagentAgents: async (name: string, agents: string[]) => {
        calls.push(`subagent ${name} ${agents.join(",")}`);
      },
      saveInstructions: async (change: { agents?: string[] }) => {
        calls.push(`instructions ${(change.agents ?? []).join(",")}`);
      },
      setMcpHub: async (on: boolean) => {
        calls.push(`hub ${on}`);
      },
    } as unknown as LibraryService;
    const connect = service({ library: () => library });

    const saved = await connect.saveProfile("Work");
    expect(saved.profiles[0]?.library).toEqual({
      mcp: { fs: ["claude"] },
      skills: { review: ["claude", "codex"] },
      hooks: { lint: ["claude"] },
      subagents: { planner: ["claude"] },
      instructions: ["claude"],
      mcpHub: true,
    });

    const applied = await connect.applyProfile("Work");
    expect(applied.error).toBeNull();
    expect(calls).toEqual([
      "mcp fs claude",
      "skill review claude,codex",
      "hook lint claude",
      "subagent planner claude",
      "instructions claude",
      "hub true",
    ]);
  });

  it("writes Codex's memories and background compaction beside its own keys", async () => {
    const configPath = path.join(home, ".codex", "config.toml");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = '[features]\nweb_search = true\n\n[memories]\nextract_model = "gpt-5"\n';
    await fs.writeFile(configPath, original);
    const config = {
      ...gateway(),
      codexAutoReview: "deepseek/deepseek-v4-pro",
      codexMemories: "deepseek/deepseek-v4-flash",
      codexAsyncCompact: true,
      codexAsyncCompactPercent: 70,
      codexSubagentModel: "lead",
    };
    const connect = service({ config });

    await connect.set({
      provider: "codex",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const written = await fs.readFile(configPath, "utf8");
    expect(written).toContain("[memories]\n");
    expect(written).toContain('extract_model = "deepseek/deepseek-v4-flash"');
    expect(written).toContain('consolidation_model = "deepseek/deepseek-v4-flash"');
    expect(written).toContain("[features.async_compaction]\n");
    expect(written).toContain("enabled = true");
    expect(written).toContain("model_async_compact_threshold_percent = 70");
    expect(written).toContain("web_search = true");
    const catalog = JSON.parse(
      await fs.readFile(path.join(home, ".codex", "neolix-codex-models.json"), "utf8"),
    ) as { models: { auto_review_model_override?: string; context_window?: number }[] };
    expect(catalog.models[0]?.auto_review_model_override).toBe("deepseek/deepseek-v4-pro");

    await connect.set({ provider: "codex", connected: false });
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("marks the profile the setup as it stands is", async () => {
    const connect = service();
    await connect.set({
      provider: "claude",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const saved = await connect.saveProfile("Work");
    expect(saved.profiles[0]?.inUse).toBe(true);

    await connect.set({ provider: "claude", connected: false });
    const changed = await connect.snapshot();
    expect(changed.profiles[0]?.inUse).toBeUndefined();

    await connect.applyProfile("Work");
    const applied = await connect.snapshot();
    expect(applied.profiles[0]?.inUse).toBe(true);
  });

  it("takes a model out of one agent's own list and puts it back", async () => {
    const connect = service();
    await connect.set({
      provider: "codex",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const catalogPath = path.join(home, ".codex", "neolix-codex-models.json");
    const readIds = async () => {
      const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        models: { slug: string }[];
      };
      return catalog.models.map((model) => model.slug);
    };
    expect(await readIds()).toContain("deepseek/deepseek-v4-flash");

    const hidden = await connect.setModels({
      provider: "codex",
      hidden: ["deepseek/deepseek-v4-flash"],
    });
    const codex = hidden.entries.find((entry) => entry.provider === "codex");
    expect(codex?.models).toEqual({
      listed: 2,
      shown: 1,
      hidden: ["deepseek/deepseek-v4-flash"],
    });
    expect(await readIds()).toEqual(["deepseek/deepseek-v4-pro"]);

    const back = await connect.setModels({ provider: "codex", hidden: [] });
    expect(back.entries.find((entry) => entry.provider === "codex")?.models).toMatchObject({
      shown: 2,
      hidden: [],
    });
    expect(await readIds()).toContain("deepseek/deepseek-v4-flash");
  });

  it("shows the agent CLI's own version beside it", async () => {
    const connect = service({
      probeVersions: true,
      run: async (command, args) => {
        if (command === "claude" && args[0] === "--version") return "2.1.306 (Claude Code)\n";
        throw new Error("no such command");
      },
    });
    const snapshot = await connect.snapshot();
    expect(snapshot.entries.find((entry) => entry.provider === "claude")?.cliVersion).toBe(
      "2.1.306",
    );
    expect(
      snapshot.entries.find((entry) => entry.provider === "codex")?.cliVersion,
    ).toBeUndefined();
  });

  it("restarts a stale copy only when asked, and says when it cannot", async () => {
    const calls: string[] = [];
    const connect = service({
      run: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return "";
      },
    });
    const restarted = await connect.restartStale({ provider: "codex", kind: "daemon" });
    // Codex daemons are not managed on Windows, so there is nothing Neolix may restart.
    if (process.platform === "win32") {
      expect(restarted.error).toBe(
        "Reopen that copy of the agent yourself: Neox cannot restart it.",
      );
      expect(calls).toEqual([]);
    } else {
      expect(restarted.error).toBeNull();
      expect(calls).toEqual(["codex app-server daemon restart"]);
    }

    const cli = await service().restartStale({ provider: "codex", kind: "cli" });
    expect(cli.error).toBe("Reopen that copy of the agent yourself: Neox cannot restart it.");

    const claude = await service().restartStale({ provider: "claude", kind: "cli" });
    expect(claude.error).toBe("Neox cannot restart this agent's copies.");
  });

  it("moves connected agents with the gateway when its address changes", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await service({ baseUrl: "http://127.0.0.1:6768" }).set({
      provider: "claude",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const moved = service({ baseUrl: "http://127.0.0.1:7777" });
    expect(await moved.followGatewayAddress()).toEqual(["claude"]);
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    expect(written.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:7777");
    expect(written.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("leaves an address the user changed alone when the gateway moves", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await service().set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    written.env.ANTHROPIC_BASE_URL = "https://api.anthropic.example";
    await fs.writeFile(settingsPath, JSON.stringify(written, null, 2));

    const moved = service({ baseUrl: "http://127.0.0.1:7777" });
    expect(await moved.followGatewayAddress()).toEqual([]);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL).toBe(
      "https://api.anthropic.example",
    );
  });

  it("reports why an agent cannot be connected without a gateway", async () => {
    const snapshot = await service({ config: emptyGateway(), baseUrl: null }).snapshot();
    const claude = snapshot.entries.find((item) => item.provider === "claude");
    expect(claude?.reason).toBe("gateway_unavailable");
    expect(claude?.connected).toBe(false);
    const copilot = snapshot.entries.find((item) => item.provider === "copilot");
    expect(copilot?.reason).toBe("gateway_unavailable");
  });

  it("lists a detected omp with its roles and writes a field without reconnecting", async () => {
    const dir = path.join(home, ".omp", "agent");
    await fs.mkdir(dir, { recursive: true });
    const configPath = path.join(dir, "config.yml");
    await fs.writeFile(
      configPath,
      ["modelRoles:", "  default: neolix/deepseek/deepseek-v4-pro", ""].join("\n"),
      "utf8",
    );
    const connect = service();
    const snapshot = await connect.snapshot();
    const omp = snapshot.entries.find((entry) => entry.provider === "omp");
    expect(omp).toMatchObject({ connected: true, model: "deepseek/deepseek-v4-pro" });
    expect(omp?.settings?.map((entry) => entry.key)).toEqual([
      "model",
      "subagent",
      "subagent_thinking",
      "small",
      "small_thinking",
      "slow",
      "slow_thinking",
      "plan",
      "plan_thinking",
      "vision",
      "vision_thinking",
      "advisor",
      "advisor_thinking",
      "commit",
      "commit_thinking",
      "tiny",
      "tiny_thinking",
      "memory",
      "memory_thinking",
      "effort",
    ]);

    expect(
      (
        await connect.set({
          provider: "omp",
          connected: true,
          field: "effort",
          value: "auto",
        })
      ).entries.find((entry) => entry.provider === "omp")?.settings,
    ).toContainEqual({
      key: "effort",
      label: "thinking",
      value: "auto",
      options: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(await fs.readFile(configPath, "utf8")).toContain("defaultThinkingLevel: auto");
  });

  it("keeps the reader's order and hidden set", async () => {
    const connect = service();
    await connect.set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });
    const layout = await connect.setLayout({
      order: ["pi", "claude", "codex", "opencode"],
      hidden: ["codex"],
    });
    expect(layout.order).toEqual(["pi", "claude", "codex", "opencode"]);
    expect(layout.hidden).toEqual(["codex"]);
    // A fresh read (another client) sees the same arrangement.
    const again = await service().snapshot();
    expect(again.order).toEqual(["pi", "claude", "codex", "opencode"]);
    expect(again.hidden).toEqual(["codex"]);
  });

  it("marks a config changed outside Neox as unwired", async () => {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await service().set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });
    const written = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    written.env.ANTHROPIC_BASE_URL = "https://api.anthropic.example";
    await fs.writeFile(settingsPath, JSON.stringify(written, null, 2));

    const snapshot = await service().snapshot();
    const entry = snapshot.entries.find((item) => item.provider === "claude");
    expect(entry?.connected).toBe(false);
    expect(entry?.drift).toBe("unwired");
  });

  it("marks an old gateway address or a dropped model as stale", async () => {
    const connect = service();
    await connect.set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });

    // The daemon moved to another address: the agent still names the old one.
    const moved = await service({ baseUrl: "http://127.0.0.1:7000" }).snapshot();
    expect(moved.entries.find((item) => item.provider === "claude")?.drift).toBe("stale");

    // The gateway dropped the model the agent starts on.
    const modelGone = await service({ config: gatewayWithoutProModel() }).snapshot();
    expect(findEntry(modelGone, "claude")?.drift).toBe("stale");
  });

  it("tells subscribed clients about a write", async () => {
    const connect = service();
    const seen: string[] = [];
    const unsubscribe = connect.subscribe((snapshot) => {
      seen.push(findEntry(snapshot, "claude")?.connected === true ? "on" : "off");
    });
    await connect.set({ provider: "claude", connected: true, model: "deepseek/deepseek-v4-pro" });
    unsubscribe();
    await connect.set({ provider: "claude", connected: false });
    expect(seen).toEqual(["on"]);
  });

  it("offers a launch command for an agent only reachable from its environment", async () => {
    const snapshot = await service().snapshot();
    const antigravity = findEntry(snapshot, "antigravity");
    expect(antigravity?.reason).toBe("unsupported");
    expect(antigravity?.launchCommand).toContain("GEMINI_API_KEY='gateway-key'");
    expect(antigravity?.launchCommand).toContain("GOOGLE_GEMINI_BASE_URL='http://127.0.0.1:6768'");
    expect(antigravity?.launchCommand).toContain("agy --model 'deepseek/deepseek-v4-pro'");
  });

  it("lists the plugins that contribute agent providers", async () => {
    const snapshot = await service({
      pluginProviders: () => [{ pluginId: "antigravity-provider", providers: ["antigravity"] }],
    }).snapshot();
    expect(snapshot.pluginProviders).toEqual([
      { pluginId: "antigravity-provider", providers: ["antigravity"] },
    ]);
  });

  it("refuses a model the gateway does not serve", async () => {
    const snapshot = await service().set({
      provider: "claude",
      connected: true,
      model: "other/model",
    });
    expect(snapshot.error).toContain("does not serve");
    expect(snapshot.entries.find((item) => item.provider === "claude")?.connected).toBe(false);
  });
  it("renames a saved profile and keeps what it holds", async () => {
    const svc = service();
    const saved = await svc.saveProfile("work");
    const savedAt = saved.profiles.find((profile) => profile.name === "work")?.savedAt;
    expect(savedAt).toBeDefined();

    const renamed = await svc.renameProfile("work", "desk");
    expect(renamed.error).toBeNull();
    expect(renamed.profiles.map((profile) => profile.name)).toContain("desk");
    expect(renamed.profiles.map((profile) => profile.name)).not.toContain("work");
    expect(renamed.profiles.find((profile) => profile.name === "desk")?.savedAt).toBe(savedAt);
    expect(renamed.profiles.find((profile) => profile.name === "desk")?.agents).toEqual(
      saved.profiles.find((profile) => profile.name === "work")?.agents,
    );

    const missing = await svc.renameProfile("missing", "other");
    expect(missing.error).toContain("No profile named missing");
  });

  it("keeps Claude Science's daemon while the daemon runs and stops with it", async () => {
    const bin = path.join(home, ".local", "bin", "claude-science");
    await fs.mkdir(path.dirname(bin), { recursive: true });
    await fs.writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const markPath = path.join(home, ".claude-science", "claude-science.json");
    await fs.mkdir(path.dirname(markPath), { recursive: true });
    await fs.writeFile(
      markPath,
      JSON.stringify({ url: "http://127.0.0.1:6768", pid: 42, port: 4300 }),
    );
    let ticks = 0;
    const runWithEnv = async (_command: string, args: string[]) => {
      ticks += 1;
      if (args[0] === "status") return JSON.stringify({ running: true, pid: 42, port: 4300 });
      return "";
    };
    const svc = new AgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      drivers: [],
      gatewayConfig: () => gateway(),
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
      runWithEnv,
    });
    vi.useFakeTimers();
    await svc.startScienceKeeper();
    expect(ticks).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    // The tick reads its note from disk; let that I/O finish.
    await realDelay(20);
    expect(ticks).toBe(2);

    svc.stopScienceKeeper();
    await vi.advanceTimersByTimeAsync(120_000);
    await realDelay(20);
    expect(ticks).toBe(2);
    vi.useRealTimers();
  });

  it("hands an agent the gateway's image models, apart from its chat ones", async () => {
    let seen: string[] | undefined;
    const fake: AgentConnectDriver = {
      provider: "alma",
      external: { name: "Alma", icon: "alma", detect: async () => true },
      configPath: () => "",
      read: async (environment) => {
        seen = environment.gatewayImageModels;
        return { connected: false, model: null, baseUrl: null };
      },
      connect: async () => ({ kind: "json", files: [] }),
      disconnect: async () => {},
    };
    const config = gateway();
    config.providers[0]?.models.push({ id: "draw", label: "Draw", kind: "image" });
    const svc = new AgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      drivers: [fake],
      gatewayConfig: () => config,
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
    });
    await svc.snapshot();
    expect(seen).toContain("deepseek/draw");
  });

  it("lists and writes an agent that lives in a WSL distro", async () => {
    let wired = false;
    const seen: ConnectEnvironment[] = [];
    const fake: AgentConnectDriver = {
      provider: "dsh",
      external: {
        name: "DeepSeek Harness",
        icon: "deepseek-color",
        detect: async () => false,
      },
      configPath: (environment) => path.join(environment.homeDir, ".dsh", "config.json"),
      read: async (environment) => {
        seen.push(environment);
        return {
          connected: wired,
          model: wired ? "deepseek/deepseek-v4-pro" : null,
          baseUrl: null,
        };
      },
      connect: async (environment) => {
        seen.push(environment);
        wired = true;
        return { kind: "json", files: [] };
      },
      disconnect: async () => {
        wired = false;
      },
    };
    const svc = new AgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      platform: "win32",
      drivers: [fake],
      gatewayConfig: () => gateway(),
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
      wslEnabled: () => true,
      wslDiscover: async () => [
        {
          provider: "dsh@wsl:Ubuntu",
          name: "DeepSeek Harness (WSL: Ubuntu)",
          icon: "deepseek-color",
          distro: "Ubuntu",
          home: "/home/reader",
          uncHome: "\\\\wsl.localhost\\Ubuntu\\home\\reader",
          baseUrl: "http://172.20.0.1:6768",
        },
      ],
    });
    const snapshot = await svc.snapshot();
    expect(snapshot.entries.find((entry) => entry.provider === "dsh@wsl:Ubuntu")?.name).toContain(
      "WSL: Ubuntu",
    );

    const on = await svc.set({
      provider: "dsh@wsl:Ubuntu",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const entry = on.entries.find((item) => item.provider === "dsh@wsl:Ubuntu");
    expect(entry?.connected).toBe(true);
    const scoped = seen.at(-1);
    expect(scoped?.homeDir).toBe("\\\\wsl.localhost\\Ubuntu\\home\\reader");
    expect(scoped?.platform).toBe("linux");
    expect(scoped?.baseUrl).toBe("http://172.20.0.1:6768");
    expect(scoped?.wsl).toEqual({ distro: "Ubuntu", home: "/home/reader" });
  });

  it("writes a changed gateway catalog into dsh's route", async () => {
    await fs.mkdir(path.join(home, ".dsh"), { recursive: true });
    const file = path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
    await service().set({
      provider: "dsh",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const before = await fs.readFile(file, "utf8");
    expect(before).toContain("deepseek-v4-flash");

    const grown = gateway();
    grown.providers[0]?.models.push({ id: "deepseek-v4-new", label: "DeepSeek V4 New" });
    const grownService = service({ config: grown });
    await grownService.refreshModels();
    const after = await fs.readFile(file, "utf8");
    expect(after).toContain("deepseek-v4-new");
    expect(after).toContain("deepseek-v4-pro");

    // An unchanged catalog writes nothing.
    await grownService.refreshModels();
    expect(await fs.readFile(file, "utf8")).toBe(after);

    await grownService.set({ provider: "dsh", connected: false });
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it("rewrites Codex's own list when a visibility edit reaches the gateway config", async () => {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    let config = gateway();
    let changed: (() => void) | null = null;
    const shared = sharedAgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      gatewayConfig: () => config,
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
      watchGatewayConfig: (listener) => {
        changed = listener;
        return () => {
          changed = null;
        };
      },
    });
    await shared.set({
      provider: "codex",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    const catalogPath = path.join(home, ".codex", "neolix-codex-models.json");
    expect(await fs.readFile(catalogPath, "utf8")).toContain("deepseek-v4-flash");

    // `neox visible codex deepseek` keeps hiddenModels in gateway.json;
    // the daemon's subscription rewrites the list without a reconnect.
    config = { ...gateway(), hiddenModels: { codex: ["deepseek/deepseek-v4-flash"] } };
    expect(changed).not.toBeNull();
    changed?.();
    await vi.waitFor(async () => {
      const catalog = await fs.readFile(catalogPath, "utf8");
      expect(catalog).not.toContain("deepseek-v4-flash");
      expect(catalog).toContain("deepseek-v4-pro");
    });
  });

  it("rewrites Pi's and OpenCode's lists on a visibility edit, and still restores them", async () => {
    const piDir = path.join(home, ".pi", "agent");
    await fs.mkdir(piDir, { recursive: true });
    const piSettingsPath = path.join(piDir, "settings.json");
    const piModelsPath = path.join(piDir, "models.json");
    const piSettingsOriginal = '{"defaultProvider":"anthropic","theme":"dark"}\n';
    const piModelsOriginal = '{"providers":{"anthropic":{"models":[]}}}\n';
    await fs.writeFile(piSettingsPath, piSettingsOriginal);
    await fs.writeFile(piModelsPath, piModelsOriginal);

    const openCodeDir = path.join(home, ".config", "opencode");
    await fs.mkdir(openCodeDir, { recursive: true });
    const openCodePath = path.join(openCodeDir, "opencode.json");
    const openCodeOriginal = { theme: "dark", model: "anthropic/claude-sonnet-4" };
    await fs.writeFile(openCodePath, `${JSON.stringify(openCodeOriginal, null, 2)}\n`);

    let config = gateway();
    let changed: (() => void) | null = null;
    const shared = sharedAgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      gatewayConfig: () => config,
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
      watchGatewayConfig: (listener) => {
        changed = listener;
        return () => {
          changed = null;
        };
      },
    });
    await shared.set({ provider: "pi", connected: true, model: "deepseek/deepseek-v4-pro" });
    await shared.set({
      provider: "opencode",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    expect(piModelIds(JSON.parse(await fs.readFile(piModelsPath, "utf8")))).toContain(
      "deepseek/deepseek-v4-flash",
    );
    expect(openCodeModelIds(JSON.parse(await fs.readFile(openCodePath, "utf8")))).toContain(
      "deepseek/deepseek-v4-flash",
    );

    config = {
      ...gateway(),
      hiddenModels: {
        pi: ["deepseek/deepseek-v4-flash"],
        opencode: ["deepseek/deepseek-v4-flash"],
      },
    };
    expect(changed).not.toBeNull();
    changed?.();
    await vi.waitFor(async () => {
      const piIds = piModelIds(JSON.parse(await fs.readFile(piModelsPath, "utf8")));
      expect(piIds).not.toContain("deepseek/deepseek-v4-flash");
      expect(piIds).toContain("deepseek/deepseek-v4-pro");
      const openCodeIds = openCodeModelIds(JSON.parse(await fs.readFile(openCodePath, "utf8")));
      expect(openCodeIds).not.toContain("deepseek/deepseek-v4-flash");
      expect(openCodeIds).toContain("deepseek/deepseek-v4-pro");
    });

    // Rewriting for the new visibility kept the first connect's undo: the
    // reader's own files come back untouched.
    await shared.set({ provider: "pi", connected: false });
    await shared.set({ provider: "opencode", connected: false });
    expect(JSON.parse(await fs.readFile(piSettingsPath, "utf8"))).toEqual(
      JSON.parse(piSettingsOriginal),
    );
    expect(JSON.parse(await fs.readFile(piModelsPath, "utf8"))).toEqual(
      JSON.parse(piModelsOriginal),
    );
    expect(JSON.parse(await fs.readFile(openCodePath, "utf8"))).toEqual(openCodeOriginal);
  });

  it("lists each of QwenPaw's agents as a row of its own", async () => {
    const work = path.join(home, ".qwenpaw");
    await fs.mkdir(path.join(work, "workspaces", "work"), { recursive: true });
    await fs.writeFile(
      path.join(work, "config.json"),
      JSON.stringify({
        agents: {
          agent_order: ["work"],
          profiles: { work: { id: "work", enabled: true } },
        },
      }),
    );
    await fs.writeFile(
      path.join(work, "workspaces", "work", "agent.json"),
      JSON.stringify({ name: "Work", backend: "qwenpaw" }),
    );
    const snapshot = await service().snapshot();
    expect(findEntry(snapshot, "qwenpaw")?.connected).toBe(false);
    expect(findEntry(snapshot, "qwenpaw#work")?.connected).toBe(false);

    const on = await service().set({
      provider: "qwenpaw#work",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    expect(findEntry(on, "qwenpaw#work")?.connected).toBe(true);
    expect(findEntry(on, "qwenpaw#work")?.model).toBe("deepseek/deepseek-v4-pro");
    expect(findEntry(on, "qwenpaw")?.connected).toBe(false);

    // A profile saves the row too, and puts it back on.
    const saved = await service().saveProfile("work-agent");
    expect(
      saved.profiles.find((profile) => profile.name === "work-agent")?.agents["qwenpaw#work"],
    ).toMatchObject({
      connected: true,
      model: "deepseek/deepseek-v4-pro",
    });
    await service().set({ provider: "qwenpaw#work", connected: false });
    const applied = await service().applyProfile("work-agent");
    expect(findEntry(applied, "qwenpaw#work")?.connected).toBe(true);

    const off = await service().set({ provider: "qwenpaw#work", connected: false });
    expect(findEntry(off, "qwenpaw#work")?.connected).toBe(false);
    const agent = JSON.parse(
      await fs.readFile(path.join(work, "workspaces", "work", "agent.json"), "utf8"),
    );
    expect(agent.active_model).toBeUndefined();
  });
});

describe("Kiro Crew's harness", () => {
  let home: string;
  let neolixHome: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-kiro-home-"));
    neolixHome = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-kiro-daemon-"));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(neolixHome, { recursive: true, force: true });
  });

  function crew() {
    return new AgentConnectService({
      neolixHome,
      homeDir: home,
      env: {},
      gatewayConfig: () => gateway(),
      gatewayBaseUrl: () => "http://127.0.0.1:6768",
    });
  }

  async function claudeSettings(): Promise<string> {
    const settingsPath = path.join(home, ".claude", "settings.json");
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } })}\n`,
    );
    return settingsPath;
  }

  async function crewConfig(backend: string): Promise<void> {
    const configPath = path.join(home, ".kiro", "crew", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify({ agent: { acp_backend: backend } })}\n`);
  }

  it("connects the harness with Kiro Crew and takes only that one off again", async () => {
    const settingsPath = await claudeSettings();
    const original = await fs.readFile(settingsPath, "utf8");
    await crewConfig("claude");
    const service = crew();

    const on = await service.set({ provider: "kirocrew", connected: true });
    expect(findEntry(on, "kirocrew")?.connected).toBe(true);
    expect(findEntry(on, "claude")?.connected).toBe(true);
    expect(await fs.readFile(settingsPath, "utf8")).toContain(
      '"ANTHROPIC_BASE_URL": "http://127.0.0.1:6768"',
    );

    const off = await service.set({ provider: "kirocrew", connected: false });
    expect(findEntry(off, "kirocrew")?.connected).toBe(false);
    expect(findEntry(off, "claude")?.connected).toBe(false);
    expect(JSON.parse(await fs.readFile(settingsPath, "utf8"))).toEqual(JSON.parse(original));
  });

  it("leaves a harness the reader connected themselves", async () => {
    const settingsPath = await claudeSettings();
    await crewConfig("claude");
    const service = crew();
    await service.set({ provider: "claude", connected: true });

    await service.set({ provider: "kirocrew", connected: true });
    const off = await service.set({ provider: "kirocrew", connected: false });

    expect(findEntry(off, "claude")?.connected).toBe(true);
    expect(await fs.readFile(settingsPath, "utf8")).not.toBe("");
  });
  it("leaves a harness the reader connected themselves", async () => {
    const settingsPath = await claudeSettings();
    await crewConfig("claude");
    const service = crew();
    await service.set({ provider: "claude", connected: true });

    await service.set({ provider: "kirocrew", connected: true });
    const off = await service.set({ provider: "kirocrew", connected: false });

    expect(findEntry(off, "claude")?.connected).toBe(true);
    expect(await fs.readFile(settingsPath, "utf8")).not.toBe("");
  });
});
