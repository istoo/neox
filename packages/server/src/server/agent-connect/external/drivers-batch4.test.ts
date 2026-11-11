import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH4_AGENT_DRIVERS } from "./drivers-batch4.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch4-home-"));
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
  const found = BATCH4_AGENT_DRIVERS.find((entry) => entry.provider === provider);
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

describe("batch 4 external agents", () => {
  it("adds Raycast's provider entry and takes only it out", async () => {
    const filePath = path.join(home, ".config", "raycast", "ai", "providers.yaml");
    const original =
      "providers:\n  - id: other\n    name: Other\n    base_url: https://other/v1\ntools:\n  enabled: true\n";
    await write(filePath, original);
    const target = driver("raycast");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await fs.readFile(filePath, "utf8");
    expect(wired).toContain("id: neolix");
    expect(wired).toContain(`base_url: ${BASE_URL}/v1`);
    expect(wired).toContain("id: other");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    const restored = await fs.readFile(filePath, "utf8");
    expect(restored).not.toContain("id: neolix");
    expect(restored).toContain("id: other");
  });

  it("wires MiMo Code through its OpenCode-shaped config", async () => {
    const filePath = path.join(home, ".config", "mimocode", "mimocode.json");
    const original = { provider: { other: { npm: "x" } }, model: "other/m" };
    await writeJson(filePath, original);
    const target = driver("mimocode");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readJson(filePath);
    expect(wired.model).toBe("neolix/model-one");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
    });
    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("adds OpenClaw's provider and model and restores the file", async () => {
    const filePath = path.join(home, ".openclaw", "openclaw.json");
    const original = {
      models: { providers: { other: { baseUrl: "https://other/v1" } } },
      agents: { defaults: { model: "other/x" } },
    };
    await writeJson(filePath, original);
    const target = driver("openclaw");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-two", undefined);
    const wired = await readJson(filePath);
    expect(
      ((wired.models as Record<string, unknown>).providers as Record<string, unknown>).neolix,
    ).toBeDefined();
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-two",
      baseUrl: BASE_URL,
    });
    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(filePath)).toEqual(original);
  });

  it("wires Claude Desktop's 3p deployment and restores every file", async () => {
    const base = path.join(home, "Library", "Application Support");
    const claude = path.join(base, "Claude", "claude_desktop_config.json");
    const threePConfig = path.join(base, "Claude-3p", "claude_desktop_config.json");
    await writeJson(claude, { existing: true });
    await writeJson(threePConfig, { existing: true });
    const target = driver("claude-desktop");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, null, undefined);
    expect(await readJson(claude)).toMatchObject({ deploymentMode: "3p", existing: true });
    const meta = await readJson(path.join(base, "Claude-3p", "configLibrary", "_meta.json"));
    expect(meta.appliedId).toBe("00000000-0000-4000-8000-706173656f");
    const profile = await readJson(
      path.join(base, "Claude-3p", "configLibrary", "00000000-0000-4000-8000-706173656f.json"),
    );
    expect(profile.inferenceGatewayBaseUrl).toBe(BASE_URL);
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: true });

    await target.disconnect(connectEnvironment, undo);
    expect(await readJson(claude)).toEqual({ existing: true });
    expect(await readJson(threePConfig)).toEqual({ existing: true });
    expect(
      (await readJson(path.join(base, "Claude-3p", "configLibrary", "_meta.json"))).appliedId,
    ).toBeUndefined();
  });

  it("finds an MSIX Claude Desktop's package folders on Windows", async () => {
    const local = path.join(home, "AppData", "Local");
    const roaming = path.join(home, "AppData", "Roaming");
    const pkg = path.join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache");
    await writeJson(path.join(roaming, "Claude", "claude_desktop_config.json"), { existing: true });
    await writeJson(path.join(pkg, "Roaming", "Claude", "claude_desktop_config.json"), {
      existing: true,
    });
    const target = driver("claude-desktop");
    const connectEnvironment = environment({
      platform: "win32",
      env: { PATH: "", APPDATA: roaming, LOCALAPPDATA: local },
    });
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    expect(
      await readJson(path.join(roaming, "Claude", "claude_desktop_config.json")),
    ).toMatchObject({ deploymentMode: "3p", existing: true });
    expect(
      await readJson(path.join(pkg, "Roaming", "Claude", "claude_desktop_config.json")),
    ).toMatchObject({ deploymentMode: "3p", existing: true });
    expect(
      await readJson(path.join(pkg, "Local", "Claude-3p", "configLibrary", "_meta.json")),
    ).toMatchObject({ appliedId: "00000000-0000-4000-8000-706173656f" });
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: true });

    await target.disconnect(connectEnvironment, undo);
    expect(
      await readJson(path.join(pkg, "Roaming", "Claude", "claude_desktop_config.json")),
    ).toEqual({ existing: true });
  });
});
