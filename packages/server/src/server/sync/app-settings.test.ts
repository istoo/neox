import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_SETTINGS_FILENAME } from "./parts.js";
import { SyncService } from "./service.js";

let home: string;
let service: SyncService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-sync-app-settings-"));
  service = new SyncService({ neolixHome: home });
});

describe("app settings written from outside the app", () => {
  it("patches one key and records when it happened", async () => {
    await service.saveAppSettings({ theme: "auto", language: "en" });
    await service.patchAppSettings("theme", "midnight");
    await expect(service.appSettings()).resolves.toEqual({ theme: "midnight", language: "en" });
    const times = await service.appSettingsPatchedAt();
    expect(Object.keys(times)).toEqual(["theme"]);
    expect(Number.isNaN(Date.parse(times.theme ?? ""))).toBe(false);
  });

  it("unsets a key with null and still records the time", async () => {
    await service.saveAppSettings({ theme: "auto", language: "en" });
    await service.patchAppSettings("theme", null);
    await expect(service.appSettings()).resolves.toEqual({ language: "en" });
    expect(await service.appSettingsPatchedAt()).toHaveProperty("theme");
  });

  it("starts a copy that doesn't exist yet", async () => {
    await service.patchAppSettings("theme", "midnight");
    await expect(service.appSettings()).resolves.toEqual({ theme: "midnight" });
  });

  it("marks every key a sync pull or restore applied, at one time", async () => {
    // The engine wrote this copy; the app was closed and hasn't seen it.
    await service.saveAppSettings({ theme: "midnight", language: "fr" });
    await service.recordAppSettingsApplied({ theme: "midnight", language: "fr" });
    const times = await service.appSettingsPatchedAt();
    expect(Object.keys(times).sort()).toEqual(["language", "theme"]);
    expect(times.theme).toBe(times.language);
    expect(Number.isNaN(Date.parse(times.theme ?? ""))).toBe(false);
  });

  it("marks a key a sync dropped, so the app unsets it at start", async () => {
    // The app last exported both keys; then a sync pull replaced the copy
    // with one that has no `language`, the engine's applyPart writing it.
    await service.saveAppSettings({ theme: "auto", language: "en" });
    writeFileSync(join(home, APP_SETTINGS_FILENAME), JSON.stringify({ theme: "auto" }));
    await service.recordAppSettingsApplied({ theme: "auto" });
    const times = await service.appSettingsPatchedAt();
    expect(Object.keys(times).sort()).toEqual(["language", "theme"]);
  });

  it("recognizes a key the first sync removes after the startup snapshot", async () => {
    // Daemon start: the copy is there, the keys file is not.
    writeFileSync(
      join(home, APP_SETTINGS_FILENAME),
      JSON.stringify({ theme: "auto", language: "en" }),
    );
    await service.initializeAppSettingsKeys();
    // The engine then writes the pulled copy, without `language`.
    writeFileSync(join(home, APP_SETTINGS_FILENAME), JSON.stringify({ theme: "auto" }));
    await service.recordAppSettingsApplied({ theme: "auto" });
    const times = await service.appSettingsPatchedAt();
    expect(Object.keys(times).sort()).toEqual(["language", "theme"]);
  });

  it("keeps the recorded keys when a later start would see fewer", async () => {
    await service.saveAppSettings({ theme: "auto", language: "en" });
    writeFileSync(join(home, APP_SETTINGS_FILENAME), JSON.stringify({ theme: "auto" }));
    await service.initializeAppSettingsKeys();
    await service.recordAppSettingsApplied({ theme: "auto" });
    expect(await service.appSettingsPatchedAt()).toHaveProperty("language");
  });

  it("initializes nothing when there is no copy yet", async () => {
    await service.initializeAppSettingsKeys();
    await expect(service.appSettingsPatchedAt()).resolves.toEqual({});
  });

  it("ignores a value that isn't a settings object", async () => {
    await service.recordAppSettingsApplied(null);
    await expect(service.appSettingsPatchedAt()).resolves.toEqual({});
  });

  it("reads no patch times before there are any", async () => {
    await expect(service.appSettingsPatchedAt()).resolves.toEqual({});
  });
});
