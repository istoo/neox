import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import { geminiCodec } from "./gemini-codec.js";

const DATA = "EmwKAhgBEgy3YQ2x1Y2tldA";

describe("redacted thinking", () => {
  it("goes back to Anthropic as it came", () => {
    const reply = anthropicCodec.parseResponse({
      content: [{ type: "redacted_thinking", data: DATA }],
    });
    expect(reply.parts).toEqual([{ type: "thinking", text: "", redacted: DATA }]);
    const body = anthropicCodec.buildResponseBody(reply, "m");
    expect(body.content).toEqual([{ type: "redacted_thinking", data: DATA }]);
    const request = anthropicCodec.parseRequest({ messages: [] });
    request.messages.push({ role: "assistant", parts: reply.parts });
    expect(JSON.stringify(anthropicCodec.buildRequestBody(request, "m"))).toContain(DATA);
  });

  it("survives the stream", () => {
    const decoder = anthropicCodec.createStreamDecoder();
    const events = decoder.push(
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"' +
        DATA +
        '"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    );
    expect(events).toEqual([{ type: "redacted_thinking", data: DATA }]);
    const encoder = anthropicCodec.createStreamEncoder("m");
    const stream = encoder.start() + encoder.push({ type: "redacted_thinking", data: DATA });
    expect(stream).toContain('"type":"redacted_thinking"');
    expect(stream).toContain(DATA);
  });

  it("is dropped for a vendor that has no block for it", () => {
    const reply = openAiResponsesCodec.parseResponse({ output: [] });
    reply.parts.push({ type: "thinking", text: "", redacted: DATA });
    expect(JSON.stringify(openAiResponsesCodec.buildResponseBody(reply, "m"))).not.toContain(DATA);
    const chat = openAiChatCodec.parseResponse({ choices: [] });
    chat.parts.push({ type: "thinking", text: "", redacted: DATA });
    expect(JSON.stringify(openAiChatCodec.buildResponseBody(chat, "m"))).not.toContain(DATA);
    const gemini = geminiCodec.parseResponse({ candidates: [] });
    gemini.parts.push({ type: "thinking", text: "", redacted: DATA });
    expect(JSON.stringify(geminiCodec.buildResponseBody(gemini, "m"))).not.toContain(DATA);
  });
});
