import { describe, expect, it } from "vitest";
import {
  FenceHold,
  formatInstruction,
  parseAnthropicFormat,
  parseGeminiFormat,
  parseOpenAiFormat,
  unfence,
  unfenceResponse,
  wantsStructuredOutput,
} from "./format.js";
import { anthropicCodec } from "./anthropic-codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { emptyRequest } from "./ir.js";

describe("structured output", () => {
  it("reads a format from each client API", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    expect(
      parseOpenAiFormat({
        type: "json_schema",
        json_schema: { name: "out", schema, strict: true },
      }),
    ).toEqual({ type: "json_schema", name: "out", schema, strict: true });
    expect(parseOpenAiFormat({ type: "json_object" })).toEqual({
      type: "json_object",
      name: "response",
    });
    expect(parseAnthropicFormat({ type: "json_schema", schema })).toEqual({
      type: "json_schema",
      name: "response",
      schema,
    });
    expect(
      parseGeminiFormat({ responseMimeType: "application/json", responseSchema: schema }),
    ).toEqual({ type: "json_schema", name: "response", schema });
    expect(parseGeminiFormat({ responseMimeType: "text/plain" })).toBeNull();
  });

  it("asks a translated provider for the format in its own words", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const chat = { response_format: { type: "json_schema", json_schema: { name: "o", schema } } };
    const parsed = openAiChatCodec.parseRequest(chat);
    const anthropic = anthropicCodec.buildRequestBody(parsed, "m");
    expect(anthropic.output_config).toEqual({ format: { type: "json_schema", schema } });
    expect(String(anthropic.system ?? "")).not.toContain("JSON schema");

    const object = openAiChatCodec.parseRequest({ response_format: { type: "json_object" } });
    const anthropicObject = anthropicCodec.buildRequestBody(object, "m");
    expect(anthropicObject.output_config).toBeUndefined();
    expect(String(anthropicObject.system)).toContain("single JSON object");

    const fromAnthropic = anthropicCodec.parseRequest({
      output_config: { format: { type: "json_schema", schema } },
    });
    const chatBody = openAiChatCodec.buildRequestBody(fromAnthropic, "m");
    expect(chatBody.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
  });

  it("takes a fence off a whole JSON answer only", () => {
    expect(unfence('```json\n{"a":1}\n```')).toEqual({ text: '{"a":1}', fenced: true });
    expect(unfence('```\n{"a":1}\n```')).toEqual({ text: '{"a":1}', fenced: true });
    expect(unfence("```ts\nconst a = 1\n```").fenced).toBe(false);
    expect(unfence('```json\n{"a":1').fenced).toBe(false);
    expect(unfence('{"a":1}').fenced).toBe(false);
    expect(unfence("```json\nnot json\n```").fenced).toBe(false);

    const response = {
      ...empty(),
      parts: [{ type: "text" as const, text: '```json\n{"a":1}\n```' }],
    };
    expect(unfenceResponse(response).parts).toEqual([{ type: "text", text: '{"a":1}' }]);
  });

  it("holds a streamed answer until it is no fence", () => {
    const hold = new FenceHold();
    expect(hold.push("``")).toBe("");
    expect(hold.push('`json\n{"a":')).toBe("");
    expect(hold.push("1}\n```")).toBe("");
    expect(hold.flush()).toBe('{"a":1}');

    const plain = new FenceHold();
    expect(plain.push("{")).toBe("{");
    expect(plain.push('"a":1}')).toBe('"a":1}');
  });

  it("knows a client that asked for structured output", () => {
    expect(wantsStructuredOutput("openai", { response_format: { type: "json_object" } })).toBe(
      true,
    );
    expect(
      wantsStructuredOutput("openai-responses", { text: { format: { type: "json_object" } } }),
    ).toBe(true);
    expect(
      wantsStructuredOutput("anthropic", {
        output_config: { format: { type: "json_schema", schema: {} } },
      }),
    ).toBe(true);
    expect(
      wantsStructuredOutput("gemini", {
        generationConfig: { responseMimeType: "application/json" },
      }),
    ).toBe(true);
    expect(wantsStructuredOutput("openai", {})).toBe(false);
    expect(formatInstruction({ type: "json_object", name: "response" })).toContain(
      "single JSON object",
    );
  });
});

describe("thinking signatures", () => {
  it("keeps Anthropic's signature through a translated turn", () => {
    const parsed = anthropicCodec.parseResponse({
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "sig-1" },
        { type: "text", text: "ok" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(parsed.parts[0]).toEqual({ type: "thinking", text: "plan", signature: "sig-1" });

    const replay = anthropicCodec.buildRequestBody(
      {
        ...emptyRequest(),
        messages: [{ role: "assistant", parts: parsed.parts }],
      },
      "m",
    );
    expect(JSON.stringify(replay.messages)).toContain('"signature":"sig-1"');

    // A thinking block with no signature is no history to Anthropic.
    const unsigned = anthropicCodec.buildRequestBody(
      {
        ...emptyRequest(),
        messages: [{ role: "assistant", parts: [{ type: "thinking", text: "plan" }] }],
      },
      "m",
    );
    expect(JSON.stringify(unsigned.messages)).not.toContain("plan");
  });

  it("passes a streamed signature on to a Messages client", () => {
    const decoder = anthropicCodec.createStreamDecoder();
    const frames = [
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}\n\n',
    ];
    const events = frames.flatMap((frame) => decoder.push(frame));
    const signatures = events.filter((event) => event.type === "signature_delta");
    expect(signatures).toEqual([{ type: "signature_delta", signature: "sig-1" }]);

    const encoder = anthropicCodec.createStreamEncoder("m");
    const out = [
      encoder.start(),
      ...events.map((event) => encoder.push(event)),
      encoder.end(),
    ].join("");
    expect(out).toContain('"signature_delta"');
    expect(out).toContain('"signature":""');
  });
});

function empty() {
  return {
    id: null,
    parts: [],
    stopReason: "end_turn" as const,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
