import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveCliInstallSourcePath, resolveCliShimPath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Neolix.app/Contents/MacOS/Neolix",
        shimPath: "/Applications/Neolix.app/Contents/Resources/bin/neolix",
      }),
    ).toBe("/Applications/Neolix.app/Contents/Resources/bin/neolix");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_neolix123/neolix",
        shimPath: "/tmp/.mount_neolix123/resources/bin/neolix",
        appImagePath: "/home/user/Applications/Neolix.AppImage",
      }),
    ).toBe("/home/user/Applications/Neolix.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Neolix/Neolix",
        shimPath: "/opt/Neolix/resources/bin/neolix",
      }),
    ).toBe("/opt/Neolix/resources/bin/neolix");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Neolix\\Neolix.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Neolix\\resources\\bin\\neolix.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Neolix\\resources\\bin\\neolix.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Neolix/neolix",
        shimPath: "/opt/Neolix/resources/bin/neolix",
      }),
    ).toBe("/opt/Neolix/resources/bin/neolix");
  });
});

describe("CLI executable selection", () => {
  const resolveWorkspaceCli = () =>
    createRequire(import.meta.url).resolve("@neolix/cli/bin/neolix");

  it("uses the workspace CLI for an unpackaged Electron launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/nix/store/electron/bin/electron",
        resolveWorkspaceCli,
      }),
    ).toBe(resolveWorkspaceCli());
  });

  it("uses the application shim for a packaged launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Neolix/neolix",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Neolix", "resources", "bin", "neolix"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Neolix.app/Contents/MacOS/Neolix",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Neolix.app", "Contents", "Resources", "bin", "neolix"));
  });
});
