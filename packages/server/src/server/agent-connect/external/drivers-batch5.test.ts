import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH5_AGENT_DRIVERS } from "./drivers-batch5.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch5-home-"));
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
  const found = BATCH5_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 5 external agents", () => {
  it("writes ZCode's provider to both of its files and takes only that out", async () => {
    const configPath = path.join(home, ".zcode", "v2", "config.json");
    const rulesPath = path.join(home, ".zcode", "v2", "provider_config.json");
    await writeJson(configPath, { provider: { other: { name: "Other" } } });
    await writeJson(rulesPath, {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [{ providerId: "other", providerName: "Other" }] },
        modelConfigRules: { manualProviderModelRules: [] },
      },
    });
    const target = driver("zcode");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const config = await readJson(configPath);
    const provider = (config.provider as Record<string, unknown>).neolix as Record<string, unknown>;
    expect((provider.options as Record<string, unknown>).baseURL).toBe(BASE_URL);
    expect((provider.models as Record<string, unknown>)["model-two"]).toBeDefined();
    const rules = await readJson(rulesPath);
    const providerRules = (
      (rules.config as Record<string, unknown>).providerConfigRules as Record<string, unknown>
    ).providerRules as unknown[];
    expect(providerRules).toHaveLength(2);
    expect(JSON.stringify(providerRules)).toContain("standard-personal");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(configPath)).toEqual({ provider: { other: { name: "Other" } } });
    const restoredRules = await readJson(rulesPath);
    expect(JSON.stringify(restoredRules)).not.toContain("neolix");
  });

  it("writes the catalog's window, output and images into ZCode and Crush", async () => {
    const meta = environment({
      models: [
        {
          id: "model-one",
          label: "Model One",
          contextWindow: 200000,
          maxOutputTokens: 32000,
          images: true,
        },
      ],
    });
    const zcode = driver("zcode");
    await zcode.connect(meta, null, undefined);
    const config = await readJson(path.join(home, ".zcode", "v2", "config.json"));
    const provider = (config.provider as Record<string, unknown>).neolix as Record<string, unknown>;
    const model = (provider.models as Record<string, Record<string, unknown>>)["model-one"];
    expect(model?.limit).toEqual({ context: 200000, output: 32000 });
    expect(model?.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
    const rules = await readJson(path.join(home, ".zcode", "v2", "provider_config.json"));
    const modelRules = (
      (rules.config as Record<string, unknown>).modelConfigRules as Record<string, unknown>
    ).providerModelRules as Record<string, unknown>[];
    expect(modelRules[0]?.config).toMatchObject({
      properties: { contextWindow: 200000, inputFormat: { supportsImage: true } },
    });

    const crush = driver("crush");
    await crush.connect(meta, null, undefined);
    const crushConfig = await readJson(path.join(home, ".config", "crush", "crush.json"));
    const crushProvider = (crushConfig.providers as Record<string, unknown>).neolix as Record<
      string,
      unknown
    >;
    expect((crushProvider.models as Record<string, unknown>[])[0]).toMatchObject({
      context_window: 200000,
      default_max_tokens: 32000,
    });
  });

  it("points OpenChamber's profile at Neox and wires its OpenCode config", async () => {
    const dir = path.join(home, ".config", "openchamber");
    const prefsPath = path.join(dir, "preferences.json");
    const settingsPath = path.join(dir, "settings.json");
    await writeJson(prefsPath, {
      version: 1,
      fields: { defaultModel: { value: "other/x", updatedAt: 1 } },
    });
    await writeJson(settingsPath, { defaultModel: "other/x" });
    const target = driver("openchamber");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const prefs = await readJson(prefsPath);
    const fields = prefs.fields as Record<string, Record<string, unknown>>;
    expect(fields.defaultModel?.value).toBe("neolix/model-one");
    expect((await readJson(settingsPath)).defaultModel).toBe("neolix/model-one");
    const openCode = await readJson(path.join(home, ".config", "opencode", "opencode.json"));
    expect(
      ((openCode.provider as Record<string, unknown>).neolix as Record<string, unknown>).name,
    ).toBe("Neox");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect((await readJson(prefsPath)).fields).toMatchObject({
      defaultModel: { value: "other/x", updatedAt: 1 },
    });
    expect((await readJson(settingsPath)).defaultModel).toBe("other/x");
  });

  it("adds Crush's provider and pick and restores both files", async () => {
    const configPath = path.join(home, ".config", "crush", "crush.json");
    const dataPath = path.join(home, ".local", "share", "crush", "crush.json");
    await writeJson(configPath, { providers: { other: { type: "openai" } } });
    await writeJson(dataPath, { models: { small: { provider: "other", model: "x" } } });
    const target = driver("crush");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const config = await readJson(configPath);
    const provider = (config.providers as Record<string, unknown>).neolix as Record<
      string,
      unknown
    >;
    expect(provider.base_url).toBe(`${BASE_URL}/v1`);
    const data = await readJson(dataPath);
    expect((data.models as Record<string, unknown>).large).toEqual({
      provider: "neolix",
      model: "model-two",
    });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(configPath)).toEqual({ providers: { other: { type: "openai" } } });
    expect(await readJson(dataPath)).toEqual({
      models: { small: { provider: "other", model: "x" } },
    });
  });

  it("wires dsh's profile patch, its key and its credential store, then restores them", async () => {
    const dir = path.join(home, ".dsh");
    const patch = path.join(dir, "profiles", "web", "cordis.patch.yml");
    const prior =
      "- id: llm-pi-ai\n  config:\n    providers:\n      other:\n        api: openai-completions\n";
    await write(patch, prior);
    const target = driver("dsh");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(patch, "utf8");
    expect(wired).toContain("neolix:");
    expect(wired).toContain("other:");
    expect(wired).toContain("agent-default-model");
    expect(await fs.readFile(path.join(dir, ".env"), "utf8")).toContain("NEOLIX_GATEWAY_KEY=");
    expect(await fs.readFile(path.join(dir, ".credentials.yaml"), "utf8")).toContain(
      "NEOLIX_GATEWAY_KEY",
    );
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await fs.readFile(patch, "utf8")).toBe(prior);
    expect(await fs.readFile(path.join(dir, ".env"), "utf8")).not.toContain("NEOLIX_GATEWAY_KEY");
    expect(await fs.readFile(path.join(dir, ".credentials.yaml"), "utf8")).not.toContain(
      "NEOLIX_GATEWAY_KEY",
    );
  });

  it("makes dsh's web profile when it has none and removes it again", async () => {
    const patch = path.join(home, ".dsh", "profiles", "web", "cordis.patch.yml");
    const target = driver("dsh");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, null, undefined);
    expect(await fs.readFile(patch, "utf8")).toContain("model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    await expect(fs.stat(patch)).rejects.toThrow();
  });
});
