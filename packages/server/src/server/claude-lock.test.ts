import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ClaudeLockHeldError, lockClaudeConfig, takeClaudeLock } from "./claude-lock.js";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-claude-lock-"));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

it("makes a mkdir lock and lets it go", async () => {
  const lockPath = path.join(directory, "state.lock");
  const lock = await takeClaudeLock(lockPath, 10_000, { touchMs: 60_000 });
  expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
  await lock.release();
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for a lock Claude Code holds, then gives up", async () => {
  const lockPath = path.join(directory, "state.lock");
  const held = await takeClaudeLock(lockPath, 10_000, { touchMs: 60_000 });
  await expect(
    takeClaudeLock(lockPath, 10_000, { waitMs: 30, pollMs: 5, touchMs: 60_000 }),
  ).rejects.toBeInstanceOf(ClaudeLockHeldError);
  await held.release();
});

it("takes over a lock left by a holder that died", async () => {
  const lockPath = path.join(directory, "state.lock");
  await fs.mkdir(lockPath);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
  const lock = await takeClaudeLock(lockPath, 10_000, { touchMs: 60_000 });
  expect((await fs.stat(lockPath)).isDirectory()).toBe(true);
  await lock.release();
});

it("locks ~/.claude.json's real path with .lock, and is a no-op when its folder is gone", async () => {
  const config = path.join(directory, ".claude.json");
  await fs.writeFile(config, "{}");
  const lock = await lockClaudeConfig(config, { touchMs: 60_000 });
  expect((await fs.stat(`${config}.lock`)).isDirectory()).toBe(true);
  await lock.release();

  const elsewhere = path.join(directory, "not-installed", ".claude.json");
  const absent = await lockClaudeConfig(elsewhere, { touchMs: 60_000 });
  await absent.release();
  expect(await fs.readdir(directory)).toEqual([".claude.json"]);
});
