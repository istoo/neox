import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readPluginWebAssetFile } from "./index.js";

const directories: string[] = [];

async function makePluginDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "neolix-plugin-web-"));
  directories.push(directory);
  await mkdir(path.join(directory, "web"), { recursive: true });
  await writeFile(path.join(directory, "web", "main.html"), "<p>hi</p>");
  await writeFile(path.join(directory, "web", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin web assets", () => {
  it("reads declared html as utf8", async () => {
    const directory = await makePluginDirectory();
    await expect(readPluginWebAssetFile(directory, "web/main.html")).resolves.toEqual({
      path: "web/main.html",
      contentType: "text/html",
      encoding: "utf8",
      content: "<p>hi</p>",
    });
  });

  it("reads binary assets as base64", async () => {
    const directory = await makePluginDirectory();
    const asset = await readPluginWebAssetFile(directory, "web/pixel.png");
    expect(asset.encoding).toBe("base64");
    expect(Buffer.from(asset.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it.each(["../secret.html", "/etc/passwd", "web/../../secret.html", "..\\secret.html"])(
    "rejects escaping paths: %s",
    async (assetPath) => {
      const directory = await makePluginDirectory();
      await expect(readPluginWebAssetFile(directory, assetPath)).rejects.toThrow();
    },
  );

  it("rejects unsupported extensions and missing files", async () => {
    const directory = await makePluginDirectory();
    await writeFile(path.join(directory, "web", "notes.txt"), "hi");
    await expect(readPluginWebAssetFile(directory, "web/notes.txt")).rejects.toThrow(/Unsupported/);
    await expect(readPluginWebAssetFile(directory, "web/missing.html")).rejects.toThrow(/missing/);
  });

  it("refuses a symlink that points outside the package", async () => {
    const directory = await makePluginDirectory();
    const outside = await mkdtemp(path.join(tmpdir(), "neolix-plugin-outside-"));
    directories.push(outside);
    await writeFile(path.join(outside, "secret.html"), "<p>secret</p>");
    await symlink(path.join(outside, "secret.html"), path.join(directory, "web", "linked.html"));
    await expect(readPluginWebAssetFile(directory, "web/linked.html")).rejects.toThrow(
      /escapes its package/,
    );
  });
});
