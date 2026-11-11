import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectEnvironment } from "../drivers.js";
import { AGENT_CONNECT_DRIVERS } from "../drivers.js";
import { GatewayConfigSchema } from "../../llm-gateway/config.js";
import { clearCopilotModelsCache } from "./drivers-copilot.js";

const copilotDriver = AGENT_CONNECT_DRIVERS.find((entry) => entry.provider === "copilot");
if (copilotDriver === undefined) throw new Error("no copilot driver");

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  clearCopilotModelsCache();
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-copilot-home-"));
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
      { id: "model-one", label: "Model One", contextWindow: 200000, maxOutputTokens: 64000 },
    ],
    platform: "darwin",
    ...overrides,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("Copilot CLI driver", () => {
  it("writes providers.json and the picked model, then restores the user's own", async () => {
    const dir = path.join(home, ".copilot");
    const settingsPath = path.join(dir, "settings.json");
    const providersPath = path.join(dir, "providers.json");
    await writeJson(settingsPath, { model: "own/model", theme: "dark" });
    await writeJson(providersPath, {
      providers: [{ name: "own", type: "openai", baseUrl: "https://example.test", apiKey: "k" }],
      models: [{ id: "model", provider: "own" }],
      other: true,
    });
    const target = copilotDriver;

    const undo = await target.connect(environment(), "model-one", undefined);
    const settings = await readJson(settingsPath);
    expect(settings.model).toBe("neolix/model-one");
    expect(settings.theme).toBe("dark");
    const providers = await readJson(providersPath);
    expect(providers.other).toBe(true);
    expect((providers.providers as Record<string, unknown>[])[0]).toMatchObject({
      name: "own",
    });
    expect((providers.providers as Record<string, unknown>[])[1]).toMatchObject({
      name: "neolix",
      type: "openai",
      baseUrl: `${BASE_URL}/v1`,
      apiKey: API_KEY,
    });
    expect((providers.models as Record<string, unknown>[])[0]).toMatchObject({
      id: "model",
      provider: "own",
    });
    expect((providers.models as Record<string, unknown>[])[1]).toMatchObject({
      id: "model-one",
      provider: "neolix",
      maxContextWindowTokens: 200000,
      maxOutputTokens: 64000,
      maxPromptTokens: 136000,
    });
    expect(await target.read(environment())).toEqual({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(environment(), undo);
    expect(await readJson(settingsPath)).toEqual({ model: "own/model", theme: "dark" });
    expect(await readJson(providersPath)).toEqual({
      providers: [{ name: "own", type: "openai", baseUrl: "https://example.test", apiKey: "k" }],
      models: [{ id: "model", provider: "own" }],
      other: true,
    });
  });

  it("follows COPILOT_HOME and COPILOT_PROVIDERS_CONFIG", async () => {
    const moved = path.join(home, "copilot-elsewhere");
    const providersPath = path.join(home, "providers-elsewhere.json");
    const scoped = environment({
      env: {
        PATH: "",
        COPILOT_HOME: moved,
        COPILOT_PROVIDERS_CONFIG: providersPath,
      },
    });
    await copilotDriver.connect(scoped, "model-one", undefined);
    expect(await readJson(path.join(moved, "settings.json"))).toMatchObject({
      model: "neolix/model-one",
    });
    expect(await readJson(providersPath)).toMatchObject({ providers: [{ name: "neolix" }] });
  });

  it("reads the version Copilot reports", async () => {
    const version = await copilotDriver.version?.(
      environment({
        run: async () => "GitHub Copilot CLI 1.0.17\n",
      }),
    );
    expect(version).toBe("1.0.17");
  });

  it("reads the model's effort levels from the gateway, myna's fallback otherwise", async () => {
    const dir = path.join(home, ".copilot");
    await writeJson(path.join(dir, "settings.json"), {
      model: "neolix/copilot/model-one",
      effortLevel: "high",
    });
    const known = await copilotDriver.settings?.(
      environment({
        config: GatewayConfigSchema.parse({
          modelEfforts: { "copilot/model-one": ["low", "high"] },
        }),
      }),
    );
    expect(known).toEqual([
      { key: "effort", label: "effort", value: "high", options: ["low", "high"] },
    ]);
    const fallback = await copilotDriver.settings?.(environment());
    expect(fallback?.[0]?.options).toEqual(["low", "medium", "high", "xhigh"]);

    await copilotDriver.setSetting?.(environment(), "effort", "");
    expect(await readJson(path.join(dir, "settings.json"))).not.toHaveProperty("effortLevel");
    await copilotDriver.setSetting?.(environment(), "effort", "medium");
    expect(await readJson(path.join(dir, "settings.json"))).toMatchObject({
      effortLevel: "medium",
    });
  });

  it("reads Copilot's live /models with the account token, and caches it", async () => {
    const dir = path.join(home, ".copilot");
    await writeJson(path.join(dir, "settings.json"), { model: "neolix/copilot/model-one" });
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const scoped = environment({
      copilotModels: async () => ({
        token: "session-token",
        apiBase: "https://api.githubcopilot.com",
      }),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "copilot/model-one",
                capabilities: { supports: { reasoning_effort: ["low", "high"] } },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const settings = await copilotDriver.settings?.(scoped);
    expect(settings?.[0]?.options).toEqual(["low", "high"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.githubcopilot.com/models");
    expect(calls[0]?.headers.authorization).toBe("Bearer session-token");
    // The list stands as myna's does, so a second read asks nothing.
    await copilotDriver.settings?.(scoped);
    expect(calls).toHaveLength(1);
  });

  it("falls back to myna's levels when the live ask fails", async () => {
    const dir = path.join(home, ".copilot");
    await writeJson(path.join(dir, "settings.json"), { model: "neolix/copilot/model-one" });
    const scoped = environment({
      copilotModels: async () => ({
        token: "session-token",
        apiBase: "https://api.githubcopilot.com",
      }),
      fetch: (async () => new Response("no", { status: 500 })) as typeof fetch,
    });
    const settings = await copilotDriver.settings?.(scoped);
    expect(settings?.[0]?.options).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not take VS Code's copilot launcher for the CLI", async () => {
    const install = path.join(home, "Microsoft VS Code");
    await fs.mkdir(path.join(install, "resources", "app"), { recursive: true });
    await fs.writeFile(
      path.join(install, "resources", "app", "product.json"),
      '{"nameShort":"Visual Studio Code"}\n',
      "utf8",
    );
    const bin = path.join(install, "bin", "copilot-shim");
    await fs.mkdir(bin, { recursive: true });
    await fs.writeFile(path.join(bin, "copilot"), "vscode-copilot-launcher\n", "utf8");
    await fs.chmod(path.join(bin, "copilot"), 0o755);
    const scoped = environment({
      env: { PATH: bin },
      run: async () => "1.0.17\n",
    });
    expect(await copilotDriver.version?.(scoped)).toBeNull();
    await expect(copilotDriver.connect(scoped, "model-one", undefined)).rejects.toThrow(
      "VS Code's copilot launcher is not the Copilot CLI",
    );
  });
});
