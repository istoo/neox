import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH19_AGENT_DRIVERS } from "./drivers-batch19.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch19-home-"));
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
    models: [{ id: "model-one", label: "Model One", contextWindow: 200000, images: true }],
    platform: "darwin",
    ...overrides,
  };
}

function driver() {
  const found = BATCH19_AGENT_DRIVERS.find((entry) => entry.provider === "hanako");
  if (!found) throw new Error("no hanako driver");
  return found;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

const hanakoRoot = () => path.join(home, ".hanako");
const configPath = () => path.join(hanakoRoot(), "agents", "primary", "config.yaml");

async function makeAgent(): Promise<void> {
  await writeJson(path.join(hanakoRoot(), "user", "preferences.json"), {
    primaryAgent: "primary",
  });
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(configPath(), "models:\n  chat:\n    id: own-model\n    provider: own\n");
}

describe("batch 19 external agents", () => {
  it("adds OpenHanako's provider and points its agent's chat at it", async () => {
    await makeAgent();
    const original = await fs.readFile(configPath(), "utf8");
    // A plugin left by an older OpenHanako goes, or its models stay beside these.
    await writeJson(
      path.join(hanakoRoot(), "provider-plugins", "neolix", "providers", "neolix.json"),
      {
        displayName: "old",
      },
    );
    const target = driver();
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const catalog = await readJson(path.join(hanakoRoot(), "provider-catalog.json"));
    const provider = (catalog.providers as Record<string, Record<string, unknown>>).neolix ?? {};
    expect(provider).toMatchObject({
      display_name: "neolix",
      base_url: `${BASE_URL}/v1`,
      api: "openai-completions",
    });
    expect((provider.models as Record<string, unknown>[])[0]).toMatchObject({
      id: "model-one",
      context: 200000,
      image: true,
    });
    await expect(fs.stat(path.join(hanakoRoot(), "provider-plugins", "neolix"))).rejects.toThrow();
    expect(await fs.readFile(configPath(), "utf8")).toContain("provider: neolix");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await fs.readFile(configPath(), "utf8")).toBe(original);
    const restored = await readJson(path.join(hanakoRoot(), "provider-catalog.json"));
    expect(restored.providers).toBeUndefined();
    expect((restored.meta as Record<string, unknown>).deletedProviders).toContain("neolix");
  });

  it("keeps a sealed catalog's plugin up to date instead of writing the catalog", async () => {
    await makeAgent();
    await fs.mkdir(hanakoRoot(), { recursive: true });
    await fs.writeFile(
      path.join(hanakoRoot(), "provider-catalog.json"),
      "HANA-SECRET-1.AES-256-GCM.ciphertext\n",
    );
    const pluginPath = path.join(
      hanakoRoot(),
      "provider-plugins",
      "neolix",
      "providers",
      "neolix.json",
    );
    await writeJson(pluginPath, {
      displayName: "neolix",
      defaultBaseUrl: "http://127.0.0.1:6768/v1",
      defaultApi: "openai-completions",
      models: [],
    });
    const target = driver();
    await target.connect(environment(), "model-one", undefined);
    expect(await readJson(pluginPath)).toMatchObject({
      displayName: "neolix",
      defaultBaseUrl: `${BASE_URL}/v1`,
      models: [{ id: "model-one" }],
    });
    expect(await fs.readFile(path.join(hanakoRoot(), "provider-catalog.json"), "utf8")).toBe(
      "HANA-SECRET-1.AES-256-GCM.ciphertext\n",
    );
    expect(await target.read(environment())).toMatchObject({ connected: true });
  });

  it("says OpenHanako must be open when its catalog is sealed and Neox is not in it", async () => {
    await makeAgent();
    await fs.mkdir(hanakoRoot(), { recursive: true });
    await fs.writeFile(
      path.join(hanakoRoot(), "provider-catalog.json"),
      "HANA-SECRET-1.AES-256-GCM.ciphertext\n",
    );
    await expect(driver().connect(environment(), "model-one", undefined)).rejects.toThrow(
      "open OpenHanako",
    );
  });
});
