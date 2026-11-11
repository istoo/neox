import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH12_AGENT_DRIVERS } from "./drivers-batch12.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch12-home-"));
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
  const found = BATCH12_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 12 external agents", () => {
  it("wires OmO in Pi's shape and restores both files", async () => {
    const dir = path.join(home, ".omo", "agent");
    const settingsPath = path.join(dir, "settings.json");
    const modelsPath = path.join(dir, "models.json");
    const originalSettings = {
      defaultProvider: "own",
      defaultModel: "own/m",
      defaultThinkingLevel: "high",
    };
    const originalModels = { providers: { own: { name: "Own", baseUrl: "https://own" } } };
    await writeJson(settingsPath, originalSettings);
    await writeJson(modelsPath, originalModels);
    const target = driver("omo");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    expect(await readJson(settingsPath)).toMatchObject({
      defaultProvider: "neolix",
      defaultModel: "model-two",
      defaultThinkingLevel: "high",
    });
    const provider = (await readJson(modelsPath)).providers as Record<string, unknown>;
    expect(provider.neolix).toMatchObject({
      baseUrl: `${BASE_URL}/v1`,
      api: "openai-completions",
    });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(originalSettings);
    expect(await readJson(modelsPath)).toEqual(originalModels);
  });

  it("wires Prime Agent under its own agent folder", async () => {
    const dir = path.join(home, "prime-agent-dir");
    const settingsPath = path.join(dir, "settings.json");
    const modelsPath = path.join(dir, "models.json");
    await writeJson(settingsPath, { defaultProvider: "own" });
    await writeJson(modelsPath, { providers: {} });
    const target = driver("prime-agent");
    const connectEnvironment = environment({
      env: { PATH: "", PRIME_AGENT_CODING_AGENT_DIR: dir },
    });

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    expect((await readJson(settingsPath)).defaultProvider).toBe("neolix");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual({ defaultProvider: "own" });
    // The reader's own empty map is theirs and comes back (a delete prunes
    // empty objects Neolix made, not ones that were there).
    expect(await readJson(modelsPath)).toEqual({ providers: {} });
  });

  it("adds Empryo's keyless provider and restores the reader's default", async () => {
    const filePath = path.join(home, ".empryo", "config.json");
    const original = {
      defaultModel: "own/m",
      providers: [{ id: "own", name: "Own", baseURL: "https://own/v1" }],
    };
    await writeJson(filePath, original);
    const target = driver("empryo");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(filePath);
    expect(wired.defaultModel).toBe("neolix/model-one");
    const providers = wired.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(2);
    expect(providers[1]).toEqual({
      id: "neolix",
      name: "Neox",
      baseURL: `${BASE_URL}/v1`,
      modelsAPI: `${BASE_URL}/v1/models`,
    });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });
});
