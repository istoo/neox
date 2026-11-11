import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readImportSources } from "./provider-import.js";

const CLAUDE_TOKEN = "claude-fixture-token";
let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "neolix-import-"));
});

afterEach(() => {
  // The temp tree is the test's own; the OS reclaims it.
});

async function write(relative: string, contents: string): Promise<void> {
  const file = path.join(home, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

async function source(id: string) {
  const sources = await readImportSources(home);
  const found = sources.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`no source ${id}`);
  }
  return found;
}

describe("Claude Code", () => {
  it("reads the relay Claude Code was pointed at", async () => {
    await write(
      ".claude/settings.json",
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://relay.example.com/anthropic",
          ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
          ANTHROPIC_MODEL: "claude-sonnet-5-5",
        },
      }),
    );
    const claude = await source("claude-code");
    expect(claude.found).toBe(true);
    expect(claude.providers).toMatchObject([
      {
        source: "Claude Code",
        ref: "settings",
        name: "relay.example.com",
        protocol: "anthropic",
        baseUrl: "https://relay.example.com/anthropic",
        models: ["claude-sonnet-5-5"],
      },
    ]);
    expect((claude.providers[0]?.apiKey ?? "").length).toBeGreaterThan(0);
  });

  it("offers nothing for Anthropic's own endpoint", async () => {
    await write(".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_MODEL: "x" } }));
    expect((await source("claude-code")).providers).toEqual([]);
  });

  it("reports an app that is not installed", async () => {
    const codex = await source("codex");
    expect(codex.found).toBe(false);
    expect(codex.providers).toEqual([]);
  });
});

describe("Codex", () => {
  it("reads the model provider and its key", async () => {
    await write(
      ".codex/config.toml",
      [
        'model = "gpt-5.5"',
        'model_provider = "relay"',
        "",
        "[model_providers.relay]",
        'base_url = "https://relay.example.com/v1"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
    );
    await write(".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "codex-key" }));
    const codex = await source("codex");
    expect(codex.providers).toEqual([
      {
        source: "Codex",
        ref: "relay",
        name: "relay",
        protocol: "openai-responses",
        baseUrl: "https://relay.example.com/v1",
        apiKey: "codex-key",
        models: ["gpt-5.5"],
      },
    ]);
  });

  it("falls back to OpenAI's own base for a key alone", async () => {
    await write(".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: "codex-key" }));
    await write(".codex/config.toml", 'model = "gpt-5.5"\n');
    const [provider] = (await source("codex")).providers;
    expect(provider?.baseUrl).toBe("https://api.openai.com/v1");
    expect(provider?.protocol).toBe("openai-responses");
  });
});

describe("CC Switch", () => {
  it("reads the providers its config.json holds", async () => {
    await write(
      ".cc-switch/config.json",
      JSON.stringify({
        claude: {
          providers: {
            work: {
              name: "Work relay",
              settingsConfig: {
                env: {
                  ANTHROPIC_BASE_URL: "https://work.example.com/anthropic",
                  ANTHROPIC_AUTH_TOKEN: CLAUDE_TOKEN,
                },
              },
            },
          },
        },
        codex: {
          providers: {
            home: {
              name: "Home relay",
              settingsConfig: {
                baseUrl: "https://home.example.com/v1",
                apiKey: "home-key",
                models: ["gpt-a", { id: "gpt-b" }],
              },
            },
          },
        },
      }),
    );
    const ccSwitch = await source("cc-switch");
    expect(ccSwitch.providers.map((provider) => provider.name)).toEqual([
      "Work relay",
      "Home relay",
    ]);
    expect(ccSwitch.providers[1]).toMatchObject({
      protocol: "openai",
      baseUrl: "https://home.example.com/v1",
      models: ["gpt-a", "gpt-b"],
    });
  });
});

/** Creates a SQLite database at home/relative with the given statements. */
async function sqlite(relative: string, statements: string[]): Promise<void> {
  const file = path.join(home, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    for (const statement of statements) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

/** Where Alma keeps its database on this platform, under the test's home. */
function almaDatabase(base: string): string {
  if (process.platform === "darwin") {
    return path.join(base, "Library", "Application Support", "alma", "chat_threads.db");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA ?? path.join(base, "AppData", "Roaming"),
      "alma",
      "chat_threads.db",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(base, ".config"),
    "alma",
    "chat_threads.db",
  );
}

describe("CC Switch's database", () => {
  it("reads the providers its providers table holds", async () => {
    await sqlite(".cc-switch/cc-switch.db", [
      "CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT, name TEXT, settings_config TEXT, sort_index INTEGER, created_at TEXT)",
      `INSERT INTO providers VALUES ('a', 'claude', 'Work relay', '{"env":{"ANTHROPIC_BASE_URL":"https://work.example.com/anthropic","ANTHROPIC_AUTH_TOKEN":"tok"}}', 0, '2026-01-01')`,
      `INSERT INTO providers VALUES ('b', 'codex', 'Home relay', '{"baseUrl":"https://home.example.com/v1","apiKey":"home-key"}', 1, '2026-01-02')`,
    ]);
    const ccSwitch = await source("cc-switch");
    expect(ccSwitch.path.endsWith(".db")).toBe(true);
    expect(ccSwitch.providers.map((provider) => provider.name)).toEqual([
      "Work relay",
      "Home relay",
    ]);
    expect(ccSwitch.providers[1]).toMatchObject({
      protocol: "openai",
      baseUrl: "https://home.example.com/v1",
      apiKey: "home-key",
    });
  });
});

describe("Alma", () => {
  it("reads its providers, fills a preset's URL and skips sign-ins", async () => {
    const relative = path.relative(home, almaDatabase(home));
    await sqlite(relative, [
      "CREATE TABLE providers (id TEXT, name TEXT, type TEXT, api_key TEXT, models TEXT, base_url TEXT, enabled INTEGER, api_format TEXT, is_response_api INTEGER, custom_headers TEXT, created_at TEXT)",
      `INSERT INTO providers VALUES ('1', 'My OpenAI', 'openai', 'alma-key', '["gpt-5", {"id": "gpt-5-mini"}]', NULL, 1, '', 0, '', 't1')`,
      `INSERT INTO providers VALUES ('2', 'My Claude', 'anthropic', 'claude-key', '[]', 'https://relay.example.com/anthropic', 1, 'anthropic', 0, '', 't2')`,
      `INSERT INTO providers VALUES ('3', 'Cursor', 'cursor', '', NULL, NULL, 1, '', 0, '', 't3')`,
      `INSERT INTO providers VALUES ('4', 'Off relay', 'openai', 'off-key', '[]', 'https://off.example.com/v1', 0, 'openai', 0, '{"X-Tenant":"acme"}', 't4')`,
    ]);
    const alma = await source("alma");
    expect(alma.found).toBe(true);
    expect(alma.providers.map((provider) => provider.ref)).toEqual(["1", "2", "4"]);
    expect(alma.providers[0]).toMatchObject({
      name: "My OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "alma-key",
      models: ["gpt-5", "gpt-5-mini"],
    });
    expect(alma.providers[1]).toMatchObject({
      protocol: "anthropic",
      baseUrl: "https://relay.example.com/anthropic",
    });
    expect(alma.providers[2]).toMatchObject({
      enabled: false,
      headers: { "X-Tenant": "acme" },
    });
  });
});

describe("OpenCode", () => {
  it("fills a preset's URL for each key, and leaves sign-ins out", async () => {
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(home, "xdg-data");
    try {
      await write(
        "xdg-data/opencode/auth.json",
        JSON.stringify({
          deepseek: { type: "api", key: "deepseek-key" },
          anthropic: { type: "oauth", access: "x" },
          "some-relay": { type: "api", key: "relay-key" },
        }),
      );
      const openCode = await source("opencode");
      expect(openCode.providers).toEqual([
        {
          source: "OpenCode",
          ref: "deepseek",
          name: "DeepSeek",
          protocol: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "deepseek-key",
          models: [],
        },
      ]);
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previous;
      }
    }
  });
});
