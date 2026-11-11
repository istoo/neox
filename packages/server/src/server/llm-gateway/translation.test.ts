import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import type { StreamDecoder } from "./codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import { isRecord, type IrEvent } from "./ir.js";

function decodeAll(decoder: StreamDecoder, chunks: string[]): IrEvent[] {
  const events: IrEvent[] = [];
  for (const chunk of chunks) {
    events.push(...decoder.push(chunk));
  }
  events.push(...decoder.flush());
  return events;
}

function encodeAll(
  encoder: { start: () => string; push: (event: IrEvent) => string; end: () => string },
  events: IrEvent[],
): string {
  const parts = [encoder.start()];
  for (const event of events) {
    parts.push(encoder.push(event));
  }
  parts.push(encoder.end());
  return parts.join("");
}

interface SseFrame {
  event: string | null;
  data: Record<string, unknown>;
}

function parseFrames(sse: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of sse.split("\n\n")) {
    const lines = block.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) {
      continue;
    }
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const dataLine = lines.find((line) => line.startsWith("data: "));
    if (dataLine === undefined) {
      continue;
    }
    const raw = dataLine.slice("data: ".length);
    if (raw === "[DONE]") {
      continue;
    }
    const data: unknown = JSON.parse(raw);
    if (isRecord(data)) {
      frames.push({
        event: eventLine === undefined ? null : eventLine.slice("event: ".length),
        data,
      });
    }
  }
  return frames;
}

describe("request translation", () => {
  it("turns an Anthropic Messages request into an OpenAI Chat request", () => {
    const anthropicBody = {
      model: "claude-x",
      system: "be terse",
      max_tokens: 256,
      stream: true,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "shell", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" },
            { type: "text", text: "next" },
          ],
        },
      ],
      tools: [{ name: "shell", description: "run", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    };

    const ir = anthropicCodec.parseRequest(anthropicBody);
    const openai = openAiChatCodec.buildRequestBody(ir, "gpt-x");

    expect(openai.model).toBe("gpt-x");
    expect(openai.stream).toBe(true);
    expect(openai.stream_options).toEqual({ include_usage: true });
    expect(openai.tool_choice).toBe("required");
    expect(openai.tools).toEqual([
      {
        type: "function",
        function: { name: "shell", description: "run", parameters: { type: "object" } },
      },
    ]);

    const messages = openai.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
    expect(messages[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "toolu_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } },
      ],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_1", content: "a.txt" });
    expect(messages[4]).toEqual({ role: "user", content: "next" });
  });

  it("keeps a deferred tool loaded by a tool_reference through the IR", () => {
    const anthropicBody = {
      model: "claude-x",
      max_tokens: 256,
      messages: [
        { role: "user", content: "find a tool" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "tool_search", input: { query: "shell" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "tool_reference", tool_name: "shell" }],
            },
            { type: "text", text: "run it" },
          ],
        },
      ],
      tools: [
        {
          name: "shell",
          description: "run",
          input_schema: { type: "object" },
          defer_loading: true,
        },
        { name: "other", description: "other", input_schema: { type: "object" } },
      ],
    };

    const ir = anthropicCodec.parseRequest(anthropicBody);
    expect(ir.tools.find((tool) => tool.name === "shell")?.deferred).toBe(true);
    expect(ir.tools.find((tool) => tool.name === "other")?.deferred).toBeUndefined();
    const result = ir.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool_result");
    expect(result).toMatchObject({ loads: ["shell"] });

    // loaded in place: an additional_tools item after the result, the tool
    // not offered again up top
    const inPlace = openAiResponsesCodec.buildRequestBody({ ...ir, loadedInPlace: true }, "gpt-x");
    const input = inPlace.input as Array<Record<string, unknown>>;
    const loadedAt = input.findIndex((item) => item.type === "additional_tools");
    expect(loadedAt).toBeGreaterThan(
      input.findIndex((item) => item.type === "function_call_output"),
    );
    expect(input[loadedAt]?.tools).toMatchObject([{ type: "function", name: "shell" }]);
    expect((inPlace.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toEqual([
      "other",
    ]);

    // anywhere else: the deferred tool goes back in the top-level tools
    const moved = openAiResponsesCodec.buildRequestBody(ir, "gpt-x");
    expect(
      (moved.input as Array<Record<string, unknown>>).some(
        (item) => item.type === "additional_tools",
      ),
    ).toBe(false);
    expect((moved.tools as Array<Record<string, unknown>>).map((tool) => tool.name)).toEqual([
      "shell",
      "other",
    ]);
  });

  it("turns an OpenAI Chat request into an Anthropic Messages request", () => {
    const openaiBody = {
      model: "gpt-x",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "shell", arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      ],
      tools: [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "shell" } },
      max_tokens: 128,
    };

    const ir = openAiChatCodec.parseRequest(openaiBody);
    const anthropic = anthropicCodec.buildRequestBody(ir, "claude-x");

    expect(anthropic.system).toBe("be terse");
    expect(anthropic.max_tokens).toBe(128);
    expect(anthropic.tool_choice).toEqual({ type: "tool", name: "shell" });
    expect(anthropic.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "shell", input: { cmd: "ls" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "a.txt", is_error: false },
        ],
      },
    ]);
  });

  it("round-trips an image through data URLs", () => {
    const openaiBody = {
      model: "gpt-x",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    };

    const ir = openAiChatCodec.parseRequest(openaiBody);
    const anthropic = anthropicCodec.buildRequestBody(ir, "claude-x");
    expect(anthropic.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });
});

describe("stream translation", () => {
  it("turns Anthropic SSE into OpenAI Chat chunks", () => {
    const anthropicSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":11,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const events = decodeAll(anthropicCodec.createStreamDecoder(), anthropicSse);
    const output = encodeAll(openAiChatCodec.createStreamEncoder("gpt-x"), events);
    const frames = parseFrames(output);

    const text = frames
      .map((frame) => {
        const choices = frame.data.choices;
        if (!Array.isArray(choices)) {
          return "";
        }
        const first = choices[0];
        if (!isRecord(first) || !isRecord(first.delta)) {
          return "";
        }
        return typeof first.delta.content === "string" ? first.delta.content : "";
      })
      .join("");

    expect(text).toBe("Hello");
    expect(output).toContain("data: [DONE]");
  });

  it("maps OpenAI reasoning_content to Anthropic thinking deltas", () => {
    const openaiSse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"thinking"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events = decodeAll(openAiChatCodec.createStreamDecoder(), openaiSse);
    expect(events).toContainEqual({ type: "thinking_delta", text: "thinking" });
    expect(events).toContainEqual({ type: "text_delta", text: "answer" });

    const output = encodeAll(anthropicCodec.createStreamEncoder("claude-x"), events);
    const frames = parseFrames(output);
    const blockTypes = frames
      .filter((frame) => frame.event === "content_block_start")
      .map((frame) => (isRecord(frame.data.content_block) ? frame.data.content_block.type : null));
    expect(blockTypes).toEqual(["thinking", "text"]);
  });

  it("turns OpenAI tool-call chunks into Anthropic tool_use blocks", () => {
    const openaiSse = [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const events = decodeAll(openAiChatCodec.createStreamDecoder(), openaiSse);
    const output = encodeAll(anthropicCodec.createStreamEncoder("claude-x"), events);
    const frames = parseFrames(output);

    const toolStart = frames.find(
      (frame) => frame.event === "content_block_start" && isToolUseBlock(frame.data.content_block),
    );
    expect(toolStart).toBeDefined();

    const args = frames
      .filter((frame) => frame.event === "content_block_delta")
      .map((frame) => frame.data.delta)
      .filter(isInputJsonDelta)
      .map((delta) => delta.partial_json)
      .join("");
    expect(args).toBe('{"cmd":"ls"}');

    const messageDelta = frames.find((frame) => frame.event === "message_delta");
    expect(messageDelta?.data.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
  });
});

function isToolUseBlock(value: unknown): boolean {
  return isRecord(value) && value.type === "tool_use";
}

function isInputJsonDelta(value: unknown): value is { partial_json: string } {
  return (
    isRecord(value) && value.type === "input_json_delta" && typeof value.partial_json === "string"
  );
}
