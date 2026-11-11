import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeProjectName,
  claudeSessionDirs,
  ClaudeSessionShelf,
  cutSession,
  removeSession,
} from "./sessions.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

describe("claudeProjectName", () => {
  it("makes everything but letters and digits a dash", () => {
    expect(claudeProjectName("/Users/u/project/Ai/Neox")).toBe("-Users-u-project-Ai-Neox");
  });
});

describe("claudeSessionDirs", () => {
  it("looks under the work folder as given and as resolved", async () => {
    const work = await tempDir("neolix-claude-work-");
    const dirs = await claudeSessionDirs("/tmp/config", work);
    expect(dirs[0]).toBe(path.join("/tmp/config", "projects", claudeProjectName(work)));
    const resolved = await realpath(work);
    if (resolved !== work) {
      expect(dirs).toContain(path.join("/tmp/config", "projects", claudeProjectName(resolved)));
    }
  });
});

describe("removeSession", () => {
  it("removes a transcript the bridge made", async () => {
    const dir = await tempDir("neolix-claude-remove-");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "session-1.jsonl");
    await writeFile(file, "{}\n");
    await removeSession([dir], "session-1");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("never leaves the project folder", async () => {
    const dir = await tempDir("neolix-claude-escape-");
    const outside = path.join(dir, "keep.jsonl");
    await writeFile(outside, "{}\n");
    const project = path.join(dir, "project");
    await mkdir(project);
    await removeSession([project], "../keep");
    await removeSession([project], "a/b");
    await expect(readFile(outside, "utf8")).resolves.toBe("{}\n");
  });
});

describe("ClaudeSessionShelf", () => {
  it("keeps a session for its conversation's next turn", () => {
    const shelf = new ClaudeSessionShelf({ ttlMs: 1000 });
    shelf.put("s1", ["/tmp/project"], "key-1");
    expect(shelf.get("key-1")).toMatchObject({ session: "s1" });
    shelf.dispose();
  });

  it("lets a session go past its ttl", async () => {
    vi.useFakeTimers();
    const dir = await tempDir("neolix-claude-shelf-ttl-");
    const shelf = new ClaudeSessionShelf({ ttlMs: 1000 });
    shelf.put("s1", [dir], "key-1");
    vi.advanceTimersByTime(1001);
    expect(shelf.get("key-1")).toBeUndefined();
  });

  it("keeps the most recent sessions only", () => {
    const shelf = new ClaudeSessionShelf({ most: 1 });
    shelf.put("s1", [], "key-1");
    shelf.put("s2", [], "key-2");
    expect(shelf.get("key-1")).toBeUndefined();
    expect(shelf.get("key-2")).toMatchObject({ session: "s2" });
    shelf.dispose();
  });
});

describe("cutSession", () => {
  const rows = [
    { type: "user", sessionId: "s1", uuid: "u1", message: { content: "hi" } },
    { type: "assistant", sessionId: "s1", uuid: "u2", message: { id: "m1" } },
    { type: "user", sessionId: "s1", uuid: "u3", message: { content: "there" } },
  ];

  async function transcript(): Promise<string> {
    const dir = await tempDir("neolix-cut-");
    await writeFile(
      path.join(dir, "s1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    return dir;
  }

  it("copies the session through the line it cuts after, under an id of its own", async () => {
    const dir = await transcript();
    const cut = await cutSession([dir], "s1", "u2");
    expect(cut).not.toBe("s1");
    const text = await readFile(path.join(dir, `${cut}.jsonl`), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).toContain('"sessionId":"' + cut + '"');
    expect(text).not.toContain("there");
  });

  it("waits for the line to be written", async () => {
    const dir = await tempDir("neolix-cut-");
    const file = path.join(dir, "s1.jsonl");
    await writeFile(file, `${JSON.stringify(rows[0])}\n`);
    const cutting = cutSession([dir], "s1", "u2", 1_000);
    setTimeout(() => {
      void writeFile(file, `${JSON.stringify(rows[1])}\n`, { flag: "a" });
    }, 50);
    await expect(cutting).resolves.toEqual(expect.any(String));
  });

  it("refuses a line it doesn't find, and ids that can't name a file", async () => {
    const dir = await transcript();
    await expect(cutSession([dir], "s1", "nope", 50)).rejects.toThrow("isn't in session");
    await expect(cutSession([dir], "../s1", "u2")).rejects.toThrow("no session to cut");
  });
});
