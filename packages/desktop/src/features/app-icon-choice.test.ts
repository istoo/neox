import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveChosenAppIconPath } from "./app-icon-choice.js";

const base = {
  isPackaged: false,
  resourcesPath: "/App/Contents/Resources",
  assetsDir: "/repo/packages/desktop/assets",
  exists: () => true,
};

describe("resolveChosenAppIconPath", () => {
  it("leaves the default icon to the bundle", () => {
    expect(resolveChosenAppIconPath({ ...base, name: "default" })).toBeNull();
  });

  it("reads variants from assets in a dev checkout", () => {
    expect(resolveChosenAppIconPath({ ...base, name: "dark" })).toBe(
      path.join("/repo/packages/desktop/assets", "app-icons", "dark.png"),
    );
  });

  it("reads variants from resources once packaged", () => {
    expect(resolveChosenAppIconPath({ ...base, isPackaged: true, name: "icon" })).toBe(
      path.join("/App/Contents/Resources", "app-icons", "icon.png"),
    );
  });

  it("falls back to the bundle icon when the variant file is missing", () => {
    expect(resolveChosenAppIconPath({ ...base, name: "beta", exists: () => false })).toBeNull();
  });
});
