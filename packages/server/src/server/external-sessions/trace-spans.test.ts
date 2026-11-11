import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionTraceSpans } from "./trace-spans.js";

async function transcript(name: string, lines: object[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "neolix-traces-"));
  const file = path.join(dir, name);
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return file;
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 2, 4, 5, 0, second)).toISOString();
}

function ms(second: number): number {
  return Date.parse(at(second));
}

function byKind(spans: Awaited<ReturnType<typeof readSessionTraceSpans>>, kind: string) {
  return spans.filter((span) => span.kind === kind);
}

describe("readSessionTraceSpans", () => {
  it("reads Claude's turn, model responses and tool calls with their timestamps", async () => {
    const file = await transcript("claude.jsonl", [
      { type: "user", timestamp: at(0), message: { role: "user", content: "Fix it" } },
      {
        type: "assistant",
        timestamp: at(1),
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 20 },
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "ls" } }],
        },
      },
      {
        type: "user",
        timestamp: at(2),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      },
      {
        type: "assistant",
        timestamp: at(3),
        message: {
          id: "msg_2",
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 150, output_tokens: 30 },
          content: [{ type: "text", text: "Done" }],
        },
      },
      { type: "system", subtype: "turn_duration", timestamp: at(4) },
    ]);
    const spans = await readSessionTraceSpans({
      agent: "claude",
      session: "s-1",
      path: file,
      bodies: true,
    });
    const [root] = byKind(spans, "span");
    expect(root).toMatchObject({
      name: "claude interaction",
      startMs: ms(0),
      endMs: ms(4),
    });
    expect(root!.tokens).toEqual({ input: 250, output: 50, cacheRead: 0, cacheWrite: 0 });
    expect(root!.input).toBe("Fix it");
    expect(root!.output).toBe("Done");

    const generations = byKind(spans, "generation");
    expect(generations).toHaveLength(2);
    expect(generations[0]).toMatchObject({
      name: "model claude-sonnet-4-5",
      startMs: ms(0),
      endMs: ms(1),
      inferred: true,
    });
    expect(generations[1]).toMatchObject({ startMs: ms(2), endMs: ms(3) });
    expect(generations[0]!.parentId).toBe(root!.id);

    const [tool] = byKind(spans, "tool");
    expect(tool).toMatchObject({
      name: "Bash",
      startMs: ms(1),
      endMs: ms(2),
      traceId: root!.traceId,
    });
    expect(tool!.parentId).toBe(root!.id);
  });

  it("reads Codex's responses, tool calls and usage delta", async () => {
    const file = await transcript("codex.jsonl", [
      {
        type: "response_item",
        timestamp: at(0),
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] },
      },
      {
        type: "response_item",
        timestamp: at(1),
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Looking" }],
        },
      },
      {
        type: "response_item",
        timestamp: at(1),
        payload: { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      },
      {
        type: "response_item",
        timestamp: at(2),
        payload: { type: "function_call_output", call_id: "c1", output: "done" },
      },
      {
        type: "event_msg",
        timestamp: at(3),
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 40 },
          },
        },
      },
    ]);
    const spans = await readSessionTraceSpans({
      agent: "codex",
      session: "s-2",
      path: file,
      bodies: true,
    });
    const [root] = byKind(spans, "span");
    expect(root).toMatchObject({ startMs: ms(0), endMs: ms(3), name: "codex interaction" });
    expect(root!.input).toBe("Hi");
    expect(root!.output).toBe("Looking");
    expect(root!.tokens).toEqual({ input: 300, output: 40, cacheRead: 200, cacheWrite: 0 });

    const [generation] = byKind(spans, "generation");
    expect(generation!.tokens).toEqual({ input: 300, output: 40, cacheRead: 200, cacheWrite: 0 });

    const [tool] = byKind(spans, "tool");
    expect(tool).toMatchObject({ name: "shell", startMs: ms(1), endMs: ms(2) });
  });

  it("leaves agents without per-line time to the session span", async () => {
    const spans = await readSessionTraceSpans({
      agent: "opencode",
      session: "s-3",
      path: "/tmp/does-not-matter",
    });
    expect(spans).toEqual([]);
  });
});
