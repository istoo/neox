import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isReleaseDownloadPackage,
  packagedBy,
  packagedCommand,
  packagedName,
  packagedSentence,
} from "./package-manager";

let root = "";

function write(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

describe("packagedBy", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "neolix-packaged-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads pacman's local database, preferring the neolix package", () => {
    const entry = path.join(root, "var/lib/pacman/local/neolix-bin-1.2.3-1");
    write(path.join(entry, "desc"), "%NAME%\nneolix-bin\n");
    write(path.join(entry, "files"), "%FILES%\nusr/bin/neolix\n");
    write(path.join(root, "var/lib/pacman/local/other-1.0-1/files"), "%FILES%\nusr/bin/neolix\n");

    expect(packagedBy("/usr/bin/neolix", { root, platform: "linux" })).toEqual({
      manager: "pacman",
      package: "neolix-bin",
    });
  });

  it("reads dpkg's file list", () => {
    write(path.join(root, "var/lib/dpkg/info/neolix.list"), "/usr/bin/neolix\n");
    expect(packagedBy("/usr/bin/neolix", { root, platform: "linux" })).toEqual({
      manager: "dpkg",
      package: "neolix",
    });
  });

  it("asks rpm only when its database exists", () => {
    mkdirSync(path.join(root, "var/lib/rpm"), { recursive: true });
    const rpmOwner = () => "neolix";
    expect(packagedBy("/usr/bin/neolix", { root, platform: "linux", rpmOwner })).toEqual({
      manager: "rpm",
      package: "neolix",
    });

    rmSync(path.join(root, "var/lib/rpm"), { recursive: true, force: true });
    expect(packagedBy("/usr/bin/neolix", { root, platform: "linux", rpmOwner })).toBeNull();
  });

  it("recognises Homebrew's Cellar and Nix's store", () => {
    expect(
      packagedBy("/opt/homebrew/Cellar/neolix/1.0/bin/neolix", { platform: "darwin" }),
    ).toEqual({
      manager: "homebrew",
      package: "neolix",
    });
    expect(packagedBy("/nix/store/abc-neolix/bin/neolix", { platform: "linux" })).toEqual({
      manager: "nix",
    });
  });

  it("ignores a binary a package cannot own", () => {
    expect(packagedBy("/usr/local/bin/neolix", { root, platform: "linux" })).toBeNull();
    expect(packagedBy("/Users/me/neolix", { root, platform: "linux" })).toBeNull();
    expect(packagedBy("/usr/bin/neolix", { root, platform: "win32" })).toBeNull();
  });

  it("says who updates it, as myna does", () => {
    expect(packagedName({ manager: "dpkg" })).toBe("apt");
    expect(packagedCommand({ manager: "pacman", package: "neolix-bin" })).toBe("yay -S neolix-bin");
    const sentence = packagedSentence({ manager: "homebrew", package: "neolix" });
    expect(sentence).toContain("Homebrew");
    expect(sentence).toContain("brew upgrade neolix");
  });

  it("treats a .deb or .rpm as a release download, not a repository install", () => {
    expect(isReleaseDownloadPackage({ manager: "dpkg", package: "neox" })).toBe(true);
    expect(isReleaseDownloadPackage({ manager: "rpm" })).toBe(true);
    expect(isReleaseDownloadPackage({ manager: "pacman", package: "neolix-bin" })).toBe(false);
    expect(isReleaseDownloadPackage({ manager: "homebrew" })).toBe(false);
    expect(isReleaseDownloadPackage({ manager: "nix" })).toBe(false);
  });
});
