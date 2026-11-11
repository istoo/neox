import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH6_AGENT_DRIVERS } from "./drivers-batch6.js";
import { BATCH7_AGENT_DRIVERS } from "./drivers-batch7.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch7-home-"));
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
  const found = [...BATCH7_AGENT_DRIVERS, ...BATCH6_AGENT_DRIVERS].find(
    (entry) => entry.provider === provider,
  );
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

describe("batch 7 external agents", () => {
  it("wires VS Code Insiders' own User folder and restores it", async () => {
    const dir = path.join(home, "Library", "Application Support", "Code - Insiders", "User");
    const modelsPath = path.join(dir, "chatLanguageModels.json");
    const settingsPath = path.join(dir, "settings.json");
    await writeJson(modelsPath, []);
    await writeJson(settingsPath, { "chat.defaultModel": "own" });
    const target = driver("vscode-insiders");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    expect(JSON.parse(await fs.readFile(modelsPath, "utf8"))).toHaveLength(1);
    expect((await readJson(settingsPath))["chat.defaultModel"]).toBe("model-two");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(JSON.parse(await fs.readFile(modelsPath, "utf8"))).toHaveLength(0);
    expect((await readJson(settingsPath))["chat.defaultModel"]).toBe("own");
  });

  it("writes VS Code's group into each profile, and takes it out of each", async () => {
    const dir = path.join(home, "Library", "Application Support", "Code", "User");
    await writeJson(path.join(dir, "settings.json"), {});
    await writeJson(path.join(dir, "chatLanguageModels.json"), []);
    const profileDir = path.join(dir, "profiles", "work");
    await writeJson(path.join(profileDir, "settings.json"), { "chat.defaultModel": "own" });
    await writeJson(path.join(profileDir, "chatLanguageModels.json"), []);
    await writeJson(path.join(dir, "globalStorage", "storage.json"), {
      userDataProfiles: [{ location: "work" }],
    });
    const target = driver("vscode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const profileSettings = await readJson(path.join(profileDir, "settings.json"));
    expect(profileSettings["chat.defaultModel"]).toBe("model-two");
    const profileModels = JSON.parse(
      await fs.readFile(path.join(profileDir, "chatLanguageModels.json"), "utf8"),
    ) as unknown[];
    expect(profileModels).toHaveLength(1);

    await target.disconnect(connectEnvironment, undo);
    expect((await readJson(path.join(profileDir, "settings.json")))["chat.defaultModel"]).toBe(
      "own",
    );
    expect(
      JSON.parse(await fs.readFile(path.join(profileDir, "chatLanguageModels.json"), "utf8")),
    ).toEqual([]);
  });

  it("writes VSCodium's group for the OpenAI Compatible provider its chat declares", async () => {
    const dir = path.join(home, "Library", "Application Support", "VSCodium", "User");
    await writeJson(path.join(dir, "settings.json"), {});
    await writeJson(path.join(dir, "chatLanguageModels.json"), []);
    await write(
      path.join(home, ".vscode-oss", "extensions", "github.copilot-chat-0.40.0", "package.json"),
      JSON.stringify({ contributes: { languageModelChatProviders: [{ vendor: "customoai" }] } }),
    );
    const target = driver("vscodium");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const models = JSON.parse(
      await fs.readFile(path.join(dir, "chatLanguageModels.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(models[0]?.vendor).toBe("customoai");
    expect(JSON.stringify(models)).toContain("maxInputTokens");
    expect(JSON.stringify(models)).toContain("x-api-key");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(
      JSON.parse(await fs.readFile(path.join(dir, "chatLanguageModels.json"), "utf8")),
    ).toEqual([]);
  });

  it("adds MothX's provider and default pick, then restores the file", async () => {
    const filePath = path.join(home, ".mothx", "settings.json");
    const original = {
      defaultProvider: "deepseek-openai",
      defaultModel: "deepseek-chat",
      providers: { own: { baseUrl: "https://own/v1" } },
    };
    await writeJson(filePath, original);
    const target = driver("mothx");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const settings = await readJson(filePath);
    expect(settings.defaultProvider).toBe("neolix");
    expect(settings.defaultModel).toBe("model-one");
    const provider = (settings.providers as Record<string, unknown>).neolix as Record<
      string,
      unknown
    >;
    expect(provider.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(provider.thinkingFormat).toBe("openai");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("points Muse Code's endpoint transport at Neox and restores the reader's", async () => {
    const filePath = path.join(home, ".config", "muse", "settings.json");
    const original = {
      schema_version: 1,
      endpoint_transport: { base_url: "https://api.meta.ai/v1", auth: "bearer" },
      model: "muse-own",
    };
    await writeJson(filePath, original);
    const target = driver("muse");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const settings = await readJson(filePath);
    expect(settings.endpoint_transport).toEqual({ base_url: `${BASE_URL}/v1`, auth: "none" });
    expect(settings.model).toBe("model-two");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });
});
