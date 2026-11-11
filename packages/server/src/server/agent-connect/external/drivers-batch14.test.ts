import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH14_AGENT_DRIVERS } from "./drivers-batch14.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch14-home-"));
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
  const found = BATCH14_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 14 external agents", () => {
  it("points Antigravity's gateway at Neox and restores the reader's", async () => {
    const filePath = path.join(home, ".antigravity", "settings.json");
    const original = {
      gateway: { enabled: false, url: "https://own.example", wireProtocol: "anthropic" },
      models: { defaultModelId: "own-model", list: [{ modelId: "own-model" }] },
      theme: "dark",
    };
    await writeJson(filePath, original);
    const target = driver("antigravity");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(filePath);
    expect(wired.gateway).toEqual({
      enabled: true,
      url: BASE_URL,
      apiKey: API_KEY,
      wireProtocol: "openai",
    });
    expect((wired.models as Record<string, unknown>).defaultModelId).toBe("model-one");
    expect((wired.models as Record<string, unknown>).list).toBeUndefined();
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("lists Lody as detected and gives its import link, without a connect", async () => {
    await fs.mkdir(path.join(home, ".lody"), { recursive: true });
    await fs.writeFile(path.join(home, ".lody", "workspace-catalog.json"), "{}\n", "utf8");
    const target = driver("lody");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);
    expect(target.external?.noConnect).toBe(true);

    const link = target.external?.importLink?.(connectEnvironment) ?? "";
    const data = new URL(link).searchParams.get("data") ?? "";
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as {
      name: string;
      endpoints: { protocol: string; targets: string[] }[];
    };
    expect(link.startsWith("lody://provider/import?v=1&data=")).toBe(true);
    expect(payload.name).toBe("Neox");
    expect(payload.endpoints.map((entry) => entry.protocol)).toEqual([
      "anthropic-messages",
      "openai-responses",
      "openai-chat",
    ]);
    expect(payload.endpoints[2]?.targets).toContain("dsh");
  });
});
