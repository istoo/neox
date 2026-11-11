import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import type { StreamDecoder, StreamEncoder } from "./codec.js";
import { geminiCodec } from "./gemini-codec.js";
import { isRecord, type IrEvent } from "./ir.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";

function decodeAll(decoder: StreamDecoder, chunks: string[]): IrEvent[] {
  const events: IrEvent[] = [];
  for (const chunk of chunks) {
    events.push(...decoder.push(chunk));
  }
  events.push(...decoder.flush());
  return events;
}

function encodeAll(encoder: StreamEncoder, events: IrEvent[]): string {
  const parts = [encoder.start()];
  for (const event of events) {
    parts.push(encoder.push(event));
  }
  parts.push(encoder.end());
  return parts.join("");
}

describe("OpenAI Responses codec", () => {
  it("parses instructions and input into the IR", () => {
    const ir = openAiResponsesCodec.parseRequest({
      model: "resp-model",
      instructions: "be terse",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: '{"cmd":"ls"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      ],
      max_output_tokens: 128,
    });

    expect(ir.system).toBe("be terse");
    expect(ir.maxTokens).toBe(128);
    expect(ir.messages[1]).toMatchObject({
      role: "assistant",
      parts: [{ type: "tool_call", id: "call_1", name: "shell" }],
    });
    expect(ir.messages[2]).toMatchObject({
      role: "user",
      parts: [{ type: "tool_result", toolCallId: "call_1", content: "a.txt" }],
    });
  });

  it("builds a Responses request from an Anthropic request", () => {
    const ir = anthropicCodec.parseRequest({
      model: "claude-x",
      system: "be terse",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "shell", input_schema: { type: "object" } }],
    });
    const body = openAiResponsesCodec.buildRequestBody(ir, "resp-model");

    expect(body.model).toBe("resp-model");
    expect(body.instructions).toBe("be terse");
    expect(body.max_output_tokens).toBe(64);
    expect(body.tools).toEqual([
      { type: "function", name: "shell", description: undefined, parameters: { type: "object" } },
    ]);
    expect(body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  it("decodes streamed text and function calls", () => {
    const events = decodeAll(openAiResponsesCodec.createStreamDecoder(), [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"shell"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"cmd\\":\\"ls\\"}"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":4}}}\n\n',
    ]);

    expect(events).toContainEqual({ type: "text_delta", text: "Hel" });
    expect(events).toContainEqual({ type: "tool_call_start", id: "call_1", name: "shell" });
    expect(events).toContainEqual({ type: "tool_args_delta", id: "call_1", args: '{"cmd":"ls"}' });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 3, outputTokens: 4 } });
    expect(events).toContainEqual({ type: "stop", reason: "end_turn" });
  });

  it("encodes IR events as Responses SSE", () => {
    const output = encodeAll(openAiResponsesCodec.createStreamEncoder("resp-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "end_turn" },
    ]);

    expect(output).toContain("event: response.created");
    expect(output).toContain("event: response.output_text.delta");
    expect(output).toContain('"delta":"hi"');
    expect(output).toContain("event: response.completed");
  });

  it("builds a Responses body from an IR response", () => {
    const response = openAiChatCodec.parseResponse({
      id: "chatcmpl-1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
    const body = openAiResponsesCodec.buildResponseBody(response, "resp-model");

    expect(body).toMatchObject({
      object: "response",
      status: "completed",
      model: "resp-model",
      output: [{ type: "function_call", call_id: "call_1", name: "shell" }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });
});

describe("Gemini codec", () => {
  it("parses contents, system instruction and tools", () => {
    const ir = geminiCodec.parseRequest({
      systemInstruction: { parts: [{ text: "be terse" }] },
      contents: [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "shell", response: { output: "a.txt" } } }],
        },
      ],
      tools: [{ functionDeclarations: [{ name: "shell", parameters: { type: "object" } }] }],
      generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
    });

    expect(ir.system).toBe("be terse");
    expect(ir.maxTokens).toBe(64);
    expect(ir.temperature).toBe(0.2);
    expect(ir.messages[1]).toMatchObject({
      role: "assistant",
      parts: [{ type: "tool_call", name: "shell", arguments: '{"cmd":"ls"}' }],
    });
    expect(ir.messages[2]).toMatchObject({
      role: "user",
      parts: [{ type: "tool_result", toolCallId: "shell" }],
    });
    expect(ir.tools).toHaveLength(1);
  });

  it("builds a Gemini request from an Anthropic request", () => {
    const ir = anthropicCodec.parseRequest({
      model: "claude-x",
      system: "be terse",
      max_tokens: 32,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "shell", input: { cmd: "ls" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }],
        },
      ],
    });
    const body = geminiCodec.buildRequestBody(ir, "gemini-model");

    expect(body.systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(body.generationConfig).toMatchObject({ maxOutputTokens: 32 });
    const contents = body.contents as Record<string, unknown>[];
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "hello" }] });
    expect(contents[1]).toMatchObject({
      role: "model",
      parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }],
    });
    expect(contents[2]).toMatchObject({
      role: "user",
      parts: [{ functionResponse: { name: "t1" } }],
    });
  });

  it("decodes a streamed Gemini chunk", () => {
    const events = decodeAll(geminiCodec.createStreamDecoder(), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]},"index":0}]}\n\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2}}\n\n',
    ]);

    expect(events.filter((event) => event.type === "text_delta")).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
    ]);
    expect(events).toContainEqual({ type: "stop", reason: "end_turn" });
    expect(events).toContainEqual({ type: "usage", usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it("keeps thought parts out of the reply text", () => {
    const events = decodeAll(geminiCodec.createStreamDecoder(), [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"weighing","thought":true},{"text":"hi"}]},"index":0}]}\n\n',
    ]);
    expect(events).toEqual([
      { type: "thinking_delta", text: "weighing" },
      { type: "text_delta", text: "hi" },
    ]);

    const response = geminiCodec.parseResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "weighing", thought: true }, { text: "hi" }],
          },
          finishReason: "STOP",
        },
      ],
    });
    expect(response.parts).toEqual([
      { type: "thinking", text: "weighing" },
      { type: "text", text: "hi" },
    ]);
  });

  it("encodes IR events as Gemini SSE", () => {
    const output = encodeAll(geminiCodec.createStreamEncoder("gemini-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "end_turn" },
    ]);
    const frames = output
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => {
        const parsed: unknown = JSON.parse(frame.slice("data: ".length));
        return isRecord(parsed) ? parsed : {};
      });

    expect(frames[0]).toMatchObject({ candidates: [{ content: { parts: [{ text: "hi" }] } }] });
    expect(frames[1]).toMatchObject({ candidates: [{ finishReason: "STOP" }] });
  });
});

describe("closing a stream after the last usage", () => {
  const finalUsage: IrEvent = { type: "usage", usage: { inputTokens: 3, outputTokens: 9 } };

  function dataFrames(output: string): Record<string, unknown>[] {
    const frames: Record<string, unknown>[] = [];
    for (const frame of output.split("\n\n")) {
      const line = frame.split("\n").find((part) => part.startsWith("data: "));
      if (line === undefined) continue;
      try {
        const parsed: unknown = JSON.parse(line.slice("data: ".length));
        if (isRecord(parsed)) frames.push(parsed);
      } catch {
        // `[DONE]` and other non-JSON frames.
      }
    }
    return frames;
  }

  it("keeps OpenAI's usage before [DONE] and its stop reason in the last chunk", () => {
    const output = encodeAll(openAiChatCodec.createStreamEncoder("oai-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "max_tokens" },
      finalUsage,
    ]);

    expect(output.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(output.indexOf('"usage"')).toBeLessThan(output.indexOf("data: [DONE]"));
    expect(output).toContain('"finish_reason":"length"');
  });

  it("carries Anthropic's final output_tokens in message_delta", () => {
    const output = encodeAll(anthropicCodec.createStreamEncoder("claude-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "end_turn" },
      finalUsage,
    ]);
    const delta = dataFrames(output).find((frame) => frame.type === "message_delta");
    expect(delta?.usage).toMatchObject({ output_tokens: 9 });
    expect(output.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it("carries Gemini's final usage in the closing frame", () => {
    const output = encodeAll(geminiCodec.createStreamEncoder("gemini-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "end_turn" },
      finalUsage,
    ]);
    const frames = dataFrames(output);
    expect(frames[frames.length - 1]).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { candidatesTokenCount: 9 },
    });
  });

  it("carries Responses' final usage in response.completed", () => {
    const output = encodeAll(openAiResponsesCodec.createStreamEncoder("resp-model"), [
      { type: "text_delta", text: "hi" },
      { type: "stop", reason: "end_turn" },
      finalUsage,
    ]);
    const completed = dataFrames(output).find((frame) => frame.type === "response.completed");
    expect(completed).toMatchObject({ response: { usage: { output_tokens: 9 } } });
  });
});

describe("usage the vendors count beside the prompt", () => {
  it("reads Anthropic cache reads and writes, apart from input", () => {
    const response = anthropicCodec.parseResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 8,
      },
    });

    expect(response.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 40,
      cacheWriteTokens: 8,
    });
  });

  it("reads the cache writes Anthropic kept for an hour apart", () => {
    const response = anthropicCodec.parseResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cache_creation_input_tokens: 8,
        cache_creation: {
          ephemeral_5m_input_tokens: 5,
          ephemeral_1h_input_tokens: 3,
        },
      },
    });

    expect(response.usage).toMatchObject({ cacheWriteTokens: 8, cacheWrite1hTokens: 3 });
  });

  it("reads the OpenAI cache reads counted in prompt tokens", () => {
    const response = openAiChatCodec.parseResponse({
      id: "chatcmpl-1",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    });

    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      reasoningTokens: 5,
    });
  });

  it("adds nothing when the vendor reports no cache", () => {
    const response = geminiCodec.parseResponse({
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
    });

    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 2 });
  });
});
