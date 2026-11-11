import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { isContainedPath, readProjectRoots, resolveProjectFavicon } from "./favicon.ts";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function writeFixture(filePath: string, contents = "<svg/>"): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

describe("favicon", () => {
  it("finds a project-root favicon", async () => {
    const root = await tempDir("favicon-root-");
    await writeFixture(path.join(root, "favicon.svg"));
    const resolved = await resolveProjectFavicon(root, [root]);
    expect(resolved?.contentType).toBe("image/svg+xml");
    expect(resolved?.path).toBe(await realpath(path.join(root, "favicon.svg")));
  });

  it("prefers the first conventional candidate and supports public/ and app/ folders", async () => {
    const root = await tempDir("favicon-public-");
    await writeFixture(path.join(root, "public", "favicon.png"), "png");
    const resolved = await resolveProjectFavicon(root, [root]);
    expect(resolved?.contentType).toBe("image/png");
    expect(resolved?.path.endsWith(path.join("public", "favicon.png"))).toBe(true);
  });

  it("finds a favicon in a nested web app", async () => {
    const root = await tempDir("favicon-nested-");
    await writeFixture(path.join(root, "apps", "web", "public", "favicon.ico"), "ico");
    const resolved = await resolveProjectFavicon(root, [root]);
    expect(resolved?.contentType).toBe("image/x-icon");
    expect(resolved?.path.endsWith(path.join("apps", "web", "public", "favicon.ico"))).toBe(true);
  });

  it("returns null for a folder outside every registered project root", async () => {
    const root = await tempDir("favicon-root-");
    const outside = await tempDir("favicon-outside-");
    await writeFixture(path.join(outside, "favicon.svg"));
    expect(await resolveProjectFavicon(outside, [root])).toBeNull();
  });

  it("rejects a traversal path even when it resolves into a project", async () => {
    const root = await tempDir("favicon-root-");
    await writeFixture(path.join(root, "favicon.svg"));
    expect(await resolveProjectFavicon(`${root}/sub/../..`, [root])).toBeNull();
  });

  it("rejects a symlinked favicon pointing out of the project", async () => {
    const root = await tempDir("favicon-root-");
    const outside = await tempDir("favicon-outside-");
    const marker = path.join(outside, "marker.svg");
    await writeFixture(marker, "<svg>outside</svg>");
    try {
      await symlink(marker, path.join(root, "favicon.svg"));
    } catch {
      return; // Filesystem without symlink support.
    }
    expect(await resolveProjectFavicon(root, [root])).toBeNull();
  });

  it("skips an oversized candidate and falls through to the next one", async () => {
    const root = await tempDir("favicon-root-");
    await writeFixture(path.join(root, "favicon.svg"), "x".repeat(2 * 1024 * 1024 + 1));
    await writeFixture(path.join(root, "public", "favicon.png"), "png");

    const resolved = await resolveProjectFavicon(root, [root]);
    expect(resolved?.contentType).toBe("image/png");
    expect(resolved?.path.endsWith(path.join("public", "favicon.png"))).toBe(true);
  });

  it("reads roots from the daemon project registry and tolerates a missing one", async () => {
    const home = await tempDir("favicon-home-");
    await mkdir(path.join(home, "projects"), { recursive: true });
    await writeFile(
      path.join(home, "projects", "projects.json"),
      JSON.stringify([{ projectId: "prj_1", rootPath: "/repo" }, { projectId: "prj_2" }]),
    );
    expect(await readProjectRoots(home)).toEqual(["/repo"]);
    expect(await readProjectRoots(path.join(home, "missing"))).toEqual([]);
  });

  it("treats a child path as contained and a sibling as not", () => {
    expect(isContainedPath("/repo", "/repo")).toBe(true);
    expect(isContainedPath("/repo", "/repo/apps/web")).toBe(true);
    expect(isContainedPath("/repo", "/repository")).toBe(false);
    expect(isContainedPath("/repo", "/repo/../outside")).toBe(false);
  });
});
