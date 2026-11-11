import { describe, expect, it } from "vitest";
import { replyPieces } from "./prompt-reply.js";

const anthropicReply = JSON.stringify({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [
    { type: "text", text: "It is 41." },
    { type: "thinking", thinking: "work it out" },
    { type: "tool_use", id: "tu_1", name: "calc", input: { a: 1 } },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 5 },
});

describe("replyPieces", () => {
  it("reads a JSON reply into its answer, thinking and tool call", () => {
    const reply = replyPieces("anthropic", anthropicReply, false);
    expect(reply?.pieces).toEqual([
      { role: "assistant", text: "It is 41." },
      { role: "thinking", text: "work it out" },
      { role: "call", name: "calc", text: '{"a":1}' },
    ]);
    expect(reply?.cut).toBe(false);
  });

  it("reads an event stream's text", () => {
    const stream = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
    ].join("");
    const reply = replyPieces("anthropic", stream, false);
    expect(reply?.pieces).toEqual([{ role: "assistant", text: "Hello" }]);
  });

  it("keeps the truncation the archive reported", () => {
    const reply = replyPieces("anthropic", anthropicReply, true);
    expect(reply?.cut).toBe(true);
  });

  it("answers null for a body it cannot read", () => {
    expect(replyPieces("openai", "not a reply", false)).toBeNull();
  });
});
