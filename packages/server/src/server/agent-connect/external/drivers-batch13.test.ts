import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH13_AGENT_DRIVERS } from "./drivers-batch13.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch13-home-"));
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
  const found = BATCH13_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 13 external agents", () => {
  it("wires StepCode's TOML pick and models, joining its allow-list", async () => {
    const dir = path.join(home, ".stepcode");
    const configPath = path.join(dir, "config.toml");
    const modelsPath = path.join(dir, "models.json");
    await write(
      configPath,
      [
        'defaultProvider = "own"',
        'defaultModel = "m"',
        'enabledModels = ["own/m"]',
        "",
        "[ui]",
        'theme = "dark"',
        "",
      ].join("\n"),
    );
    await writeJson(modelsPath, { providers: { own: { name: "Own" } } });
    const target = driver("stepcode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(configPath, "utf8");
    expect(wired).toContain('defaultProvider = "neolix"');
    expect(wired).toContain('defaultModel = "model-one"');
    expect(wired).toContain('"own/m", "neolix/model-one"');
    const provider = (await readJson(modelsPath)).providers as Record<string, unknown>;
    expect(provider.neolix).toMatchObject({ baseUrl: `${BASE_URL}/v1`, api: "openai-completions" });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(configPath, "utf8");
    expect(restored).toContain('defaultProvider = "own"');
    expect(restored).toContain('defaultModel = "m"');
    expect(restored).toContain('enabledModels = ["own/m"]');
    expect(await readJson(modelsPath)).toEqual({ providers: { own: { name: "Own" } } });
  });

  it("adds Copilot (JetBrains)'s byok provider and takes it out again", async () => {
    const byokPath = path.join(home, ".config", "github-copilot", "byok.json");
    const original = { "other-provider-config": { groupName: "other" } };
    await writeJson(byokPath, original);
    await fs.mkdir(
      path.join(
        home,
        "Library",
        "Application Support",
        "JetBrains",
        "IntelliJIdea2025.1",
        "plugins",
        "github-copilot-intellij",
      ),
      { recursive: true },
    );
    const target = driver("copilot-jetbrains");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(byokPath);
    expect(wired["neolix-provider-config"]).toEqual({
      groupName: "neolix",
      apiType: "chatCompletions",
    });
    expect(wired["neolix-api-key"]).toBe(API_KEY);
    const models = wired["neolix-models-config"] as Record<string, Record<string, unknown>>;
    const first = models["model-one"];
    expect(first?.deploymentUrl).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(first?.isCustomModel).toBe(true);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(byokPath)).toEqual(original);
  });
});
