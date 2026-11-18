import { describe, expect, it } from "vitest";

import { parseSseEvents, sseEventText, sseReply, sseStreamText } from "./gatewaySse.logic";

describe("gatewaySse", () => {
  it("does not mistake a plain body for a stream", () => {
    expect(parseSseEvents("")).toBeNull();
    expect(parseSseEvents('{"ok":true}')).toBeNull();
    expect(parseSseEvents("plain text")).toBeNull();
  });

  it("reads named events, multi-line data and keep-alives", () => {
    const events = parseSseEvents(
      [
        ": keep-alive",
        "event: message_start",
        'data: {"type":"message_start","message":{"id":"m1","model":"claude"}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    expect(events).toEqual([
      {
        event: "message_start",
        data: '{"type":"message_start","message":{"id":"m1","model":"claude"}}',
      },
      { event: "", data: "[DONE]" },
    ]);
    expect(sseEventText(events![0]!)).toContain('"id": "m1"');
    expect(sseEventText(events![1]!)).toBe("[DONE]");
  });

  it("rebuilds an Anthropic reply from its deltas", () => {
    const events = parseSseEvents(
      [
        'data: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":3}}}',
        "",
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
        "",
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
        "",
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
        "",
      ].join("\n"),
    )!;
    expect(sseReply(events)).toEqual({
      id: "msg_1",
      model: "claude",
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  it("rebuilds OpenAI chat choices and tool arguments", () => {
    const events = parseSseEvents(
      [
        'data: {"id":"chat-1","model":"gpt","choices":[{"index":0,"delta":{"content":"Hel"}}]}',
        "",
        'data: {"id":"chat-1","model":"gpt","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
        "",
      ].join("\n"),
    )!;
    expect(sseReply(events)).toMatchObject({
      id: "chat-1",
      model: "gpt",
      choices: [{ type: "message", content: "Hello" }],
      finish_reason: "stop",
    });
  });

  it("has no reply view when the stream only carries non-object data", () => {
    const events = parseSseEvents("data: [DONE]\n\n");
    expect(events).not.toBeNull();
    expect(sseReply(events!)).toBeNull();
    expect(sseStreamText(events!)).toBe("[DONE]");
  });
});
