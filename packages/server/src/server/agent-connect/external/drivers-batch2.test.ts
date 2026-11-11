import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH2_AGENT_DRIVERS } from "./drivers-batch2.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch2-home-"));
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
  const found = BATCH2_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

async function read(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(filePath)) as Record<string, unknown>;
}

describe("batch 2 external agents", () => {
  it("adds Qwen Code's provider entries and restores the user's", async () => {
    const settingsPath = path.join(home, ".qwen", "settings.json");
    const original = {
      modelProviders: {
        openai: [{ baseUrl: "http://mine", envKey: "MY_KEY", id: "mine", name: "Mine" }],
      },
      security: { auth: { selectedType: "qwen-oauth" } },
      model: { name: "mine" },
    };
    await writeJson(settingsPath, original);
    const target = driver("qwen");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(settingsPath);
    const providers = (wired.modelProviders as { openai: unknown[] }).openai;
    expect(providers).toHaveLength(3);
    expect((wired.env as Record<string, unknown>).NEOLIX_QWEN_API_KEY).toBe(API_KEY);
    expect((wired.model as Record<string, unknown>).name).toBe("model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(original);
  });

  it("writes Hermes's provider and model, then takes them back", async () => {
    const configPath = path.join(home, ".hermes", "config.yaml");
    const original =
      "providers:\n  anthropic:\n    models:\n      - claude\nmodel:\n  provider: anthropic\n  default: claude\n";
    await write(configPath, original);
    const target = driver("hermes");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await read(configPath);
    expect(wired).toContain("neolix:");
    expect(wired).toContain("provider: neolix");
    expect(wired).toContain("default: model-two");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await read(configPath);
    expect(restored).toContain("provider: anthropic");
    expect(restored).not.toContain("neolix:");
  });

  it("adds Grok App's channel table and removes only it", async () => {
    const configPath = path.join(
      home,
      "Library",
      "Application Support",
      "com.grokapp.grok-app",
      "agent-home",
      "config.toml",
    );
    const original = '[models]\ndefault = "grok-4"\n';
    await write(configPath, original);
    const target = driver("grok-app");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await read(configPath);
    expect(wired).toContain("[model.neolix]");
    expect(wired).toContain('model = "model-one"');
    expect(wired).toContain(`api_key = "${API_KEY}"`);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await read(configPath)).toBe(original);
  });

  it("adds CodeBuddy's models and default model, then restores both", async () => {
    const dir = path.join(home, ".codebuddy");
    const modelsPath = path.join(dir, "models.json");
    const settingsPath = path.join(dir, "settings.json");
    const originalModels = { models: [{ id: "own", name: "Own", vendor: "other" }], other: 1 };
    await writeJson(modelsPath, originalModels);
    await writeJson(settingsPath, { model: "own" });
    const target = driver("codebuddy");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(modelsPath);
    expect((wired.models as unknown[]).length).toBe(3);
    expect((await readJson(settingsPath)).model).toBe("model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(modelsPath)).toEqual(originalModels);
    expect((await readJson(settingsPath)).model).toBe("own");
  });

  it("adds WorkBuddy's models and restores the list", async () => {
    const modelsPath = path.join(home, ".workbuddy", "models.json");
    const original = [{ id: "own", name: "Own", vendor: "other" }];
    await writeJson(modelsPath, original);
    const target = driver("workbuddy");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, null, undefined);
    expect((await readJson2(modelsPath)).length).toBe(3);
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: true });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson2(modelsPath)).toEqual(original);
  });

  it("writes Command Code's provider and restores the file", async () => {
    const settingsPath = path.join(home, ".commandcode", "settings.json");
    const original = { model: "own", modelProvider: "other" };
    await writeJson(settingsPath, original);
    const target = driver("commandcode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await readJson(settingsPath);
    expect(wired.modelProvider).toBe("neolix");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: `${BASE_URL}/v1`,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(original);
  });

  it("writes MiniMax Code's custom provider and restores the config", async () => {
    const configPath = path.join(home, ".minimax", "config.yaml");
    const original = "defaultModel: other/model\ndefaultModelVariant: high\n";
    await write(configPath, original);
    const target = driver("minimax-code");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await read(configPath);
    expect(wired).toContain("custom_provider:");
    expect(wired).toContain("defaultModel: neolix/model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await read(configPath)).toBe(original);
  });

  it("lists Devin without writing its config", async () => {
    const configPath = path.join(home, ".config", "devin", "config.json");
    await writeJson(configPath, { agent: { model: "swe-2" } });
    const target = driver("devin");
    expect(await target.external?.detect(environment())).toBe(true);
    expect(target.external?.noConnect).toBe(true);
    expect(await target.read(environment())).toMatchObject({ connected: false, model: "swe-2" });
    expect(await read(configPath)).toContain("swe-2");
  });
});

async function readJson2(filePath: string): Promise<unknown[]> {
  return JSON.parse(await read(filePath)) as unknown[];
}
