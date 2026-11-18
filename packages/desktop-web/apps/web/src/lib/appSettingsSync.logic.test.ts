import { describe, expect, it } from "vitest";

import { patchedSettingsSince, toSettingsPatch } from "./appSettingsSync.logic";

describe("patchedSettingsSince", () => {
  const patchedAt = {
    language: "2026-11-02T00:00:00.000Z",
    chatFontSizePx: "2026-11-01T00:00:00.000Z",
  };

  it("adopts only keys written after the app's own last save", () => {
    expect(
      patchedSettingsSince(
        { language: "zh-CN", chatFontSizePx: 15 },
        patchedAt,
        "2026-11-01T12:00:00.000Z",
      ),
    ).toEqual({ language: "zh-CN" });
  });

  it("adopts every patched key when the app never saved", () => {
    expect(
      patchedSettingsSince({ language: "zh-CN", chatFontSizePx: 15 }, patchedAt, null),
    ).toEqual({ language: "zh-CN", chatFontSizePx: 15 });
  });

  it("keeps an unset as null so the caller can fall back to its default", () => {
    expect(
      patchedSettingsSince({ language: null }, { language: "2026-11-02T00:00:00.000Z" }, null),
    ).toEqual({ language: null });
  });

  it("has nothing to adopt without a copy or patch times", () => {
    expect(patchedSettingsSince(null, patchedAt, null)).toEqual({});
    expect(patchedSettingsSince({ language: "zh-CN" }, undefined, null)).toEqual({});
  });

  it("refuses an unparseable local save time", () => {
    expect(patchedSettingsSince({ language: "zh-CN" }, patchedAt, "not-a-date")).toEqual({});
  });
});

describe("toSettingsPatch", () => {
  const defaults = { language: "system", chatFontSizePx: 13 };

  it("keeps known keys and turns null into the local default", () => {
    expect(toSettingsPatch({ language: null, chatFontSizePx: 15 }, defaults)).toEqual({
      language: "system",
      chatFontSizePx: 15,
    });
  });

  it("drops keys this build does not know", () => {
    expect(toSettingsPatch({ futureKey: true }, defaults)).toEqual({});
  });
});
