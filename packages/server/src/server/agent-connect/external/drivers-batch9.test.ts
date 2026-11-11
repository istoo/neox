import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH9_AGENT_DRIVERS } from "./drivers-batch9.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch9-home-"));
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
  const found = BATCH9_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 9 external agents", () => {
  it("wires DevEco Code through OpenCode's provider shape and restores it", async () => {
    const filePath = path.join(home, ".config", "deveco", "deveco.json");
    const original = { provider: { other: { npm: "x" } }, model: "other/m" };
    await writeJson(filePath, original);
    const target = driver("deveco");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(filePath);
    expect(wired.model).toBe("neolix/model-one");
    const provider = (wired.provider as Record<string, unknown>).neolix as Record<string, unknown>;
    expect((provider.options as Record<string, unknown>).baseURL).toBe(`${BASE_URL}/v1`);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("wires Qoder CN's provider and pick, then restores the reader's", async () => {
    const filePath = path.join(home, ".qoder-cn", "settings.json");
    const original = {
      providers: { other: { protocol: "openai" } },
      model: { name: "other/x", reasoningEffort: "high" },
    };
    await writeJson(filePath, original);
    const target = driver("qoder-cn");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await readJson(filePath);
    expect((wired.model as Record<string, unknown>).name).toBe("neolix/model-two");
    expect((wired.model as Record<string, unknown>).reasoningEffort).toBeUndefined();
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("adds WorkBuddy AI's models in its own folder and restores the file", async () => {
    const filePath = path.join(home, ".workbuddy-ai", "models.json");
    const original = [{ id: "own", name: "Own", vendor: "other", apiKey: "other-key" }];
    await writeJson(filePath, original);
    const target = driver("workbuddy-ai");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>[];
    expect(wired).toHaveLength(2);
    expect(wired[1]?.vendor).toBe("neolix");
    expect(wired[1]?.url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(original);
  });
});
