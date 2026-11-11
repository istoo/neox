import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH11_AGENT_DRIVERS } from "./drivers-batch11.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch11-home-"));
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
  const found = BATCH11_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 11 external agents", () => {
  it("adds OpenPencil's builtin agent and takes it out again", async () => {
    const filePath = path.join(
      home,
      "Library",
      "Application Support",
      "openpencil",
      "settings.json",
    );
    const original = {
      version: 1,
      builtin_agents: [{ id: "own", preset: "custom", display_name: "Own" }],
      theme: "dark",
    };
    await writeJson(filePath, original);
    const target = driver("openpencil");
    // The process probe is injected: no test runs `ps` on the host.
    const connectEnvironment = environment({ run: async () => "" });

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(filePath);
    const agents = wired.builtin_agents as Record<string, unknown>[];
    expect(agents).toHaveLength(2);
    const ours = agents.find((entry) => entry.id === "neolix");
    expect(ours?.kind).toBe("openai-compat");
    expect(ours?.base_url).toBe(`${BASE_URL}/v1`);
    expect(ours?.models).toEqual(["model-one", "model-two"]);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("refuses to write OpenPencil's settings while OpenPencil is open", async () => {
    const filePath = path.join(
      home,
      "Library",
      "Application Support",
      "openpencil",
      "settings.json",
    );
    await writeJson(filePath, { version: 1, builtin_agents: [] });
    const target = driver("openpencil");
    const connectEnvironment = environment({
      run: async () => "/Applications/OpenPencil.app/Contents/MacOS/openpencil-desktop\n",
    });

    await expect(target.connect(connectEnvironment, null, undefined)).rejects.toThrow(
      /quit OpenPencil/,
    );
    expect(await readJson(filePath)).toEqual({ version: 1, builtin_agents: [] });
  });

  it("wires Ante's catalog and start pick, then restores the reader's", async () => {
    const dir = path.join(home, ".ante");
    const catalogPath = path.join(dir, "catalog.json");
    const settingsPath = path.join(dir, "settings.json");
    const originalCatalog = { providers: { own: { display_name: "Own" } }, models: {} };
    const originalSettings = { provider: "own", model: "own/m" };
    await writeJson(catalogPath, originalCatalog);
    await writeJson(settingsPath, originalSettings);
    const target = driver("ante");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const catalog = await readJson(catalogPath);
    const entry = (catalog.providers as Record<string, unknown>).neolix as Record<string, unknown>;
    expect(entry.base_url).toBe(`${BASE_URL}/v1`);
    expect(entry.wire_style).toBe("OpenAiCompatible");
    expect(await readJson(settingsPath)).toEqual({ provider: "neolix", model: "model-two" });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(catalogPath)).toEqual(originalCatalog);
    expect(await readJson(settingsPath)).toEqual(originalSettings);
  });

  it("adds AstrBot's source, its models and its start pick over a BOM and restores them", async () => {
    const filePath = path.join(home, ".astrbot", "data", "cmd_config.json");
    const original = {
      provider_sources: [{ id: "own", provider: "openai", api_base: "https://own/v1" }],
      provider: [{ id: "own/m", provider_source_id: "own", model: "m" }],
      agent_runner: { config: { model: { provider_id: "own/m" } } },
      theme: "dark",
    };
    await write(filePath, `﻿${JSON.stringify(original, null, 2)}\n`);
    const target = driver("astrbot");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw.startsWith("﻿")).toBe(true);
    const wired = JSON.parse(raw.slice(1)) as Record<string, unknown>;
    expect((wired.provider_sources as unknown[]).length).toBe(2);
    expect((wired.provider as unknown[]).length).toBe(3);
    expect(
      ((wired.agent_runner as Record<string, unknown>).config as Record<string, unknown>).model,
    ).toMatchObject({ provider_id: "neolix/model-one" });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });
    const backup = await fs.readFile(`${filePath}.before-neolix`, "utf8");
    expect(backup.startsWith("﻿")).toBe(true);

    await target.disconnect(connectEnvironment, undo);
    const restored = JSON.parse((await fs.readFile(filePath, "utf8")).slice(1)) as Record<
      string,
      unknown
    >;
    expect((restored.provider_sources as unknown[]).length).toBe(1);
    expect((restored.provider as unknown[]).length).toBe(1);
    expect(
      ((restored.agent_runner as Record<string, unknown>).config as Record<string, unknown>).model,
    ).toMatchObject({ provider_id: "own/m" });
    expect(restored.theme).toBe("dark");
  });
});
