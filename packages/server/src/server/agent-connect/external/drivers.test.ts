import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG } from "../../llm-gateway/config.js";
import { AgentConnectService } from "../service.js";
import type { ConnectEnvironment } from "../drivers.js";
import { EXTERNAL_AGENT_DRIVERS } from "./drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;
let envDir: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-external-home-"));
  envDir = await fs.mkdtemp(path.join(tmpdir(), "neolix-external-bin-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(envDir, { recursive: true, force: true });
});

function environment(overrides: Partial<ConnectEnvironment> = {}): ConnectEnvironment {
  return {
    homeDir: home,
    env: { PATH: envDir },
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    models: [{ id: "model-one", label: "Model One" }, { id: "model-two" }],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = EXTERNAL_AGENT_DRIVERS.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no driver for ${provider}`);
  return found;
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

async function makeExecutable(name: string): Promise<void> {
  const filePath = path.join(envDir, name);
  await write(filePath, "#!/bin/sh\nexit 0\n");
  await fs.chmod(filePath, 0o755);
}

describe("external agent drivers", () => {
  it("wires Gemini CLI through its settings and .env, then puts both back", async () => {
    const settingsPath = path.join(home, ".gemini", "settings.json");
    const envPath = path.join(home, ".gemini", ".env");
    await writeJson(settingsPath, { model: { name: "gemini-2.5-pro" } });
    await write(envPath, "GEMINI_API_KEY=user-key\n");
    const target = driver("gemini");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);

    const settings = await readJson(settingsPath);
    expect((settings.model as Record<string, unknown>).name).toBe("model-one");
    expect(
      ((settings.security as Record<string, unknown>).auth as Record<string, unknown>).selectedType,
    ).toBe("gemini-api-key");
    expect(await fs.readFile(envPath, "utf8")).toContain(`GOOGLE_GEMINI_BASE_URL=${BASE_URL}`);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);

    const restored = await readJson(settingsPath);
    expect((restored.model as Record<string, unknown>).name).toBe("gemini-2.5-pro");
    expect(restored.security).toBeUndefined();
    const envText = await fs.readFile(envPath, "utf8");
    expect(envText).not.toContain("GOOGLE_GEMINI_BASE_URL");
    expect(envText).toContain("GEMINI_API_KEY=user-key");
    expect((await target.read(connectEnvironment)).connected).toBe(false);
  });

  it("adds agy's custom models and restores its own", async () => {
    const settingsPath = path.join(home, ".gemini", "antigravity-cli", "settings.json");
    await writeJson(settingsPath, {
      model: "gemini-2.5-pro",
      modelProvider: "google",
      customModelsConfig: {
        customModels: {
          "mine/model": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI", modelName: "x" },
        },
      },
    });
    const target = driver("agy");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await readJson(settingsPath);
    expect(wired.model).toBe("neolix/model-two");
    expect(wired.modelProvider).toBe("gemini");
    const models = (wired.customModelsConfig as Record<string, unknown>).customModels as Record<
      string,
      unknown
    >;
    expect(Object.keys(models)).toEqual(["mine/model", "neolix/model-two"]);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
    });
    expect(target.external?.launch?.(connectEnvironment, "model-two")).toContain(
      "GEMINI_API_KEY='test-gateway-key'",
    );

    await target.disconnect(connectEnvironment, undo);
    const restored = await readJson(settingsPath);
    expect(restored.model).toBe("gemini-2.5-pro");
    expect(restored.modelProvider).toBe("google");
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: false });
  });

  it("lists Cursor CLI without writing its config", async () => {
    const settingsPath = path.join(home, ".cursor", "cli-config.json");
    await writeJson(settingsPath, { model: { modelId: "auto" } });
    const target = driver("cursor");
    expect(await target.external?.detect(environment())).toBe(true);
    expect(target.external?.noConnect).toBe(true);
    expect(await target.read(environment())).toMatchObject({
      connected: false,
      model: "auto",
    });
  });

  it("writes Qoder's provider and model, then restores the file", async () => {
    const settingsPath = path.join(home, ".qoder", "settings.json");
    await writeJson(settingsPath, { model: { name: "auto" } });
    const target = driver("qoder");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(settingsPath);
    expect((wired.model as Record<string, unknown>).name).toBe("neolix/model-one");
    expect(
      ((wired.providers as Record<string, unknown>).neolix as Record<string, unknown>).baseUrl,
    ).toBe(`${BASE_URL}/v1`);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual({ model: { name: "auto" } });
  });

  it("adds Grok Build's model tables and removes them on disconnect", async () => {
    const configPath = path.join(home, ".grok", "config.toml");
    const original = '[models]\ndefault = "grok-4"\n\n[model."grok-4"]\nmodel = "grok-4"\n';
    await write(configPath, original);
    const target = driver("grok");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(configPath, "utf8");
    expect(wired).toContain('[model."neolix/model-one"]');
    expect(wired).toContain(`api_key = "${API_KEY}"`);
    expect(wired).toContain('default = "neolix/model-one"');
    expect(wired).toContain("campaigns = false");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("adds Kimi Code's provider and model tables, then restores them", async () => {
    const configPath = path.join(home, ".kimi-code", "config.toml");
    const original = 'default_model = "kimi-k2"\n\n[providers.kimi]\ntype = "kimi"\n';
    await write(configPath, original);
    const target = driver("kimi");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await fs.readFile(configPath, "utf8");
    expect(wired).toContain("[providers.neolix]");
    expect(wired).toContain(`base_url = "${BASE_URL}/v1"`);
    expect(wired).toContain('[models."neolix/model-two"]');
    expect(wired).toContain('default_model = "neolix/model-two"');
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await fs.readFile(configPath, "utf8")).toBe(original);
  });

  it("wires Cline's provider and restores the one it replaced", async () => {
    const dataDir = path.join(home, ".cline", "data", "settings");
    const providersPath = path.join(dataDir, "providers.json");
    const modelsPath = path.join(dataDir, "models.json");
    await writeJson(providersPath, {
      lastUsedProvider: "anthropic",
      providers: { anthropic: { settings: { model: "claude" } } },
    });
    await writeJson(modelsPath, { providers: {} });
    const target = driver("cline");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(providersPath);
    expect(wired.lastUsedProvider).toBe("openai-compatible");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await readJson(providersPath);
    expect(restored.lastUsedProvider).toBe("anthropic");
    expect(restored.providers).toEqual({ anthropic: { settings: { model: "claude" } } });
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: false });
  });

  it("adds Droid's custom models and restores its own", async () => {
    const settingsPath = path.join(home, ".factory", "settings.json");
    const original = {
      customModels: [{ model: "own", id: "custom:own", displayName: "Own" }],
      sessionDefaultSettings: { model: "custom:own" },
    };
    await writeJson(settingsPath, original);
    const target = driver("droid");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(settingsPath);
    expect((wired.sessionDefaultSettings as Record<string, unknown>).model).toBe(
      "custom:neolix/model-one",
    );
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(original);
  });

  it("wires Goose's custom provider and YAML, then takes both back", async () => {
    const configDir = path.join(home, ".config", "goose");
    const configPath = path.join(configDir, "config.yaml");
    const original = "active_provider: anthropic\nproviders:\n  anthropic:\n    model: claude\n";
    await write(configPath, original);
    const target = driver("goose");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const provider = await readJson(path.join(configDir, "custom_providers", "neolix.json"));
    expect(provider.base_url).toBe(`${BASE_URL}/v1`);
    const wired = await fs.readFile(configPath, "utf8");
    expect(wired).toContain("active_provider: neolix");
    expect(wired).toContain("model: model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(configPath, "utf8");
    expect(restored).toContain("active_provider: anthropic");
    expect(await isFile(path.join(configDir, "custom_providers", "neolix.json"))).toBe(false);
  });

  it("wires Zed's provider and default model with a credential", async () => {
    const settingsPath = path.join(home, ".config", "zed", "settings.json");
    await writeJson(settingsPath, { theme: "One Dark" });
    const target = driver("zed");
    const credentials: Array<[string, string]> = [];
    const connectEnvironment = environment({
      writeCredential: async (url, key) => {
        credentials.push([url, key]);
      },
    });

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    expect(credentials).toEqual([[`${BASE_URL}/v1`, API_KEY]]);
    const wired = await readJson(settingsPath);
    expect(wired.theme).toBe("One Dark");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual({ theme: "One Dark" });
  });

  it("detects an external agent's program on PATH and lists it in the snapshot", async () => {
    await makeExecutable("gemini");
    const neolixHome = await fs.mkdtemp(path.join(tmpdir(), "neolix-external-daemon-"));
    try {
      const service = new AgentConnectService({
        neolixHome,
        homeDir: home,
        env: { PATH: envDir },
        gatewayConfig: () => EMPTY_GATEWAY_CONFIG,
        gatewayBaseUrl: () => BASE_URL,
        platform: "darwin",
      });
      const snapshot = await service.snapshot();
      const entry = snapshot.entries.find((candidate) => candidate.provider === "gemini");
      expect(entry).toMatchObject({
        kind: "external",
        name: "Gemini CLI",
        icon: "geminicli-color",
        connected: false,
      });
      expect(snapshot.entries.some((candidate) => candidate.provider === "qoder")).toBe(false);
    } finally {
      await fs.rm(neolixHome, { recursive: true, force: true });
    }
  });
});

describe("Cursor Private Inference", () => {
  it("sets the two variables with launchctl and puts the old ones back", async () => {
    const app = path.join(home, "Applications", "Cursor Private Inference.app");
    await writeJson(path.join(app, "Contents", "Resources", "app", "product.json"), {
      nameShort: "Cursor Private Inference",
    });
    const calls: string[][] = [];
    const previous: Record<string, string | null> = {
      CURSOR_LOCAL_AGENT_BASE_URL: "http://old:1/v1",
      CURSOR_LOCAL_AGENT_API_KEY: null,
    };
    const connectEnvironment = environment({
      env: { PATH: envDir, NEOLIX_CURSOR_LOCAL_ROOTS: path.join(home, "Applications") },
      run: async (command, args) => {
        calls.push([command, ...args]);
        const name = args[1] ?? "";
        if (args[0] === "getenv") return previous[name] ?? "";
        if (args[0] === "setenv") previous[name] = args[2] ?? null;
        if (args[0] === "unsetenv") previous[name] = null;
        return "";
      },
    });
    const target = driver("cursor-local");
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    expect(calls).toContainEqual([
      "launchctl",
      "setenv",
      "CURSOR_LOCAL_AGENT_BASE_URL",
      `${BASE_URL}/v1`,
    ]);
    expect(calls).toContainEqual(["launchctl", "setenv", "CURSOR_LOCAL_AGENT_API_KEY", API_KEY]);
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: true });

    calls.length = 0;
    await target.disconnect(connectEnvironment, undo);
    expect(calls).toContainEqual([
      "launchctl",
      "setenv",
      "CURSOR_LOCAL_AGENT_BASE_URL",
      "http://old:1/v1",
    ]);
    expect(calls).toContainEqual(["launchctl", "unsetenv", "CURSOR_LOCAL_AGENT_API_KEY"]);
  });
});

describe("agy's shell function", () => {
  it("writes one marked block, backs the profile up, and removes only the block", async () => {
    const profile = path.join(home, ".zshrc");
    const original = "export PATH=$PATH:/opt/bin\nalias ll='ls -l'\n";
    await write(profile, original);
    const neolixHome = await fs.mkdtemp(path.join(tmpdir(), "neolix-shell-daemon-"));
    try {
      const target = driver("agy");
      const connectEnvironment = environment({
        env: { SHELL: "/bin/zsh" },
        neolixHome,
      });
      const shell = target.external?.shell;
      expect(shell).toBeDefined();
      expect(await shell?.installed(connectEnvironment)).toBe(false);

      await shell?.install(connectEnvironment, "model-one");
      const wired = await fs.readFile(profile, "utf8");
      expect(wired).toContain("# >>> neolix agy >>>");
      expect(wired).toContain("# <<< neolix agy <<<");
      expect(wired).toContain("GOOGLE_GEMINI_BASE_URL=");
      expect(wired).toContain("--model 'model-one'");
      expect(wired).toContain("alias ll='ls -l'");
      expect(await shell?.installed(connectEnvironment)).toBe(true);
      expect(
        await fs.readFile(
          path.join(neolixHome, "agent-connect", "backups", "agy-shell", ".zshrc"),
          "utf8",
        ),
      ).toBe(original);

      await shell?.remove(connectEnvironment);
      expect(await fs.readFile(profile, "utf8")).toBe(original);
      expect(await shell?.installed(connectEnvironment)).toBe(false);
    } finally {
      await fs.rm(neolixHome, { recursive: true, force: true });
    }
  });

  it("refuses a shell it does not know", async () => {
    const target = driver("agy");
    const connectEnvironment = environment({ env: { SHELL: "/bin/tcsh" } });
    await expect(target.external?.shell?.install(connectEnvironment, "model-one")).rejects.toThrow(
      "zsh, bash or fish",
    );
  });
});

describe("agy's shell function across profiles", () => {
  it("writes into every shell profile that is here, fish syntax included", async () => {
    const profiles = [
      path.join(home, ".zshrc"),
      path.join(home, ".bashrc"),
      path.join(home, ".config", "fish", "config.fish"),
    ];
    for (const profile of profiles) await write(profile, "# mine\n");
    const neolixHome = await fs.mkdtemp(path.join(tmpdir(), "neolix-shell-all-"));
    try {
      const target = driver("agy");
      const connectEnvironment = environment({ env: { SHELL: "/bin/zsh" }, neolixHome });
      await target.external?.shell?.install(connectEnvironment, "model-one");

      for (const profile of profiles) {
        const text = await fs.readFile(profile, "utf8");
        expect(text).toContain("# >>> neolix agy >>>");
        expect(text).toContain("# mine");
      }
      expect(await fs.readFile(profiles[2] ?? "", "utf8")).toContain("function agy");

      await target.external?.shell?.remove(connectEnvironment);
      for (const profile of profiles) {
        expect(await fs.readFile(profile, "utf8")).toBe("# mine\n");
      }
      const backups = await fs.readdir(
        path.join(neolixHome, "agent-connect", "backups", "agy-shell"),
      );
      expect(backups).toHaveLength(3);
    } finally {
      await fs.rm(neolixHome, { recursive: true, force: true });
    }
  });
});
