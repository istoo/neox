import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH10_AGENT_DRIVERS } from "./drivers-batch10.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch10-home-"));
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
  const found = BATCH10_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 10 external agents", () => {
  it("wires PenguinHarness's project config and restores its default", async () => {
    const filePath = path.join(home, ".penguin", "data", "default_project", ".project_config.toml");
    await write(
      filePath,
      [
        'default_model = { provider = "own", model_id = "m" }',
        "",
        "[providers.own]",
        'base_url = "https://own/v1"',
        "",
        "[[models]]",
        'provider = "own"',
        'model_id = "m"',
        "",
      ].join("\n"),
    );
    const target = driver("penguin");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(filePath, "utf8");
    expect(wired).toContain('default_model = { provider = "neolix", model_id = "model-one" }');
    expect(wired).toContain("[providers.neolix]");
    expect(wired).toContain('client_type = "openai-responses"');
    expect(wired).toContain('model_id = "model-one"');
    expect(wired).toContain("[providers.own]");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(filePath, "utf8");
    expect(restored).toContain('default_model = { provider = "own", model_id = "m" }');
    expect(restored).toContain("[providers.own]");
    expect(restored).not.toContain("neolix");
  });

  it("adds Pencil's provider in Pi's format and takes it out again", async () => {
    const filePath = path.join(home, ".pencil", "models.json");
    const original = { providers: { own: { name: "Own", baseUrl: "https://own/v1" } } };
    await writeJson(filePath, original);
    const target = driver("pencil");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(filePath);
    const provider = (wired.providers as Record<string, unknown>).neolix as Record<string, unknown>;
    expect(provider.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(provider.api).toBe("openai-completions");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("lists Neox among OpenBot's custom endpoints and restores the file", async () => {
    const filePath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenBot",
      "openbot-custom-providers-v1.json",
    );
    const original = {
      version: 1,
      providers: [{ id: "own", name: "Own", baseUrl: "https://own/v1" }],
    };
    await writeJson(filePath, original);
    const target = driver("openbot");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(filePath);
    const providers = wired.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(2);
    const ours = providers.find((entry) => entry.id === "neolix");
    expect(ours?.baseUrl).toBe(`${BASE_URL}/v1`);
    expect(ours?.secret).toBeNull();
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("keeps only model ids OpenBot accepts and the reader's own secret", async () => {
    const filePath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenBot",
      "openbot-custom-providers-v1.json",
    );
    await writeJson(filePath, {
      version: 1,
      providers: [{ id: "neolix", name: "Neox", secret: "sealed-by-the-reader" }],
    });
    const target = driver("openbot");
    const connectEnvironment = environment({
      models: [
        { id: "model-one" },
        { id: "bad id" },
        { id: "模型" },
        { id: "vendor/model:free[1m]" },
      ],
    });

    await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(filePath);
    const ours = (wired.providers as Record<string, unknown>[]).find(
      (entry) => entry.id === "neolix",
    );
    const ids = ((ours?.models ?? []) as { id: string }[]).map((entry) => entry.id);
    expect(ids).toEqual(["model-one", "vendor/model:free[1m]"]);
    // myna only keeps a secret the reader sealed in OpenBot; it writes none.
    expect(ours?.secret).toBe("sealed-by-the-reader");
  });

  it("refuses an OpenBot file whose version it does not know", async () => {
    const filePath = path.join(
      home,
      "Library",
      "Application Support",
      "OpenBot",
      "openbot-custom-providers-v1.json",
    );
    await writeJson(filePath, { version: 2, providers: [] });
    const target = driver("openbot");
    await expect(target.connect(environment(), null, undefined)).rejects.toThrow(/version 1/);
  });
});
