import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH6_AGENT_DRIVERS } from "./drivers-batch6.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch6-home-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function environment(overrides: Partial<ConnectEnvironment> = {}): ConnectEnvironment {
  return {
    homeDir: home,
    env: { PATH: "" },
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    models: [{ id: "model-one", label: "Model One" }, { id: "model-two" }],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = BATCH6_AGENT_DRIVERS.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no driver for ${provider}`);
  return found;
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

describe("batch 6 external agents", () => {
  it("adds Snow's profile, makes it active, then leaves the reader's own", async () => {
    const dir = path.join(home, ".snow");
    await writeJson(path.join(dir, "profiles", "default.json"), {
      snowcfg: { advancedModel: "own-model", oauth: { token: "x" }, keep: true },
    });
    await writeJson(path.join(dir, "active-profile.json"), { activeProfile: "default" });
    await writeJson(path.join(dir, "config.json"), { snowcfg: { advancedModel: "own-model" } });
    const target = driver("snow");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const profile = await readJson(path.join(dir, "profiles", "neolix.json"));
    const cfg = profile.snowcfg as Record<string, unknown>;
    expect(cfg.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(cfg.requestMethod).toBe("chat");
    expect(cfg.advancedModel).toBe("model-two");
    expect(cfg.oauth).toBeUndefined();
    expect(cfg.keep).toBe(true);
    expect((await readJson(path.join(dir, "active-profile.json"))).activeProfile).toBe("neolix");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect((await readJson(path.join(dir, "active-profile.json"))).activeProfile).toBe("default");
    await expect(fs.stat(path.join(dir, "profiles", "neolix.json"))).rejects.toThrow();
    expect((await readJson(path.join(dir, "config.json"))).snowcfg).toEqual({
      advancedModel: "own-model",
    });
  });

  it("writes jcode's provider table and puts the reader's pick back", async () => {
    const filePath = path.join(home, ".jcode", "config.toml");
    const original = '[provider]\ndefault_provider = "other"\ndefault_model = "own"\n';
    await write(filePath, original);
    const target = driver("jcode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(filePath, "utf8");
    expect(wired).toContain("[providers.neolix]");
    expect(wired).toContain('type = "openai-compatible"');
    expect(wired).toContain('id = "model-one"');
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(filePath, "utf8");
    expect(restored).not.toContain("[providers.neolix]");
    expect(restored).toContain('default_provider = "other"');
    expect(restored).toContain('default_model = "own"');
  });

  it("adds VS Code's chat model group and default model, then removes them", async () => {
    const dir = path.join(home, "Library", "Application Support", "Code", "User");
    const modelsPath = path.join(dir, "chatLanguageModels.json");
    const settingsPath = path.join(dir, "settings.json");
    await writeJson(modelsPath, [
      { name: "mine", vendor: "customendpoint", apiType: "chat-completions", models: [] },
    ]);
    await writeJson(settingsPath, { existing: true });
    const target = driver("vscode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const models = JSON.parse(await fs.readFile(modelsPath, "utf8")) as unknown[];
    expect(models).toHaveLength(2);
    expect(JSON.stringify(models)).toContain(`${BASE_URL}/v1/chat/completions`);
    expect((await readJson(settingsPath))["chat.defaultModel"]).toBe("model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(JSON.parse(await fs.readFile(modelsPath, "utf8"))).toHaveLength(1);
    expect((await readJson(settingsPath))["chat.defaultModel"]).toBeUndefined();
    expect((await readJson(settingsPath)).existing).toBe(true);
  });

  it("points Zoo Code's auto-import at Neox's profile and puts the old value back", async () => {
    const dir = path.join(home, "Library", "Application Support", "Code", "User");
    const settingsPath = path.join(dir, "settings.json");
    await writeJson(settingsPath, { "zoo-code.autoImportSettingsPath": "/old/import.json" });
    await fs.mkdir(
      path.join(home, ".vscode", "extensions", "zoocodeorganization.zoo-code-3.90.0"),
      { recursive: true },
    );
    const target = driver("zoo-code");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const importPath = path.join(
      dir,
      "globalStorage",
      "zoocodeorganization.zoo-code",
      "settings",
      "neolix-import.json",
    );
    expect((await readJson(settingsPath))["zoo-code.autoImportSettingsPath"]).toBe(importPath);
    const imported = await readJson(importPath);
    const profiles = imported.providerProfiles as Record<string, unknown>;
    expect(profiles.currentApiConfigName).toBe("neolix");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect((await readJson(settingsPath))["zoo-code.autoImportSettingsPath"]).toBe(
      "/old/import.json",
    );
    await expect(fs.stat(importPath)).rejects.toThrow();
  });
});
