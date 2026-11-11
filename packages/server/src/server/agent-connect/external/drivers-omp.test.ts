import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { ConnectEnvironment } from "../drivers.js";
import { AGENT_CONNECT_DRIVERS } from "../drivers.js";

const ompDriver = AGENT_CONNECT_DRIVERS.find((entry) => entry.provider === "omp");
if (ompDriver === undefined) throw new Error("no omp driver");

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-omp-home-"));
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
    models: [{ id: "model-one", label: "Model One", contextWindow: 200000 }],
    platform: "darwin",
    ...overrides,
  };
}

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function readYaml(filePath: string): Promise<Record<string, unknown>> {
  return parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("omp driver", () => {
  it("wires the default role, the provider and enabledModels, then restores them", async () => {
    const dir = path.join(home, ".omp", "agent");
    const configPath = path.join(dir, "config.yml");
    const modelsPath = path.join(dir, "models.yml");
    await write(
      configPath,
      ["modelRoles:", "  default: own/model", "enabledModels:", "  - own/model", ""].join("\n"),
    );
    await write(modelsPath, "providers:\n  own:\n    baseUrl: https://example.test\n");
    const target = ompDriver;

    const undo = await target.connect(environment(), "model-one", undefined);
    const config = await readYaml(configPath);
    expect((config.modelRoles as Record<string, unknown>).default).toBe("neolix/model-one");
    expect(config.enabledModels).toEqual(["own/model", "neolix/**"]);
    const models = await readYaml(modelsPath);
    const provider = (models.providers as Record<string, Record<string, unknown>>).neolix;
    expect(provider).toMatchObject({
      baseUrl: `${BASE_URL}/v1`,
      api: "openai-completions",
      apiKey: API_KEY,
      headers: { "User-Agent": "omp" },
    });
    expect((provider.models as Record<string, unknown>[])[0]).toMatchObject({
      id: "model-one",
      name: "Model One",
      contextWindow: 200000,
    });
    expect(await target.read(environment())).toEqual({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(environment(), undo);
    const restored = await readYaml(configPath);
    expect((restored.modelRoles as Record<string, unknown>).default).toBe("own/model");
    expect(restored.enabledModels).toEqual(["own/model"]);
    const restoredModels = await readYaml(modelsPath);
    expect((restoredModels.providers as Record<string, unknown>).neolix).toBeUndefined();
    expect(restoredModels.providers).toMatchObject({ own: { baseUrl: "https://example.test" } });
  });

  it("never creates an enabledModels list and follows PI_CONFIG_DIR", async () => {
    const target = ompDriver;
    const scoped = environment({ env: { PATH: "", PI_CONFIG_DIR: ".omp-alt" } });
    await target.connect(scoped, "model-one", undefined);
    const configPath = path.join(home, ".omp-alt", "agent", "config.yml");
    const config = await readYaml(configPath);
    expect(config.enabledModels).toBeUndefined();
    expect((config.modelRoles as Record<string, unknown>).default).toBe("neolix/model-one");
  });

  it("carries an older models.json over when it writes models.yml", async () => {
    const dir = path.join(home, ".omp", "agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "models.json"),
      JSON.stringify({ providers: { own: { baseUrl: "https://example.test" } } }),
      "utf8",
    );
    await ompDriver.connect(environment(), "model-one", undefined);
    const models = await readYaml(path.join(dir, "models.yml"));
    expect(models.providers).toMatchObject({
      own: { baseUrl: "https://example.test" },
      neolix: { baseUrl: `${BASE_URL}/v1` },
    });
  });

  it("reads the version omp reports", async () => {
    const calls: string[] = [];
    const version = await ompDriver.version?.(
      environment({
        run: async (command, args) => {
          calls.push([command, ...args].join(" "));
          return "omp 18.4.4\n";
        },
      }),
    );
    expect(version).toBe("18.4.4");
    expect(calls).toEqual(["omp --version"]);
  });

  it("lists myna's roles, each thinking level and the session's thinking", async () => {
    const dir = path.join(home, ".omp", "agent");
    await write(
      path.join(dir, "config.yml"),
      [
        "modelRoles:",
        "  default: neolix/model-one",
        "  task: neolix/model-two:high",
        "  smol:",
        "defaultThinkingLevel: medium",
        "",
      ].join("\n"),
    );
    const settings = await ompDriver.settings?.(environment());
    const keys = settings?.map((entry) => entry.key);
    expect(keys).toEqual([
      "model",
      "subagent",
      "subagent_thinking",
      "small",
      "small_thinking",
      "slow",
      "slow_thinking",
      "plan",
      "plan_thinking",
      "vision",
      "vision_thinking",
      "advisor",
      "advisor_thinking",
      "commit",
      "commit_thinking",
      "tiny",
      "tiny_thinking",
      "memory",
      "memory_thinking",
      "effort",
    ]);
    expect(settings?.find((entry) => entry.key === "model")).toMatchObject({
      label: "model",
      value: "neolix/model-one",
      options: ["neolix/model-one"],
    });
    expect(settings?.find((entry) => entry.key === "subagent")).toMatchObject({
      value: "neolix/model-two:high",
    });
    expect(settings?.find((entry) => entry.key === "subagent_thinking")).toMatchObject({
      value: "high",
      options: ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
    expect(settings?.find((entry) => entry.key === "small_thinking")).toEqual({
      key: "small_thinking",
      label: "smol thinking",
      value: "",
    });
    expect(settings?.find((entry) => entry.key === "effort")).toMatchObject({
      value: "medium",
      options: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });

  it("writes a role, its thinking and the session's thinking without reconnecting", async () => {
    const dir = path.join(home, ".omp", "agent");
    const configPath = path.join(dir, "config.yml");
    const modelsPath = path.join(dir, "models.yml");
    await write(configPath, "modelRoles:\n  default: own/model\ndefaultThinkingLevel: low\n");

    await ompDriver.setSetting?.(environment(), "subagent", "model-two");
    let config = await readYaml(configPath);
    expect((config.modelRoles as Record<string, unknown>).task).toBe("neolix/model-two");
    expect(
      ((await readYaml(modelsPath)).providers as Record<string, unknown>).neolix,
    ).toBeDefined();

    await ompDriver.setSetting?.(environment(), "subagent_thinking", "high");
    config = await readYaml(configPath);
    expect((config.modelRoles as Record<string, unknown>).task).toBe("neolix/model-two:high");

    await ompDriver.setSetting?.(environment(), "subagent_thinking", "");
    config = await readYaml(configPath);
    expect((config.modelRoles as Record<string, unknown>).task).toBe("neolix/model-two");

    await ompDriver.setSetting?.(environment(), "effort", "auto");
    expect((await readYaml(configPath)).defaultThinkingLevel).toBe("auto");
    await ompDriver.setSetting?.(environment(), "effort", "");
    expect((await readYaml(configPath)).defaultThinkingLevel).toBeUndefined();
  });

  it("refuses a thinking level on a role that is not one model", async () => {
    await write(
      path.join(home, ".omp", "agent", "config.yml"),
      "modelRoles:\n  task: a/one,b/two\n",
    );
    await expect(
      ompDriver.setSetting?.(environment(), "subagent_thinking", "high"),
    ).rejects.toThrow("pick its model first");
  });

  it("writes the gateway's image models for omp 18.7 and later", async () => {
    const run = async () => "omp 18.7.0\n";
    await ompDriver.connect(
      environment({ run, gatewayImageModels: ["draw/one"] }),
      "model-one",
      undefined,
    );
    const models = await readYaml(path.join(home, ".omp", "agent", "models.yml"));
    const provider = (models.providers as Record<string, Record<string, unknown>>).neolix;
    expect(provider.models).toContainEqual({
      id: "draw/one",
      name: "draw/one",
      api: "openai-images",
      kind: "image",
      input: ["text"],
    });
  });

  it("lists named profiles as variants and writes into the one chosen", async () => {
    const profile = path.join(home, ".omp", "profiles", "work", "agent");
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "config.yml"), "modelRoles: {}\n", "utf8");
    expect(await ompDriver.external?.variants?.(environment())).toEqual([
      { id: "work", name: "omp · work" },
    ]);

    const scoped = environment({ variant: "work" });
    await ompDriver.connect(scoped, "model-one", undefined);
    const config = await readYaml(path.join(profile, "config.yml"));
    expect((config.modelRoles as Record<string, unknown>).default).toBe("neolix/model-one");
    expect(
      ((await readYaml(path.join(profile, "models.yml"))).providers as Record<string, unknown>)
        .neolix,
    ).toBeDefined();
  });

  it("is detected by its folder, its command or a profile", async () => {
    expect(await ompDriver.external?.detect(environment())).toBe(false);
    await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
    expect(await ompDriver.external?.detect(environment())).toBe(true);
  });
});
