import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH8_AGENT_DRIVERS } from "./drivers-batch8.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch8-home-"));
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
  const found = BATCH8_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 8 external agents", () => {
  it("makes fx talk to Neox and gives the reader their own provider back", async () => {
    const filePath = path.join(home, ".fx", "settings.json");
    const original = {
      provider: "gateway",
      models: { gateway: "some-model" },
      providers: { own: { protocol: "openai-chat-completions" } },
    };
    await writeJson(filePath, original);
    const target = driver("fx");
    const connectEnvironment = environment({
      models: [
        {
          id: "model-one",
          label: "Model One",
          contextWindow: 200000,
          maxOutputTokens: 8192,
          images: true,
        },
        { id: "model-two" },
      ],
    });
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const settings = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(settings.provider).toBe("neolix");
    expect((settings.models as Record<string, unknown>).neolix).toBe("model-two");
    const provider = (settings.providers as Record<string, unknown>).neolix as Record<
      string,
      unknown
    >;
    expect(provider.protocol).toBe("openai-chat-completions");
    expect(provider.base_url).toBe(`${BASE_URL}/v1`);
    const metadata = provider.model_metadata as Record<string, Record<string, unknown>>;
    expect(metadata["model-one"]).toEqual({
      supports_tool_use: true,
      supports_vision: true,
      context_window: 200000,
      max_output_tokens: 8192,
    });
    // A model the catalog says nothing about keeps fx's own defaults.
    expect(metadata["model-two"]).toEqual({ supports_tool_use: true, supports_vision: false });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual(original);
  });

  it("takes Mister Morph's llm over and puts the reader's keys back", async () => {
    const filePath = path.join(home, ".morph", "config.yaml");
    await write(
      filePath,
      [
        "llm:",
        "  inference_provider: anthropic",
        "  endpoint: https://own.example/v1",
        '  api_key: "reader-key"',
        "  model: own-model",
        "  profiles:",
        "    fast:",
        "      model: fast-model",
        "",
      ].join("\n"),
    );
    const target = driver("morph");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await fs.readFile(filePath, "utf8");
    expect(wired).toContain("inference_provider: openai_response_compatible");
    expect(wired).toContain(`endpoint: ${BASE_URL}/v1`);
    expect(wired).toContain("model: model-one");
    expect(wired).toContain("User-Agent: mistermorph");
    expect(wired).toContain("fast-model");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(filePath, "utf8");
    expect(restored).toContain("inference_provider: anthropic");
    expect(restored).toContain('api_key: "reader-key"');
    expect(restored).toContain("model: own-model");
    expect(restored).not.toContain("mistermorph");
  });

  it("lists AionUi and Cindy as detected, without a connect of their own", async () => {
    await fs.mkdir(path.join(home, "Library", "Application Support", "AionUi"), {
      recursive: true,
    });
    await fs.mkdir(path.join(home, "Library", "Application Support", "Cindy"), {
      recursive: true,
    });
    const connectEnvironment = environment();
    for (const provider of ["aionui", "cindy"]) {
      const target = driver(provider);
      expect(await target.external?.detect(connectEnvironment)).toBe(true);
      expect(target.external?.noConnect).toBe(true);
      expect(await target.read(connectEnvironment)).toEqual({
        connected: false,
        model: null,
        baseUrl: null,
      });
    }
    const aion = driver("aionui").external?.importLink?.(connectEnvironment) ?? "";
    expect(aion.startsWith("aionui://add-provider?")).toBe(true);
    const cindy = driver("cindy").external?.importLink?.(connectEnvironment) ?? "";
    const data = new URL(cindy).searchParams.get("data") ?? "";
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as {
      name: string;
      auth: { apiKey: string };
      endpoints: unknown[];
    };
    expect(cindy.startsWith("cindy://provider/import?v=1&data=")).toBe(true);
    expect(payload.name).toBe("Neox");
    expect(payload.auth.apiKey).toBe(API_KEY);
    expect(payload.endpoints).toHaveLength(3);
  });
});
