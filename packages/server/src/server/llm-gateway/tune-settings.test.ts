import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyTune, readTuneSetting, tuneStashed, undoTune } from "./tune-settings.js";

/** A write the user makes beside Apply, triggered on the stash write. */
const tuneWrite = vi.hoisted(() => ({
  around: null as null | {
    stashFile: string;
    settingsFile: string;
    add: Record<string, unknown>;
  },
}));

vi.mock("../atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-file.js")>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      await actual.writeFileAtomic(...args);
      const hook = tuneWrite.around;
      if (hook === null || args[0] !== hook.stashFile) {
        return;
      }
      tuneWrite.around = null;
      const current = JSON.parse(await readFile(hook.settingsFile, "utf8")) as Record<
        string,
        unknown
      >;
      await actual.writeFileAtomic(
        hook.settingsFile,
        `${JSON.stringify({ ...current, ...hook.add }, null, 2)}\n`,
      );
    },
  };
});

const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(files: { claude?: string; codex?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-tune-"));
  homes.push(root);
  const neolixHome = path.join(root, "neolix");
  const claudeDir = path.join(root, "claude");
  const codexDir = path.join(root, "codex");
  const claudeSettings = path.join(claudeDir, "settings.json");
  const codexConfig = path.join(codexDir, "config.toml");
  const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
  if (files.claude !== undefined) {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(claudeSettings, files.claude);
  }
  if (files.codex !== undefined) {
    await mkdir(codexDir, { recursive: true });
    await writeFile(codexConfig, files.codex);
  }
  return { root, neolixHome, claudeSettings, codexConfig, env, homeDir: root };
}

describe("Claude Code's settings", () => {
  it("sets a model's window where it changed, keeping the file's comments", async () => {
    const made = await setup({
      claude: '{\n  // kept\n  "model": "opus"\n}\n',
    });
    const state = await applyTune(
      {
        agent: "claude",
        knob: "compact",
        model: "claude-sonnet-5-5",
        value: "160000",
        neolixHome: made.neolixHome,
      },
      made.env,
      made.homeDir,
    );
    expect(state).toMatchObject({ value: "160000", source: "model", ours: true });
    const text = await readFile(made.claudeSettings, "utf8");
    expect(text).toContain("// kept");
    expect(text).toContain('"autoCompactWindow": 160000');
    expect(await tuneStashed(made.neolixHome, "claude", "compact", "claude-sonnet-5-5")).toBe(true);
  });

  it("keeps a key the user added while Apply was writing", async () => {
    const made = await setup({ claude: '{ "model": "opus" }\n' });
    tuneWrite.around = {
      stashFile: path.join(made.neolixHome, "gateway-tune.json"),
      settingsFile: made.claudeSettings,
      add: { userKept: { important: true } },
    };
    try {
      await applyTune(
        {
          agent: "claude",
          knob: "compact",
          model: "claude-sonnet-5-5",
          value: "160000",
          neolixHome: made.neolixHome,
        },
        made.env,
        made.homeDir,
      );
    } finally {
      tuneWrite.around = null;
    }

    const saved = JSON.parse(await readFile(made.claudeSettings, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved.userKept).toEqual({ important: true });
    expect(saved.modelSettings).toMatchObject({
      "claude-sonnet-5-5": { autoCompactWindow: 160000 },
    });
  });

  it("removes what Apply added, and the empty modelSettings objects with it", async () => {
    const made = await setup({ claude: '{ "model": "opus" }\n' });
    const input = {
      agent: "claude" as const,
      knob: "compact" as const,
      model: "claude-sonnet-5-5",
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "160000" }, made.env, made.homeDir);
    const after = await undoTune(input, made.env, made.homeDir);
    expect(after.value).toBeNull();
    const settings = JSON.parse(await readFile(made.claudeSettings, "utf8")) as Record<
      string,
      unknown
    >;
    expect(settings).toEqual({ model: "opus" });
    expect(await tuneStashed(made.neolixHome, "claude", "compact", "claude-sonnet-5-5")).toBe(
      false,
    );
  });

  it("puts back the value the file had", async () => {
    const made = await setup({
      claude: '{ "modelSettings": { "claude-sonnet-5-5": { "autoCompactWindow": 200000 } } }\n',
    });
    const input = {
      agent: "claude" as const,
      knob: "compact" as const,
      model: "claude-sonnet-5-5",
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "140000" }, made.env, made.homeDir);
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("140000");
    await undoTune(input, made.env, made.homeDir);
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("200000");
  });

  it("leaves a value the user changed after Apply", async () => {
    const made = await setup({ claude: "{}\n" });
    const input = {
      agent: "claude" as const,
      knob: "compact" as const,
      model: "claude-sonnet-5-5",
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "160000" }, made.env, made.homeDir);
    await writeFile(
      made.claudeSettings,
      '{ "modelSettings": { "claude-sonnet-5-5": { "autoCompactWindow": 180000 } } }\n',
    );
    await undoTune(input, made.env, made.homeDir);
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("180000");
  });

  it("refuses to fight an environment variable that comes first", async () => {
    const made = await setup({ claude: "{}\n" });
    await expect(
      applyTune(
        {
          agent: "claude",
          knob: "compact",
          model: "claude-sonnet-5-5",
          value: "160000",
          neolixHome: made.neolixHome,
        },
        { ...made.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "180000" },
        made.homeDir,
      ),
    ).rejects.toThrow(/CLAUDE_CODE_AUTO_COMPACT_WINDOW/);
  });

  it("sets and restores the prompt cache lifetime", async () => {
    const made = await setup({ claude: '{ "promptCacheTtl": "5m" }\n' });
    const input = {
      agent: "claude" as const,
      knob: "cache_ttl" as const,
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "1h" }, made.env, made.homeDir);
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("1h");
    await undoTune(input, made.env, made.homeDir);
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("5m");
  });
});

describe("Codex's config.toml", () => {
  it("sets the top-level window beside the user's tables, and removes it on Undo", async () => {
    const made = await setup({
      codex: 'model = "gpt-5"\n\n[features]\nweb_search = true\n',
    });
    const input = {
      agent: "codex" as const,
      knob: "compact" as const,
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "300000" }, made.env, made.homeDir);
    const text = await readFile(made.codexConfig, "utf8");
    expect(text.startsWith("model_auto_compact_token_limit = 300000\n")).toBe(true);
    expect(text).toContain("[features]\nweb_search = true");
    expect((await readTuneSetting(input, made.env, made.homeDir)).value).toBe("300000");

    await undoTune(input, made.env, made.homeDir);
    const restored = await readFile(made.codexConfig, "utf8");
    expect(restored).not.toContain("model_auto_compact_token_limit");
    expect(restored).toContain("[features]");
  });

  it("puts back a limit the file already had", async () => {
    const made = await setup({ codex: "model_auto_compact_token_limit = 400000\n" });
    const input = {
      agent: "codex" as const,
      knob: "compact" as const,
      neolixHome: made.neolixHome,
    };
    await applyTune({ ...input, value: "250000" }, made.env, made.homeDir);
    await undoTune(input, made.env, made.homeDir);
    expect(await readFile(made.codexConfig, "utf8")).toContain(
      "model_auto_compact_token_limit = 400000",
    );
  });
});
