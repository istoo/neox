import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeWorkDirName, ensureClaudeWorkDir } from "./workdir.js";

const cleanup: string[] = [];
const ownerUid = typeof process.getuid === "function" ? process.getuid() : 501;

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-work-test-"));
  cleanup.push(dir);
  return dir;
}

describe("claudeWorkDirName", () => {
  it("keeps the user's uid in the name on a shared temp directory", () => {
    expect(claudeWorkDirName("linux", 1000)).toBe("neolix-claude-work-1000");
    expect(claudeWorkDirName("darwin", 501)).toBe("neolix-claude-work-501");
  });

  it("has no uid where the platform has none", () => {
    expect(claudeWorkDirName("win32", 0)).toBe("neolix-claude-work");
    expect(claudeWorkDirName("linux", null)).toBe("neolix-claude-work");
  });
});

describe("ensureClaudeWorkDir", () => {
  // Windows has no POSIX mode bits; ensureClaudeWorkDir skips these checks there
  // (see "skips POSIX ownership checks on Windows").
  it.skipIf(process.platform === "win32")("creates a folder only its owner can use", async () => {
    const tmpDir = await tempDir();
    const dir = await ensureClaudeWorkDir({ tmpDir, platform: "linux", uid: ownerUid });
    const stats = await lstat(dir);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("refuses a folder others can write to", async () => {
    const tmpDir = await tempDir();
    const dir = await ensureClaudeWorkDir({ tmpDir, platform: "linux", uid: ownerUid });
    await chmod(dir, 0o770);
    await expect(ensureClaudeWorkDir({ tmpDir, platform: "linux", uid: ownerUid })).rejects.toThrow(
      "can be written by others",
    );
  });

  it("refuses a folder that belongs to another user", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-work-owner-"));
    cleanup.push(dir);
    await expect(
      ensureClaudeWorkDir({
        tmpDir: dir,
        platform: "linux",
        uid: 501,
        io: {
          mkdir: async () => {},
          lstat: async () => ({ isDirectory: () => true, uid: 0, mode: 0o40000 | 0o700 }),
        },
      }),
    ).rejects.toThrow("belongs to another user");
  });

  it("refuses something that is not a folder", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-work-file-"));
    cleanup.push(dir);
    await expect(
      ensureClaudeWorkDir({
        tmpDir: dir,
        platform: "linux",
        uid: 501,
        io: {
          mkdir: async () => {},
          lstat: async () => ({ isDirectory: () => false, uid: 501, mode: 0o100600 }),
        },
      }),
    ).rejects.toThrow("is not a folder");
  });

  it("skips POSIX ownership checks on Windows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-work-win-"));
    cleanup.push(dir);
    await expect(ensureClaudeWorkDir({ tmpDir: dir, platform: "win32" })).resolves.toBe(
      path.join(dir, "neolix-claude-work"),
    );
  });
});
