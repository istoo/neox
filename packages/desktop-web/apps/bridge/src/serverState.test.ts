import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  ServerConfigStreamEvent,
  ServerSettingsView,
} from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { mergeSettings, ServerState } from "./serverState.ts";
import { localProviderSettingsPatch } from "./providerConfig.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-settings-"));
  dirs.push(dir);
  const settingsFile = path.join(dir, "desktop-web", "settings.json");
  const sources = {
    config: async () => ({ providers: [] }) as never,
    baseSettings: async () => DEFAULT_SERVER_SETTINGS_VIEW,
    settingsFile,
    cwd: dir,
    log: () => {},
  };
  return { sources, settingsFile, state: new ServerState(sources) };
}

describe("serverState", () => {
  it("merges nested objects and replaces scalars and arrays", () => {
    expect(
      mergeSettings({ a: { b: 1, c: 2 }, d: [1], e: 1 }, { a: { c: 3 }, d: [2], e: 2 }),
    ).toEqual({
      a: { b: 1, c: 3 },
      d: [2],
      e: 2,
    });
  });

  it("saves a patch, applies it over the base settings, and keeps it across restarts", async () => {
    const { sources, settingsFile, state } = await makeState();
    const seen: unknown[] = [];
    state.subscribeSettings((item) => seen.push(item.settings.enableAssistantStreaming));
    const updated = await state.updateSettings({ enableAssistantStreaming: false });
    expect(updated.enableAssistantStreaming).toBe(false);
    expect(() => Schema.encodeUnknownSync(ServerSettingsView as never)(updated)).not.toThrow();
    expect(seen).toContain(false);
    expect(JSON.parse(await fs.readFile(settingsFile, "utf8"))).toEqual({
      enableAssistantStreaming: false,
    });

    const restarted = new ServerState(sources);
    expect((await restarted.settings()).enableAssistantStreaming).toBe(false);
  });

  it("opens the config stream with a snapshot and reports settings changes on it", async () => {
    const { state } = await makeState();
    const events: ServerConfigStreamEvent[] = [];
    state.subscribeConfig((event) => events.push(event));
    await state.updateSettings({ enableProviderUpdateChecks: false });
    expect(events.map((event) => event.type)).toEqual(["snapshot", "settingsUpdated"]);
  });

  it("writes provider launch config to the daemon and keeps only presentation fields", async () => {
    const { sources, settingsFile } = await makeState();
    const applied: unknown[] = [];
    const providerSources = {
      ...sources,
      applyProviderSettings: async (patch: Record<string, unknown>) => {
        applied.push(patch);
      },
      localSettingsPatch: localProviderSettingsPatch,
    };
    const providerState = new ServerState(providerSources);
    const patch = {
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          displayName: "Work",
          accentColor: "#fff",
          config: { configDir: "/tmp/claude-work", binaryPath: "/opt/claude" },
        },
      },
    };

    await providerState.updateSettings(patch);

    expect(applied).toEqual([patch]);
    expect(JSON.parse(await fs.readFile(settingsFile, "utf8"))).toEqual({
      providerInstances: {
        claude_work: { driver: "claudeAgent", displayName: "Work", accentColor: "#fff" },
      },
    });

    // A stale file that still carries launch fields is reduced on read, so the daemon's
    // copy is what the settings view resolves.
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        providerInstances: {
          claude_work: {
            driver: "claudeAgent",
            displayName: "Work",
            config: { configDir: "/stale" },
          },
        },
      }),
    );
    const restarted = new ServerState(providerSources);
    expect((await restarted.settings()).providerInstances.claude_work).toMatchObject({
      displayName: "Work",
    });
  });

  it("drops a provider account the complete map no longer contains", async () => {
    const { sources, settingsFile } = await makeState();
    const providerSources = {
      ...sources,
      localSettingsPatch: localProviderSettingsPatch,
    };
    const state = new ServerState(providerSources);
    const first = {
      providerInstances: {
        work: { driver: "codex", displayName: "Work" },
        other: { driver: "codex", displayName: "Other" },
      },
    };
    await state.updateSettings(first);
    await state.updateSettings({
      providerInstances: { work: { driver: "codex", displayName: "Work" } },
    });

    const saved = JSON.parse(await fs.readFile(settingsFile, "utf8")) as {
      providerInstances: Record<string, unknown>;
    };
    expect(Object.keys(saved.providerInstances)).toEqual(["work"]);
    expect((await state.settings()).providerInstances).not.toHaveProperty("other");
  });

  it("merges a daemon-derived account back onto its saved underscore id", async () => {
    const { sources } = await makeState();
    const derived = {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providerInstances: {
        "codex-qa-account": {
          driver: "codex",
          environment: [{ name: "QA_VAR", value: "1", sensitive: false }],
        },
      },
    } as unknown as ServerSettingsView;
    const providerSources = {
      ...sources,
      baseSettings: async () => derived,
      localSettingsPatch: localProviderSettingsPatch,
    };
    const state = new ServerState(providerSources);

    await state.updateSettings({
      providerInstances: {
        codex_qa_account: { driver: "codex", displayName: "QA", accentColor: "#2563eb" },
      },
    });
    const settings = await state.settings();

    expect(Object.keys(settings.providerInstances)).toContain("codex_qa_account");
    expect(Object.keys(settings.providerInstances)).not.toContain("codex-qa-account");
    expect(settings.providerInstances.codex_qa_account).toMatchObject({
      driver: "codex",
      displayName: "QA",
      accentColor: "#2563eb",
      environment: [{ name: "QA_VAR", value: "1", sensitive: false }],
    });
  });
});
