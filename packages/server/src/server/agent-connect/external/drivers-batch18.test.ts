import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH18_AGENT_DRIVERS } from "./drivers-batch18.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch18-home-"));
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
    gatewayImageModels: ["draw/model"],
    models: [
      { id: "model-one", label: "Model One", contextWindow: 200000, images: true },
      { id: "model-two" },
    ],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = BATCH18_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

interface FakeAlma {
  fetch: typeof fetch;
  calls: string[];
  providers: Record<string, unknown>[];
  settings: Record<string, unknown>;
}

/** Alma's local API, as the four routes Neolix uses answer them. */
function fakeAlma(): FakeAlma {
  const state: FakeAlma = {
    providers: [],
    settings: { chat: { defaultModel: "" }, imageGen: { model: "" }, theme: "dark" },
    calls: [],
    fetch: async () => new Response("{}"),
  };
  state.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    state.calls.push(`${method} ${url.pathname}`);
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    const answer = (value: unknown) =>
      new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/settings") {
      if (method === "PUT" && isRecord(body)) state.settings = body;
      return answer(state.settings);
    }
    if (url.pathname === "/api/providers") {
      if (method === "POST" && isRecord(body)) {
        const made = { id: "p1", ...body };
        state.providers.push(made);
        return answer(made);
      }
      return answer(state.providers);
    }
    const match = /^\/api\/providers\/([^/]+)(\/models)?$/.exec(url.pathname);
    if (match !== null) {
      const id = match[1];
      if (method === "DELETE") {
        state.providers = state.providers.filter((entry) => entry.id !== id);
        return answer({});
      }
      if (method === "PUT" && match[2] === undefined && isRecord(body)) {
        state.providers = state.providers.map((entry) =>
          entry.id === id ? { ...entry, ...body } : entry,
        );
        return answer({});
      }
      return answer({});
    }
    return new Response("not found", { status: 404 });
  };
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("batch 18 external agents", () => {
  it("wires Alma's provider and default model through its own API", async () => {
    await fs.mkdir(path.join(home, "Library", "Application Support", "alma"), {
      recursive: true,
    });
    const alma = fakeAlma();
    const target = driver("alma");
    const connectEnvironment = environment({ fetch: alma.fetch });
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    await target.connect(connectEnvironment, "model-one", undefined);
    const provider = alma.providers[0] ?? {};
    expect(provider).toMatchObject({
      id: "p1",
      name: "Neox",
      type: "openai",
      baseURL: `${BASE_URL}/v1`,
      enabled: true,
    });
    expect((alma.settings.chat as Record<string, unknown>).defaultModel).toBe("p1:model-one");
    expect((alma.settings.imageGen as Record<string, unknown>).model).toBe("p1:draw/model");
    expect(alma.calls).toContain("PUT /api/providers/p1/models");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment);
    expect(alma.providers).toHaveLength(0);
    expect((alma.settings.chat as Record<string, unknown>).defaultModel).toBe("");
    expect((alma.settings.imageGen as Record<string, unknown>).model).toBe("");
  });

  it("shows Aside's four model roles as fields of its one row", async () => {
    const dir = path.join(home, ".aside", "u", "0");
    await writeJson(path.join(dir, "models.json"), { providers: {} });
    await writeJson(path.join(dir, "settings.json"), {
      defaultModel: { provider: "native", modelId: "own" },
      modelCategories: { fast: { provider: "native", modelId: "own-fast" } },
    });
    const target = driver("aside");
    expect(target.external?.variants).toBeUndefined();
    expect(await target.external?.fields?.(environment())).toEqual([
      { id: "fast", label: "Fast", model: null },
      { id: "standard", label: "Standard", model: null },
      { id: "deep", label: "Deep", model: null },
      { id: "visual", label: "Visual", model: null },
    ]);

    // The row's own connect writes the provider block and no selection.
    const base = await target.connect(environment(), "model-two", undefined);
    const settings = await readJson(path.join(dir, "settings.json"));
    expect(settings.defaultModel).toEqual({ provider: "native", modelId: "own" });
    expect(await target.read(environment())).toMatchObject({ connected: false, model: null });

    const scoped = environment({ variant: "fast" });
    const undo = await target.connect(scoped, "model-two", undefined);
    const picked = await readJson(path.join(dir, "settings.json"));
    expect((picked.modelCategories as Record<string, unknown>).fast).toEqual({
      provider: "neolix",
      modelId: "model-two",
    });
    expect(await target.read(scoped)).toMatchObject({ connected: true, model: "model-two" });
    expect((await target.external?.fields?.(environment()))?.map((field) => field.model)).toEqual([
      "model-two",
      null,
      null,
      null,
    ]);

    await target.disconnect(scoped, undo);
    const restored = await readJson(path.join(dir, "settings.json"));
    expect((restored.modelCategories as Record<string, unknown>).fast).toEqual({
      provider: "native",
      modelId: "own-fast",
    });
    await target.disconnect(environment(), base);
    expect((await readJson(path.join(dir, "models.json"))).providers).toEqual({});
  });

  it("writes Aside's provider beside its account and puts its model back", async () => {
    const dir = path.join(home, ".aside", "u", "1");
    const settingsPath = path.join(dir, "settings.json");
    const modelsPath = path.join(dir, "models.json");
    await writeJson(path.join(home, ".aside", "accounts.json"), {
      currentAccountId: 1,
      accounts: [{ id: 1, email: "reader@example.com" }],
    });
    const originalSettings = {
      theme: "dark",
      defaultModel: { provider: "native", modelId: "own-model" },
      modelCategories: { fast: { provider: "native", modelId: "own-fast" } },
    };
    const originalModels = { providers: { native: { name: "Native" } } };
    await writeJson(settingsPath, originalSettings);
    await writeJson(modelsPath, originalModels);
    const target = driver("aside");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    // The row's connect adds the provider and leaves every selection alone.
    expect(await readJson(settingsPath)).toEqual(originalSettings);
    const models = await readJson(modelsPath);
    const provider = (models.providers as Record<string, Record<string, unknown>>).neolix ?? {};
    expect(provider).toMatchObject({
      name: "Neox",
      baseUrl: `${BASE_URL}/v1`,
      api: "openai-completions",
      compat: { sendSessionAffinityHeaders: true },
    });
    expect((provider.models as Record<string, unknown>[])[0]).toMatchObject({
      id: "model-one",
      input: ["text", "image"],
    });
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: false,
      model: null,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(settingsPath)).toEqual(originalSettings);
    expect(await readJson(modelsPath)).toEqual(originalModels);
  });

  it("applies Aside's selection in the running app, and stages it when it isn't", async () => {
    const dir = path.join(home, ".aside", "u", "0");
    await writeJson(path.join(dir, "models.json"), { providers: {} });
    await writeJson(path.join(dir, "settings.json"), {
      modelCategories: { fast: { provider: "native", modelId: "own-fast" } },
    });
    const target = driver("aside");
    const calls: string[][] = [];
    const live = environment({
      variant: "fast",
      run: async (command, args) => {
        calls.push([command, ...args]);
        return "NEOLIX_ASIDE_OK\n";
      },
    });
    const undo = await target.connect(live, "model-one", undefined);
    const set = calls[0] ?? [];
    expect(set[0]).toBe("aside");
    expect(set.slice(1, 4)).toEqual(["repl", "--account", "u0"]);
    expect(set.at(-1)).toContain('"provider":"neolix"');
    expect(set.at(-1)).toContain("NEOLIX_ASIDE_OK");

    calls.length = 0;
    await target.disconnect(live, undo);
    expect(calls[0]?.at(-1)).toContain('"modelId":"own-fast"');
    expect(calls[0]?.at(-1)).toContain("NEOLIX_ASIDE_OK");

    // No answer from Aside: the file write is the change it reads at start.
    const staged = environment({
      variant: "fast",
      run: async () => {
        throw new Error("aside is not running");
      },
    });
    const stagedUndo = await target.connect(staged, "model-one", undefined);
    expect(await target.read(staged)).toMatchObject({ connected: true, model: "model-one" });
    await target.disconnect(staged, stagedUndo);
  });
});
