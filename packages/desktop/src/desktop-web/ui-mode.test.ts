import { describe, expect, it } from "vitest";

import {
  coerceDesktopUiMode,
  desktopUiModeState,
  isDesktopUiModeLockedByEnv,
  resolveDesktopUiMode,
} from "./ui-mode.js";

describe("resolveDesktopUiMode", () => {
  it("defaults to the web renderer", () => {
    expect(resolveDesktopUiMode({})).toBe("web");
    expect(resolveDesktopUiMode({ envValue: "  " })).toBe("web");
  });

  it("reads the saved preference", () => {
    expect(resolveDesktopUiMode({ savedMode: "web" })).toBe("web");
    expect(resolveDesktopUiMode({ savedMode: "native" })).toBe("native");
    expect(resolveDesktopUiMode({ envValue: "", savedMode: "native" })).toBe("native");
  });

  it("lets the environment override the saved preference", () => {
    expect(resolveDesktopUiMode({ envValue: "web", savedMode: "native" })).toBe("web");
    expect(resolveDesktopUiMode({ envValue: "native", savedMode: "web" })).toBe("native");
    expect(resolveDesktopUiMode({ envValue: "RN", savedMode: "web" })).toBe("native");
  });

  it("ignores unknown values and keeps the saved preference", () => {
    expect(resolveDesktopUiMode({ envValue: "banana", savedMode: "web" })).toBe("web");
    expect(resolveDesktopUiMode({ envValue: "banana", savedMode: "native" })).toBe("native");
  });
});

describe("desktopUiModeState", () => {
  it("reports the resolved mode and an unlocked control without a pin", () => {
    expect(desktopUiModeState({ savedMode: "native" })).toEqual({
      mode: "native",
      selectable: true,
    });
  });

  it("reports the env-pinned mode as not selectable", () => {
    expect(desktopUiModeState({ envValue: "web", savedMode: "native" })).toEqual({
      mode: "web",
      selectable: false,
    });
  });
});

describe("coerceDesktopUiMode", () => {
  it("accepts only the two renderer ids", () => {
    expect(coerceDesktopUiMode("web")).toBe("web");
    expect(coerceDesktopUiMode("native")).toBe("native");
    expect(coerceDesktopUiMode("RN")).toBeNull();
    expect(coerceDesktopUiMode(true)).toBeNull();
    expect(coerceDesktopUiMode(undefined)).toBeNull();
  });
});

describe("isDesktopUiModeLockedByEnv", () => {
  it("locks only when the variable has content", () => {
    expect(isDesktopUiModeLockedByEnv(undefined)).toBe(false);
    expect(isDesktopUiModeLockedByEnv("   ")).toBe(false);
    expect(isDesktopUiModeLockedByEnv("web")).toBe(true);
  });
});
