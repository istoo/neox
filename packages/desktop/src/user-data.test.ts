import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveUserDataDir } from "./user-data";

const appData = "/home/user/Library/Application Support";
const appDataDir = () => appData;

describe("user data directory", () => {
  it("uses the Neox directory for packaged installs", () => {
    expect(resolveUserDataDir({ isPackaged: true, devWorktreeName: null, appDataDir })).toBe(
      path.join(appData, "Neox"),
    );
  });

  it("uses the Neox directory for the main dev checkout", () => {
    expect(resolveUserDataDir({ isPackaged: false, devWorktreeName: null, appDataDir })).toBe(
      path.join(appData, "Neox"),
    );
  });

  it("isolates worktrees under Neox-<name>", () => {
    expect(
      resolveUserDataDir({ isPackaged: false, devWorktreeName: "feature-x", appDataDir }),
    ).toBe(path.join(appData, "Neox-feature-x"));
  });

  it("honours an explicit userData override without reading appData", () => {
    expect(
      resolveUserDataDir({
        forcedDir: "/tmp/isolated-user-data",
        isPackaged: true,
        devWorktreeName: null,
        appDataDir: () => {
          throw new Error("appData must not be read when the directory is forced");
        },
      }),
    ).toBe("/tmp/isolated-user-data");
  });
});
