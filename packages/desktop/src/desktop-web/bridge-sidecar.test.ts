import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveBridgeLaunchPaths } from "./bridge-sidecar.js";

describe("resolveBridgeLaunchPaths", () => {
  it("returns null until the bridge entry and web build exist", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "neolix-bridge-paths-"));
    const desktopDistDir = path.join(repoRoot, "packages", "desktop", "dist");
    await mkdir(desktopDistDir, { recursive: true });

    expect(
      resolveBridgeLaunchPaths({
        isPackaged: false,
        resourcesPath: "",
        desktopDistDir,
        env: {},
      }),
    ).toBeNull();

    const bridgeDir = path.join(repoRoot, "packages", "desktop-web", "apps", "bridge", "src");
    const webDistDir = path.join(repoRoot, "packages", "desktop-web", "apps", "web", "dist");
    await mkdir(bridgeDir, { recursive: true });
    await mkdir(webDistDir, { recursive: true });
    await writeFile(path.join(bridgeDir, "main.ts"), "");
    await writeFile(path.join(webDistDir, "index.html"), "");

    expect(
      resolveBridgeLaunchPaths({
        isPackaged: false,
        resourcesPath: "",
        desktopDistDir,
        env: { NEOLIX_BUN_BINARY: "/opt/bun" },
      }),
    ).toEqual({
      command: "/opt/bun",
      args: [path.join(bridgeDir, "main.ts")],
      cwd: path.dirname(bridgeDir),
      webDistDir,
    });
  });

  it("uses the packaged resources layout", async () => {
    const resourcesPath = await mkdtemp(path.join(tmpdir(), "neolix-bridge-packaged-"));
    const bridgeDir = path.join(resourcesPath, "desktop-web", "bridge");
    const webDistDir = path.join(resourcesPath, "desktop-web", "web");
    await mkdir(bridgeDir, { recursive: true });
    await mkdir(webDistDir, { recursive: true });
    await writeFile(path.join(bridgeDir, "main.js"), "");
    await writeFile(path.join(webDistDir, "index.html"), "");

    expect(
      resolveBridgeLaunchPaths({
        isPackaged: true,
        resourcesPath,
        desktopDistDir: "",
        env: {},
      }),
    ).toEqual({
      command: process.execPath,
      args: [path.join(bridgeDir, "main.js")],
      cwd: bridgeDir,
      webDistDir,
      electronRunAsNode: true,
    });
  });
});
