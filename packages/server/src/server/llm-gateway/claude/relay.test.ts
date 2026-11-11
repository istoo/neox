import { describe, expect, it } from "vitest";
import { relayClaudeEvents } from "./relay.js";
import type { ClaudeStreamEvent } from "./stream.js";

async function relay(events: readonly ClaudeStreamEvent[]): Promise<string[]> {
  async function* source(): AsyncGenerator<ClaudeStreamEvent> {
    for (const event of events) {
      yield event;
    }
  }
  const frames: string[] = [];
  for await (const frame of relayClaudeEvents(source(), {
    model: "claude-sonnet-5",
    messageId: "msg_1",
  })) {
    frames.push(frame);
  }
  return frames;
}

function names(frames: readonly string[]): string[] {
  return frames.map((frame) => frame.slice("event: ".length, frame.indexOf("\n")));
}

function data(frame: string): Record<string, unknown> {
  return JSON.parse(frame.slice(frame.indexOf("data: ") + 6).trim()) as Record<string, unknown>;
}

describe("relayClaudeEvents", () => {
  it("turns words, a tool call and the stop into Anthropic SSE", async () => {
    const frames = await relay([
      { kind: "text", text: "Let me read it." },
      { kind: "toolCall", id: "toolu_1", name: "mcp__neox__read", arguments: '{"path":"a"}' },
      {
        kind: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
        },
      },
      { kind: "stop", stop: "tool_use" },
    ]);
    expect(names(frames)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(data(frames[0] ?? "")).toMatchObject({
      type: "message_start",
      message: { id: "msg_1", model: "claude-sonnet-5" },
    });
    expect(data(frames[1] ?? "")).toMatchObject({
      content_block: { type: "text", text: "" },
      index: 0,
    });
    expect(data(frames[2] ?? "")).toMatchObject({
      delta: { type: "text_delta", text: "Let me read it." },
    });
    expect(data(frames[4] ?? "")).toMatchObject({
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "mcp__neox__read" },
    });
    expect(data(frames[5] ?? "")).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
    });
    expect(data(frames[7] ?? "")).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
    });
  });

  it("ends a reply that says nothing", async () => {
    const frames = await relay([{ kind: "stop", stop: "end_turn" }]);
    expect(names(frames)).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  it("reports an error as an SSE error", async () => {
    const frames = await relay([{ kind: "error", message: "boom" }]);
    expect(names(frames)).toContain("error");
    expect(data(frames[0] ?? "")).toMatchObject({ type: "error", error: { message: "boom" } });
  });
});
