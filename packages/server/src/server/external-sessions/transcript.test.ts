import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalSessionsService } from "./service.js";
import { readTranscript } from "./transcript.js";

const roots: string[] = [];

async function writeClaudeSession(
  claudeDir: string,
  project: string,
  id: string,
  lines: readonly unknown[],
): Promise<string> {
  const dir = path.join(claudeDir, "projects", project);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  neolixHome: string;
  claudeDir: string;
  codexHome: string;
  piHome: string;
  service: ExternalSessionsService;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-transcript-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  const claudeDir = path.join(root, "claude");
  const codexHome = path.join(root, "codex");
  const piHome = path.join(root, "pi");
  await mkdir(neolixHome, { recursive: true });
  const service = new ExternalSessionsService({
    neolixHome,
    homeDir: root,
    env: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexHome,
      PI_CODING_AGENT_DIR: piHome,
    },
  });
  return { neolixHome, claudeDir, codexHome, piHome, service };
}

describe("readTranscript", () => {
  it("reads a Claude transcript as its user, assistant, thinking and tool parts", async () => {
    const { claudeDir } = await fixture();
    const file = await writeClaudeSession(claudeDir, "-work-app", "session-one", [
      {
        type: "user",
        message: { content: "Fix the login bug" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [
            { type: "thinking", thinking: "Look at the form" },
            { type: "text", text: "I'll read the file" },
            { type: "tool_use", name: "Bash", input: { command: "cat login.ts" } },
          ],
        },
        timestamp: "2026-09-20T10:00:05.000Z",
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "export const x = 1" }],
        },
        timestamp: "2026-09-20T10:00:06.000Z",
      },
    ]);

    const transcript = await readTranscript({ agent: "claude", path: file });

    expect(transcript.source).toBe("file");
    expect(transcript.cut).toBe(false);
    expect(transcript.parts).toEqual([
      { role: "user", kind: "text", text: "Fix the login bug" },
      { role: "assistant", kind: "thinking", text: "Look at the form", model: "claude-opus-5-5" },
      { role: "assistant", kind: "text", text: "I'll read the file", model: "claude-opus-5-5" },
      {
        role: "assistant",
        kind: "tool_use",
        name: "Bash",
        text: '{\n  "command": "cat login.ts"\n}',
        model: "claude-opus-5-5",
      },
      { role: "tool", kind: "tool_result", name: "t1", text: "export const x = 1" },
    ]);
  });

  it("skips sidechains and injected context in a Claude transcript", async () => {
    const { claudeDir } = await fixture();
    const file = await writeClaudeSession(claudeDir, "-work-app", "session-two", [
      { type: "user", isMeta: true, message: { content: "meta" } },
      { type: "user", isSidechain: true, message: { content: "side" } },
      {
        type: "user",
        message: { content: "<environment_context>cwd</environment_context>" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
      {
        type: "user",
        message: { content: "What changed?" },
        timestamp: "2026-09-20T10:00:01.000Z",
      },
    ]);

    const transcript = await readTranscript({ agent: "claude", path: file });

    expect(transcript.parts).toEqual([
      {
        role: "user",
        kind: "context",
        text: "<environment_context>cwd</environment_context>",
      },
      { role: "user", kind: "text", text: "What changed?" },
    ]);
  });

  it("reads a Codex rollout's messages, tool calls and results", async () => {
    const { codexHome } = await fixture();
    const dir = path.join(codexHome, "sessions", "2026", "09", "20");
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      "rollout-2026-09-20T15-48-28-01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd.jsonl",
    );
    await writeFile(
      file,
      [
        { type: "turn_context", payload: { model: "gpt-6-astra" } },
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
        },
        {
          type: "response_item",
          payload: { type: "reasoning", summary: [{ text: "Think" }] },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            name: "shell",
            arguments: '{"cmd":"ls"}',
          },
        },
        {
          type: "response_item",
          payload: { type: "function_call_output", output: "a.txt" },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );

    const transcript = await readTranscript({ agent: "codex", path: file });

    expect(transcript.parts).toEqual([
      { role: "user", kind: "text", text: "Hi" },
      { role: "assistant", kind: "thinking", text: "Think", model: "gpt-6-astra" },
      {
        role: "assistant",
        kind: "tool_use",
        name: "shell",
        text: '{\n  "cmd": "ls"\n}',
        model: "gpt-6-astra",
      },
      { role: "tool", kind: "tool_result", text: "a.txt" },
    ]);
  });

  it("reads the branch a Pi session is on", async () => {
    const { piHome } = await fixture();
    const dir = path.join(piHome, "sessions", "--work-pi--");
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      "2026-09-24T08-00-00-000Z_0199aaaa-1111-7222-8333-444455556666.jsonl",
    );
    await writeFile(
      file,
      [
        { type: "session", id: "s" },
        { type: "message", id: "a", parentId: "", message: { role: "user", content: "Old" } },
        {
          type: "message",
          id: "b",
          parentId: "a",
          message: { role: "assistant", content: "Old reply" },
        },
        {
          type: "message",
          id: "c",
          parentId: "a",
          message: { role: "user", content: "New branch" },
        },
        {
          type: "message",
          id: "d",
          parentId: "c",
          message: {
            role: "assistant",
            model: "gpt-6",
            content: [{ type: "text", text: "New reply" }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );

    const transcript = await readTranscript({ agent: "pi", path: file });

    expect(transcript.parts.map((part) => part.text)).toEqual(["Old", "New branch", "New reply"]);
  });
});

describe("ExternalSessionsService transcripts", () => {
  it("lists a Claude session's subagents and reads their conversations", async () => {
    const { service, claudeDir } = await fixture();
    const file = await writeClaudeSession(claudeDir, "-work-app", "session-three", [
      {
        type: "user",
        message: { content: "Explore the repo" },
        timestamp: "2026-09-20T10:00:00.000Z",
      },
    ]);
    const subDir = path.join(path.dirname(file), "session-three", "subagents");
    await mkdir(subDir, { recursive: true });
    const subFile = path.join(subDir, "agent-sub1.jsonl");
    await writeFile(
      subFile,
      [
        { type: "user", message: { content: "Find the router" } },
        {
          type: "assistant",
          message: {
            id: "s1",
            model: "claude-haiku-5-5",
            content: [{ type: "text", text: "Found it" }],
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(subDir, "agent-sub1.meta.json"),
      JSON.stringify({
        agentType: "Explore",
        description: "Find the router",
        parentAgentId: "main",
      }),
      "utf8",
    );

    const list = await service.list("claude");
    expect(list.sessions[0]?.subagents).toEqual([
      {
        id: "sub1",
        title: "Find the router",
        kind: "Explore",
        parent: "main",
        start: expect.any(String),
        last: expect.any(String),
      },
    ]);

    const transcript = await service.transcript({
      agent: "claude",
      id: "session-three",
      sub: "sub1",
    });
    expect(transcript.parts.map((part) => part.text)).toEqual(["Find the router", "Found it"]);
  });

  it("pages a long conversation", async () => {
    const { service, claudeDir } = await fixture();
    const lines = Array.from({ length: 8 }, (_, index) => ({
      type: "user",
      message: { content: `line ${index}` },
      timestamp: `2026-09-20T10:00:0${index}.000Z`,
    }));
    await writeClaudeSession(claudeDir, "-work-app", "session-four", lines);

    const first = await service.transcript({ agent: "claude", id: "session-four", limit: 3 });
    const second = await service.transcript({
      agent: "claude",
      id: "session-four",
      offset: 3,
      limit: 3,
    });

    expect(first.total).toBe(8);
    expect(first.parts.map((part) => part.text)).toEqual(["line 0", "line 1", "line 2"]);
    expect(second.parts.map((part) => part.text)).toEqual(["line 3", "line 4", "line 5"]);
  });

  it("exports a session as Markdown in myna's shape", async () => {
    const { service, claudeDir } = await fixture();
    await writeClaudeSession(claudeDir, "-work-app", "abcdef1234567890", [
      {
        type: "user",
        message: { content: "Fix the login bug" },
        timestamp: "2026-09-20T10:00:00.000Z",
        cwd: "/work/app",
      },
      {
        type: "assistant",
        message: {
          id: "m1",
          model: "claude-opus-5-5",
          content: [
            { type: "thinking", thinking: "Look at the form" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
        },
        timestamp: "2026-09-20T10:00:05.000Z",
      },
    ]);

    const exported = await service.exportMarkdown("claude", "abcdef1234567890");

    expect(exported.fileName).toBe("neolix-session-claude-abcdef123456.md");
    expect(exported.markdown).toContain("# Fix the login bug");
    expect(exported.markdown).toContain("- **Agent:** Claude Code");
    expect(exported.markdown).toContain("- **Session ID:** `abcdef1234567890`");
    expect(exported.markdown).toContain("## User");
    expect(exported.markdown).toContain("## Assistant");
    expect(exported.markdown).toContain("<summary>Thinking</summary>");
    expect(exported.markdown).toContain("**Tool call: Bash**");
  });
});

describe("ExternalSessionsService codex provider", () => {
  it("reports the provider a rollout names and the one Codex uses now", async () => {
    const { service, codexHome } = await fixture();
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "config.toml"), 'model_provider = "neolix"\n', "utf8");
    const dir = path.join(codexHome, "sessions", "2026", "09", "20");
    await mkdir(dir, { recursive: true });
    const file = path.join(
      dir,
      "rollout-2026-09-20T15-48-28-01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd.jsonl",
    );
    await writeFile(
      file,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: "01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd",
          cwd: "/work/codex",
          model_provider: "custom",
        },
      })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(file, old, old);

    const list = await service.list("codex");

    expect(list.sessions[0]).toMatchObject({ provider: "custom", usesProvider: "neolix" });

    const result = await service.codexProvider([
      { id: "01a0bdc9-b5fd-7e63-9658-68bc8dce5ecd", to: "neolix" },
    ]);
    expect(result.refused).toEqual([]);
    expect(result.moved[0]).toMatchObject({ from: "custom", to: "neolix" });
    const rewritten = await readFile(file, "utf8");
    expect(rewritten).toContain('"model_provider":"neolix"');
  });
});
