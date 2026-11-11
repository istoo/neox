import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BATCH17_AGENT_DRIVERS } from "./drivers-batch17.js";
import type { ConnectEnvironment } from "../drivers.js";

const BASE_URL = "http://127.0.0.1:6768";
const API_KEY = "test-gateway-key";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-batch17-home-"));
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
      { id: "model-one", label: "Model One", contextWindow: 200000, maxOutputTokens: 8192 },
      { id: "model-two", images: true },
    ],
    platform: "darwin",
    ...overrides,
  };
}

function driver(provider: string) {
  const found = BATCH17_AGENT_DRIVERS.find((entry) => entry.provider === provider);
  if (!found) throw new Error(`no driver for ${provider}`);
  return found;
}

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

function newMaxDb(): string {
  const dbPath = path.join(home, ".newmax", "newmax.db");
  return dbPath;
}

function writeNewMaxApp(app: string): void {
  const db = new DatabaseSync(newMaxDb(), { create: true });
  try {
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(app);
  } finally {
    db.close();
  }
}

function readNewMaxApp(): string | null {
  const db = new DatabaseSync(newMaxDb(), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

describe("batch 17 external agents", () => {
  it("adds AtomCode's account and model tables and restores the file", async () => {
    const filePath = path.join(home, ".atomcode", "config.toml");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const original = [
      'default_provider = "own/model"',
      'default_model = "own/model"',
      "",
      '[models."own/model"]',
      'account = "own"',
      'model = "own/model"',
      "",
    ].join("\n");
    await fs.writeFile(filePath, original);
    const target = driver("atomcode");
    const connectEnvironment = environment();
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, "model-one", undefined);
    const wired = await readText(filePath);
    expect(wired).toContain('default_model = "neolix/model-one"');
    expect(wired).toContain('[provider_accounts."neolix"]');
    expect(wired).toContain(`base_url = "${BASE_URL}/v1"`);
    expect(wired).toContain('[models."neolix/model-one"]');
    expect(wired).toContain("context_window = 200000");
    expect(wired).toContain("max_tokens = 8192");
    expect(wired).toContain('[models."neolix/model-two"]');
    expect(wired).toContain("supports_vision = true");
    expect(wired).toContain('[models."own/model"]');
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      model: "model-one",
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(await readText(filePath)).toBe(original);
  });

  it("keeps the reasoning effort AtomCode's owner picked for a model", async () => {
    const filePath = path.join(home, ".atomcode", "config.toml");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        'default_model = "neolix/model-one"',
        "",
        '[models."neolix/model-one"]',
        'account = "neolix"',
        'model = "model-one"',
        'reasoning_effort = "high"',
        "",
      ].join("\n"),
    );
    await driver("atomcode").connect(environment(), "model-one", undefined);
    expect(await readText(filePath)).toContain('reasoning_effort = "high"');
  });

  it("adds Neox's provider to NewMax's settings row and restores it", async () => {
    await fs.mkdir(path.join(home, ".newmax"), { recursive: true });
    const original = JSON.stringify({
      providerId: "default",
      model: "default",
      providers: [{ id: "default", name: "NewMax" }],
      providerOrder: ["default"],
      theme: "dark",
    });
    writeNewMaxApp(original);
    const target = driver("newmax");
    const connectEnvironment = environment({ run: async () => "" });
    expect(await target.external?.detect(connectEnvironment)).toBe(true);

    const undo = await target.connect(connectEnvironment, null, undefined);
    const row = JSON.parse(readNewMaxApp() ?? "{}") as {
      providers: { id: string; name: string; models: string[]; modelContextWindows?: unknown }[];
      providerOrder: string[];
      theme: string;
    };
    const entry = row.providers.find((provider) => provider.id === "neolix-gateway");
    expect(entry).toMatchObject({ name: "Neox", apiFormat: "anthropic" });
    expect(entry?.models).toEqual(["model-one", "model-two"]);
    expect(entry?.modelContextWindows).toEqual({ "model-one": 200000 });
    expect(row.providerOrder).toEqual(["default", "neolix-gateway"]);
    expect(row.theme).toBe("dark");
    expect(await target.read(connectEnvironment)).toMatchObject({
      connected: true,
      baseUrl: BASE_URL,
    });

    await target.disconnect(connectEnvironment, undo);
    expect(readNewMaxApp()).toBe(original);
  });

  it("refuses NewMax while it runs, since it would write its own row back", async () => {
    await fs.mkdir(path.join(home, ".newmax"), { recursive: true });
    writeNewMaxApp(JSON.stringify({ providers: [], providerOrder: [] }));
    const target = driver("newmax");
    await expect(
      target.connect(
        environment({ run: async () => "/Applications/NewMax.app/Contents/MacOS/NewMax\n" }),
        null,
        undefined,
      ),
    ).rejects.toThrow("quit NewMax");
  });

  it("says how to make NewMax's database when it is not there yet", async () => {
    const target = driver("newmax");
    await expect(target.connect(environment(), null, undefined)).rejects.toThrow(
      "open NewMax once",
    );
  });
});
