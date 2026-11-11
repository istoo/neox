import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeTap, TAP_ENV } from "./tap.js";

const tapScript = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../assets/claude/tap.cjs",
);
const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("tap.cjs", () => {
  it("says Claude Code is not a Bun it can tap, and keeps the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-tap-"));
    cleanup.push(dir);
    const file = path.join(dir, "events.jsonl");
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [tapScript], {
        env: { PATH: "/usr/bin:/bin", NEOLIX_CLAUDE_TAP: file, NEOLIX_CLAUDE_GUARD: "" },
        stdio: "ignore",
      });
      child.on("close", (exit) => resolve(exit));
    });
    expect(code).toBe(0);
    expect(await readFile(file, "utf8")).toBe('{"tap":"none"}\n');
  });

  it("does nothing when no tap file is named", async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [tapScript], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: "ignore",
      });
      child.on("close", (exit) => resolve(exit));
    });
    expect(code).toBe(0);
  });
});

describe("createClaudeTap", () => {
  const taps: Array<{ drop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const made of taps.splice(0)) {
      await made.drop();
    }
  });

  it("lays the tap out for Claude Code to preload", async () => {
    const made = await createClaudeTap();
    expect(made).not.toBeNull();
    if (!made) {
      return;
    }
    taps.push(made);
    expect(made.dir).toContain("neolix-claude-tap-");
    await expect(access(path.join(made.dir, "tap.cjs"))).resolves.toBeUndefined();
    await expect(access(made.file)).resolves.toBeUndefined();
    expect(made.env.BUN_OPTIONS).toBe(`--preload ${path.join(made.dir, "tap.cjs")}`);
    expect(made.env[TAP_ENV]).toBe(made.file);
  });

  it("keeps the user's own BUN_OPTIONS before the tap", async () => {
    const made = await createClaudeTap({ bunOptions: " --smol " });
    expect(made).not.toBeNull();
    if (!made) {
      return;
    }
    taps.push(made);
    expect(made.env.BUN_OPTIONS).toBe(`--smol --preload ${path.join(made.dir, "tap.cjs")}`);
  });

  it("gives no tap when the path has a space BUN_OPTIONS would split", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "neolix claude tap "));
    cleanup.push(tmp);
    expect(await createClaudeTap({ tmpDir: tmp })).toBeNull();
  });
});
