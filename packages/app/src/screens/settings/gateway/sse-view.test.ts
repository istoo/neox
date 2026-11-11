import { describe, expect, test } from "vitest";
import { parseSseEvents, sseEventText, sseReply } from "./sse-view";

describe("parseSseEvents", () => {
  test("reads named events, multi-line data and comments", () => {
    const raw = [
      ": keep-alive",
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"m1","model":"claude"}}',
      "",
      "data: first",
      "data: second",
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(parseSseEvents(raw)).toEqual([
      {
        event: "message_start",
        data: '{"type":"message_start","message":{"id":"m1","model":"claude"}}',
      },
      { event: "", data: "first\nsecond" },
      { event: "", data: "[DONE]" },
    ]);
  });

  test("handles CRLF and a missing trailing blank line", () => {
    expect(parseSseEvents("event: ping\r\ndata: {}\r\n")).toEqual([{ event: "ping", data: "{}" }]);
  });

  test("a body that is not a stream parses to null", () => {
    expect(parseSseEvents("")).toBeNull();
    expect(parseSseEvents('{"choices":[]}')).toBeNull();
    expect(parseSseEvents("hello: world")).toBeNull();
  });
});

describe("sseEventText", () => {
  test("pretty-prints JSON and leaves [DONE] as it came", () => {
    expect(sseEventText({ event: "", data: '{"a":1}' })).toBe('{\n  "a": 1\n}');
    expect(sseEventText({ event: "", data: "[DONE]" })).toBe("[DONE]");
  });
});

describe("sseReply", () => {
  test("rebuilds an Anthropic reply object", () => {
    const events = parseSseEvents(
      [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude"}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"read"}}',
        "",
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}',
        "",
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        "",
      ].join("\n"),
    );
    expect(events).not.toBeNull();
    expect(sseReply(events!)).toEqual({
      id: "m1",
      model: "claude",
      content: [
        { type: "text", text: "Hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", name: "read", input: { path: "a" } },
      ],
      stop_reason: "end_turn",
      usage: { output_tokens: 3 },
    });
  });

  test("rebuilds an OpenAI chat reply object", () => {
    const events = parseSseEvents(
      [
        'data: {"id":"c1","model":"gpt","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"why"}}]}',
        "",
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"ls","arguments":"{}"}}]}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
    expect(sseReply(events!)).toEqual({
      id: "c1",
      model: "gpt",
      choices: [
        { type: "message", content: "Hi", reasoning: "why" },
        { type: "tool_call", name: "ls", arguments: {} },
      ],
    });
  });

  test("rebuilds an OpenAI Responses reply object", () => {
    const events = parseSseEvents(
      [
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"i1","delta":"Hi"}',
        "",
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"i2","type":"function_call","name":"ls"}}',
        "",
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"i2","delta":"{}"}',
        "",
      ].join("\n"),
    );
    expect(sseReply(events!)).toEqual({
      output: [
        { type: "message", text: "Hi" },
        { type: "function_call", name: "ls", arguments: {} },
      ],
    });
  });

  test("rebuilds a Gemini reply object", () => {
    const events = parseSseEvents(
      [
        'data: {"modelVersion":"gemini","usageMetadata":{"totalTokenCount":2},"candidates":[{"index":0,"content":{"parts":[{"text":"Hi"},{"text":"hm","thought":true},{"functionCall":{"name":"ls","args":{"p":1}}}]}}]}',
        "",
      ].join("\n"),
    );
    expect(sseReply(events!)).toEqual({
      model: "gemini",
      usage: { totalTokenCount: 2 },
      parts: [
        { type: "text", text: "Hi" },
        { type: "thought", text: "hm" },
        { type: "functionCall", name: "ls", args: { p: 1 } },
      ],
    });
  });

  test("an error-only stream still makes a reply", () => {
    const events = parseSseEvents(
      'data: {"error":{"type":"overloaded_error","message":"busy"}}\n\n',
    );
    expect(sseReply(events!)).toEqual({
      error: { type: "overloaded_error", message: "busy" },
    });
  });

  test("a stream with no readable reply is null", () => {
    const events = parseSseEvents("event: ping\ndata: {}\n\n");
    expect(sseReply(events!)).toBeNull();
  });
});
