import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  defaultUiBaseFontSize,
  loadAppSettingsFromStorage,
  saveAppSettings,
} from "@/hooks/use-settings/storage";
import { createFakeDesktopBridge, createInMemoryKeyValueStorage } from "@/hooks/use-settings/fakes";
import { APP_SETTINGS_UPDATED_AT_KEY } from "@/hooks/use-settings/keys";
import { patchedSettingsSince } from "./app-settings-patches";

describe("settings the CLI changed while the app was closed", () => {
  it("adopts a theme the CLI wrote after the app last saved", () => {
    // The app last wrote at 10:00 and was closed; `neolix settings set theme
    // midnight` patched the daemon's copy at 10:05.
    const adopted = patchedSettingsSince(
      { theme: "midnight", language: "en" },
      { theme: "2026-11-06T10:05:00.000Z" },
      "2026-11-06T10:00:00.000Z",
    );
    expect(adopted).toEqual({ theme: "midnight" });
  });

  it("keeps a key the app wrote after the patch", () => {
    const adopted = patchedSettingsSince(
      { theme: "midnight" },
      { theme: "2026-11-06T10:05:00.000Z" },
      "2026-11-06T10:07:00.000Z",
    );
    expect(adopted).toEqual({});
  });

  it("adopts an unset as null, so the app falls back to its platform default", () => {
    // `neolix settings reset uiBaseFontSize` dropped the key from the copy.
    const adopted = patchedSettingsSince(
      { language: "en" },
      { uiBaseFontSize: "2026-11-06T10:05:00.000Z" },
      "2026-11-06T10:00:00.000Z",
    );
    expect(adopted).toEqual({ uiBaseFontSize: null });
  });

  it("adopts every patch when the app never wrote settings", () => {
    const adopted = patchedSettingsSince(
      { theme: "midnight" },
      { theme: "2026-11-06T10:05:00.000Z" },
      null,
    );
    expect(adopted).toEqual({ theme: "midnight" });
  });

  it("has nothing to adopt without a copy or patch times", () => {
    expect(patchedSettingsSince(null, { theme: "2026-11-06T10:05:00.000Z" }, null)).toEqual({});
    expect(patchedSettingsSince({ theme: "midnight" }, undefined, null)).toEqual({});
  });
});

describe("starting the app after something outside it changed a setting", () => {
  async function startAfterPatch(copy: Record<string, unknown>, patchedAt: Record<string, string>) {
    const storage = createInMemoryKeyValueStorage();
    const deps = { storage, desktop: createFakeDesktopBridge() };
    const queryClient = new QueryClient();
    await saveAppSettings({ queryClient, deps, updates: { theme: "auto" } });
    // The app was closed since this write; the CLI (or a sync pull, or a
    // restore) wrote the daemon's copy later.
    await storage.setItem(APP_SETTINGS_UPDATED_AT_KEY, "2026-11-06T10:00:00.000Z");
    const localUpdatedAt = await storage.getItem(APP_SETTINGS_UPDATED_AT_KEY);
    const adopted = patchedSettingsSince(copy, patchedAt, localUpdatedAt);
    if (Object.keys(adopted).length > 0) {
      await saveAppSettings({ queryClient, deps, updates: adopted as never });
    }
    return loadAppSettingsFromStorage(deps);
  }

  it("has the theme the CLI wrote while the app was closed", async () => {
    const settings = await startAfterPatch(
      { theme: "midnight" },
      { theme: "2026-11-06T10:05:00.000Z" },
    );
    expect(settings.theme).toBe("midnight");
  });

  it("has the theme a sync pulled in while the app was closed", async () => {
    // sync's apply marks every key it wrote with the daemon's clock, the same
    // way a CLI patch does.
    const settings = await startAfterPatch(
      { theme: "claude" },
      { theme: "2026-11-06T10:05:00.000Z" },
    );
    expect(settings.theme).toBe("claude");
  });

  it("falls back to the default when a sync dropped a key while the app was closed", async () => {
    // The copy no longer has `language`; the daemon marks the removal as an
    // unset, so the app must not keep its own value.
    const settings = await startAfterPatch({}, { language: "2026-11-06T10:05:00.000Z" });
    expect(settings.language).toBe("system");
  });

  it("falls back to this platform's font size after a CLI reset", async () => {
    const settings = await startAfterPatch({}, { uiBaseFontSize: "2026-11-06T10:05:00.000Z" });
    expect(settings.uiBaseFontSize).toBe(defaultUiBaseFontSize(false));
  });
});
