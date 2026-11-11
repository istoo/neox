import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudePromptMessage } from "./prompt.js";
import { replyWords, writeReplaySession } from "./replay.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-replay-"));
  cleanup.push(dir);
  return dir;
}

const user = (text: string): ClaudePromptMessage => ({
  role: "user",
  parts: [{ kind: "text", text }],
});
const assistant = (text: string): ClaudePromptMessage => ({
  role: "assistant",
  parts: [{ kind: "text", text }],
});

describe("writeReplaySession", () => {
  it("writes the two lines a run at the reply's turn would have", async () => {
    const dir = await tempDir();
    const messages = [user("hi"), assistant("hello"), user("next")];
    const replayed = await writeReplaySession({
      dirs: [dir],
      work: "/work",
      model: "claude-sonnet-5",
      messages,
    });
    expect(replayed).not.toBeNull();
    expect(replayed?.since).toEqual([user("next")]);
    const lines = (await readFile(path.join(dir, `${replayed?.session ?? ""}.jsonl`), "utf8"))
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    const second = JSON.parse(lines[1] ?? "") as Record<string, unknown>;
    expect(first).toMatchObject({ type: "user", cwd: "/work", parentUuid: null });
    expect(JSON.stringify(first.message)).toContain("Human: hi");
    expect(JSON.stringify(first.message)).not.toContain("hello");
    expect(second).toMatchObject({ type: "assistant", parentUuid: first.uuid });
    expect(JSON.stringify(second.message)).toContain('"text":"hello"');
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("does not write one without a whole reply", async () => {
    const dir = await tempDir();
    const noReply = await writeReplaySession({
      dirs: [dir],
      work: "/work",
      model: "m",
      messages: [user("hi"), assistant("hello")],
    });
    expect(noReply).toBeNull();
    const noWords = await writeReplaySession({
      dirs: [dir],
      work: "/work",
      model: "m",
      messages: [
        user("hi"),
        { role: "assistant", parts: [{ kind: "text", text: "  " }] },
        user("next"),
      ],
    });
    expect(noWords).toBeNull();
  });

  it("does not write one where Claude Code keeps no sessions", async () => {
    const replayed = await writeReplaySession({
      dirs: [],
      work: "/work",
      model: "m",
      messages: [user("hi"), assistant("hello"), user("next")],
    });
    expect(replayed).toBeNull();
  });
});

describe("replyWords", () => {
  it("joins a reply's words and leaves thinking out", () => {
    expect(
      replyWords({
        role: "assistant",
        parts: [
          { kind: "text", text: "one" },
          { kind: "text", text: "two" },
          { kind: "text", text: " " },
        ],
      }),
    ).toBe("one\n\ntwo");
  });
});
