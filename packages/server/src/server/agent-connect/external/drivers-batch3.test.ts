import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH3_AGENT_DRIVERS } from "./drivers-batch3.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch3-home-"));
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
  const found = BATCH3_AGENT_DRIVERS.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no driver for ${provider}`);
  return found;
}

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
}

async function read(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await read(filePath)) as Record<string, unknown>;
}

describe("Kiro Crew", () => {
  it("picks a connected harness and puts the two keys back", async () => {
    const configPath = path.join(home, ".kiro", "crew", "config.json");
    const original = { agent: { acp_backend: "kas" }, other: { keep: true } };
    await writeJson(configPath, original);
    const target = driver("kirocrew");
    const connectEnvironment = environment({ connectedAgents: ["claude", "codex"] });

    const undo = await target.connect(connectEnvironment, null, undefined);
    const wired = await readJson(configPath);
    const agent = wired.agent as Record<string, unknown>;
    expect(agent.acp_backend).toBe("codex");
    expect(agent.member_acp_backend).toBe("codex");
    expect(wired.other).toEqual({ keep: true });
    expect(await target.read(connectEnvironment)).toMatchObject({ connected: true });

    await target.disconnect(connectEnvironment, undo);
    await expect(readJson(configPath)).resolves.toEqual(original);
  });

  it("refuses when no harness is connected, and when config.local.json pins one", async () => {
    const configPath = path.join(home, ".kiro", "crew", "config.json");
    await writeJson(configPath, { agent: {} });
    const target = driver("kirocrew");

    await expect(
      target.connect(environment({ connectedAgents: ["zed"] }), null, undefined),
    ).rejects.toThrow("Connect Codex, Claude Code, OpenCode, Pi or Goose");

    await writeJson(path.join(home, ".kiro", "crew", "config.local.json"), {
      agent: { acp_backend: "claude" },
    });
    await expect(
      target.connect(environment({ connectedAgents: ["claude"] }), null, undefined),
    ).rejects.toThrow("config.local.json");
  });
});

describe("Reasonix Studio", () => {
  it("adds one marked providers entry, the env key, and restores the file", async () => {
    const configPath = path.join(home, ".reasonix", "config.toml");
    const original =
      'default_model = "native/one"\n\n[[providers]]\nname = "native"\nkind = "openai"\n';
    await write(configPath, original);
    const target = driver("reasonix");
    const connectEnvironment = environment();

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await read(configPath);
    expect(wired).toContain("# >>> neolix reasonix >>>");
    expect(wired).toContain(`name = "neolix"`);
    expect(wired).toContain(`base_url = "${BASE_URL}/v1"`);
    expect(wired).toContain(`api_key_env = "NEOLIX_REASONIX_API_KEY"`);
    expect(wired).toContain('default_model = "neolix/model-one"');
    expect(wired).toContain('name = "native"');
    expect(await read(path.join(home, ".reasonix", ".env"))).toContain(
      `NEOLIX_REASONIX_API_KEY=${API_KEY}`,
    );
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await read(configPath)).toBe(original);
    expect(await fs.readFile(path.join(home, ".reasonix", ".env"), "utf8")).not.toContain(
      "NEOLIX_REASONIX_API_KEY",
    );
  });

  it("removes only its block when the user edited the file meanwhile", async () => {
    const configPath = path.join(home, ".reasonix", "config.toml");
    const original = 'default_model = "native/one"\n';
    await write(configPath, original);
    const target = driver("reasonix");
    const connectEnvironment = environment();
    const undo = await target.connect(connectEnvironment, "model-two", undefined);

    await fs.appendFile(configPath, '\n[ui]\ntheme = "dark"\n');
    await target.disconnect(connectEnvironment, undo);

    const restored = await read(configPath);
    expect(restored).not.toContain("# >>> neolix reasonix >>>");
    expect(restored).not.toContain('name = "neolix"');
    expect(restored).toContain('default_model = "native/one"');
    expect(restored).toContain("theme");
  });
});
