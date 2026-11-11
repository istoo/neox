import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH15_AGENT_DRIVERS } from "./drivers-batch15.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch15-home-"));
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
    models: [{ id: "model-one", label: "Model One", contextWindow: 200000, maxOutputTokens: 8192 }],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = BATCH15_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

const airDir = () => path.join(home, "Library", "Application Support", "JetBrains", "Air");

describe("batch 15 external agents", () => {
  it("wires JetBrains Air through OpenCode ACP and restores the reader's settings", async () => {
    const acpFile = path.join(airDir(), "acp.json");
    const original = {
      agent_servers: { Other: { command: "other", args: [] } },
      theme: "dark",
    };
    await writeJson(acpFile, original);
    const target = driver("air");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(acpFile);
    const entry = (wired.agent_servers as Record<string, Record<string, unknown>>).Neolix ?? {};
    const configPath = path.join(airDir(), "neolix-opencode.json");
    expect(entry).toMatchObject({
      command: "opencode",
      args: ["acp"],
      env: { OPENCODE_CONFIG: configPath },
    });
    expect(wired.theme).toBe("dark");

    const openCode = await readJson(configPath);
    expect(openCode).toMatchObject({
      model: "neolix/model-one",
      small_model: "neolix/model-one",
      enabled_providers: ["neolix"],
    });
    const provider = (openCode.provider as Record<string, Record<string, unknown>>).neolix ?? {};
    expect(provider.options).toEqual({ baseURL: `${BASE_URL}/v1`, apiKey: API_KEY });
    expect((provider.models as Record<string, Record<string, unknown>>)["model-one"]).toEqual({
      name: "Model One",
      limit: { context: 200000, output: 8192 },
    });

    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });
    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(acpFile)).toEqual(original);
    await expect(fs.stat(configPath)).rejects.toThrow();
  });

  it("finds Air in a JetBrains IDE from 2026.2 and keeps its entries apart", async () => {
    await fs.mkdir(
      path.join(home, "Library", "Application Support", "JetBrains", "IntelliJIdea2026.2"),
      { recursive: true },
    );
    const ide = driver("air-ide");
    const air = driver("air");
    const connectEnvironment = environment();
    expect(await ide.external?.detect(connectEnvironment)).toBe(true);
    expect(await air.external?.detect(connectEnvironment)).toBe(false);

    const undo = await ide.connect(connectEnvironment, "model-one", undefined);
    const acpFile = path.join(home, ".jetbrains", "acp.json");
    const wired = await readJson(acpFile);
    expect((wired.agent_servers as Record<string, unknown>).Neolix).toBeDefined();
    expect(await readJson(path.join(home, ".jetbrains", "neolix-opencode.json"))).toMatchObject({
      model: "neolix/model-one",
    });
    await ide.disconnect(connectEnvironment, undo);
    await expect(fs.stat(acpFile)).rejects.toThrow();
  });

  it("starts the OpenCode a JetBrains IDE unpacked from the ACP registry", async () => {
    const packed = path.join(
      home,
      "Library",
      "Caches",
      "JetBrains",
      "IntelliJIdea2026.2",
      "acp-agents",
      "opencode",
      "1.19.0",
      "opencode",
    );
    await fs.mkdir(path.dirname(packed), { recursive: true });
    await fs.writeFile(packed, "#!/bin/sh\n", { mode: 0o755 });
    const target = driver("air");
    const connectEnvironment = environment();
    await target.connect(connectEnvironment, "model-one", undefined);
    const acp = await readJson(path.join(airDir(), "acp.json"));
    const entry = (acp.agent_servers as Record<string, Record<string, unknown>>).Neolix ?? {};
    expect(entry.command).toBe(packed);
  });

  it("offers Claude Science a launch line instead of a file to write", async () => {
    const binDir = path.join(home, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, "claude-science"), "#!/bin/sh\n", { mode: 0o755 });
    const target = driver("claude-science");
    const connectEnvironment = environment({ env: { PATH: binDir } });
    expect(await target.external?.detect(connectEnvironment)).toBe(true);
    expect(await target.read(connectEnvironment)).toEqual({
      connected: false,
      model: null,
      baseUrl: null,
    });
    const launch = await target.external?.launch?.(connectEnvironment, null);
    expect(launch).toContain(`CLAUDE_SCIENCE_GATEWAY_URL=${BASE_URL}`);
    expect(launch).toContain("serve --detached");
  });
});
