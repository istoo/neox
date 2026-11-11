import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH16_AGENT_DRIVERS } from "./drivers-batch16.js";
import type { ConnectEnvironment } from "../drivers.js";
import { GatewayConfigSchema } from "../../llm-gateway/config.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch16-home-"));
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
    models: [
      { id: "model-one", label: "Model One", contextWindow: 1048576, maxOutputTokens: 8192 },
      { id: "model-two" },
    ],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = BATCH16_AGENT_DRIVERS.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no driver for ${provider}`);
  return found;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("batch 16 external agents", () => {
  async function qwenpawHome(): Promise<string> {
    const work = path.join(home, ".qwenpaw");
    await writeJson(path.join(work, "config.json"), {
      agents: {
        agent_order: ["work", "off"],
        profiles: {
          default: { id: "default", workspace_dir: "", enabled: true },
          work: { id: "work", enabled: true },
          off: { id: "off", enabled: false },
        },
      },
    });
    await writeJson(path.join(work, "workspaces", "default", "agent.json"), {
      name: "Default",
      active_model: { provider_id: "own", model: "own/x" },
      thinking_level: "high",
    });
    await writeJson(path.join(work, "workspaces", "work", "agent.json"), {
      name: "Work",
      backend: "qwenpaw",
    });
    return work;
  }

  it("wires QwenPaw's default agent and puts its own model back", async () => {
    const work = await qwenpawHome();
    const agentPath = path.join(work, "workspaces", "default", "agent.json");
    const original = await readJson(agentPath);
    const target = driver("qwenpaw");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(agentPath);
    expect(wired).toMatchObject({ active_model: { provider_id: "neolix", model: "model-one" } });
    expect(wired.thinking_level).toBe("high");

    const providerPath = path.join(work + ".secret", "providers", "custom", "neolix.json");
    const provider = await readJson(providerPath);
    expect(provider).toMatchObject({
      id: "neolix",
      base_url: BASE_URL,
      chat_model: "OpenAIChatModel",
      is_custom: true,
    });
    const models = provider.extra_models as Record<string, unknown>[];
    expect(models[0]).toMatchObject({
      id: "model-one",
      supports_tool_calling: true,
      max_input_length: 1048576,
      max_output_length: 8192,
    });
    expect((await fs.stat(providerPath)).mode & 0o777).toBe(0o600);
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(agentPath)).toEqual(original);
    await expect(fs.stat(providerPath)).rejects.toThrow();
  });

  it("lists QwenPaw's other agents as rows of their own", async () => {
    const work = await qwenpawHome();
    const target = driver("qwenpaw");
    const connectEnvironment = environment();
    expect(await target.external?.variants?.(connectEnvironment)).toEqual([
      { id: "work", name: "QwenPaw · Work" },
    ]);

    const scoped = environment({ variant: "work" });
    const undo = await target.connect(scoped, "model-two", undefined);
    const wired = await readJson(path.join(work, "workspaces", "work", "agent.json"));
    expect((wired.active_model as Record<string, unknown>).model).toBe("model-two");
    expect(await target.read(scoped)).toMatchObject({ connected: true, model: "model-two" });
    const untouched = await readJson(path.join(work, "workspaces", "default", "agent.json"));
    expect((untouched.active_model as Record<string, unknown>).provider_id).toBe("own");

    await target.disconnect(scoped, undo);
    const restored = await readJson(path.join(work, "workspaces", "work", "agent.json"));
    expect(restored.active_model).toBeUndefined();
    expect(restored.name).toBe("Work");
  });

  it("takes QwenPaw's secret folder from its .env", async () => {
    const work = await qwenpawHome();
    const secret = path.join(home, "secret-dir");
    await fs.writeFile(path.join(work, ".env"), `QWENPAW_SECRET_DIR=${secret}\n`);
    const target = driver("qwenpaw");
    await target.connect(environment(), "model-one", undefined);
    expect(await readJson(path.join(secret, "providers", "custom", "neolix.json"))).toMatchObject({
      id: "neolix",
    });
  });

  it("gives T3 Code a Neox Claude instance, a Codex one, and its catalog", async () => {
    const settingsPath = path.join(home, ".t3", "userdata", "settings.json");
    const original = {
      providerInstances: {
        claudeAgent: { driver: "claudeAgent", config: { binaryPath: "/opt/claude" } },
      },
      theme: "dark",
    };
    await writeJson(settingsPath, original);
    const target = driver("t3code");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(settingsPath);
    const instances = wired.providerInstances as Record<string, Record<string, unknown>>;
    const claude = instances.neolix ?? {};
    expect(claude).toMatchObject({
      driver: "claudeAgent",
      displayName: "Neox",
      enabled: true,
    });
    expect(claude.environment).toEqual(
      expect.arrayContaining([
        { name: "ANTHROPIC_BASE_URL", value: BASE_URL, sensitive: false },
        { name: "ANTHROPIC_AUTH_TOKEN", value: API_KEY, sensitive: false },
      ]),
    );
    const config = claude.config as Record<string, unknown>;
    expect(config.binaryPath).toBe("/opt/claude");
    const custom = config.customModels as Record<string, unknown>[];
    expect(custom).toHaveLength(2);
    expect(custom[0]).toMatchObject({ slug: "model-one[1m]", name: "Model One" });
    const capabilities = (custom[0] ?? {}).capabilities as Record<string, unknown>;
    expect(capabilities.optionDescriptors).toBeDefined();

    const codex = instances["neolix-codex"] ?? {};
    const launchArgs = (codex.config as Record<string, unknown>).launchArgs as string;
    expect(launchArgs).toContain('model_provider=\\"neolix\\"');
    expect(launchArgs).toContain(`${BASE_URL}/v1`);
    expect(launchArgs).toContain("neolix-codex-models.json");

    const catalog = await readJson(path.join(home, ".t3", "userdata", "neolix-codex-models.json"));
    expect((catalog.models as Record<string, unknown>[])[0]).toMatchObject({
      slug: "model-one",
      display_name: "Model One",
      context_window: 1048576,
    });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(original);
    await expect(
      fs.stat(path.join(home, ".t3", "userdata", "neolix-codex-models.json")),
    ).rejects.toThrow();
  });

  it("gives T3 Code's catalog the user's reasoning levels, and none to a reasonless model", async () => {
    const target = driver("t3code");
    const connectEnvironment = environment({
      models: [{ id: "relay/model-one", label: "Model One" }, { id: "relay/model-two" }],
      config: GatewayConfigSchema.parse({
        modelEfforts: { "relay/model-one": ["low", "max"] },
        modelReasonless: { "relay/model-two": true },
      }),
    });
    await target.connect(connectEnvironment, null, undefined);
    const catalog = await readJson(path.join(home, ".t3", "userdata", "neolix-codex-models.json"));
    const models = catalog.models as Record<string, unknown>[];
    expect(models[0]?.supported_reasoning_levels).toEqual([
      { effort: "low", description: "Low" },
      { effort: "max", description: "Max" },
    ]);
    expect(models[0]?.supports_reasoning_summaries).toBe(true);
    expect(models[1]?.supported_reasoning_levels).toEqual([]);
    expect(models[1]?.supports_reasoning_summaries).toBe(false);
  });
});
