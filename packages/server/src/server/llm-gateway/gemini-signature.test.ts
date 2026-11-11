import { describe, expect, it } from "vitest";
import { SKIP_SIGNATURE, signCallId, unsignCallId } from "./gemini-signature.js";
import { isGeminiCompat, withGeminiCallSignatures } from "./gemini-compat.js";
import { geminiCodec } from "./gemini-codec.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { anthropicCodec } from "./anthropic-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";

const SIGNATURE = "sig+with/non-canonical chars";

describe("Gemini's thought signatures", () => {
  it("round-trips a signature in the call's id", () => {
    const signed = signCallId("call_1", SIGNATURE);
    expect(signed.startsWith("call_1__tsr")).toBe(true);
    expect(unsignCallId(signed)).toEqual({ id: "call_1", signature: SIGNATURE });
    expect(unsignCallId("call_1")).toEqual({ id: "call_1", signature: null });
  });

  it("keeps a canonical base64 signature as its own bytes", () => {
    const signature = Buffer.from("thinking", "utf8").toString("base64");
    const signed = signCallId("call_2", signature);
    expect(signed.startsWith("call_2__ts")).toBe(true);
    expect(signed.startsWith("call_2__tsr")).toBe(false);
    expect(unsignCallId(signed)).toEqual({ id: "call_2", signature });
  });

  it("reads a cut signature as none", () => {
    const signed = signCallId("call_3", SIGNATURE);
    const cut = signed.slice(0, signed.length - 3);
    const split = unsignCallId(cut);
    expect(split.signature).toBeNull();
    expect(split.id).toBe(cut);
    // A plain id that happens to hold the mark is its own.
    expect(unsignCallId("call__ts__4")).toEqual({ id: "call__ts__4", signature: null });
  });

  it("carries the signature in the ids a client sees, and takes it back", () => {
    const signed = signCallId("call_1", SIGNATURE);
    // A Chat client: the reply's id carries it, and the next request gives it back.
    const chatReply = openAiChatCodec.parseResponse({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    chatReply.parts[0] = { ...chatReply.parts[0], signature: SIGNATURE } as never;
    const chatBody = openAiChatCodec.buildResponseBody(chatReply, "m");
    expect(JSON.stringify(chatBody)).toContain(signed);
    const chatBack = openAiChatCodec.parseRequest({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: signed, type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
      ],
    });
    expect(chatBack.messages[0]?.parts[0]).toMatchObject({ id: "call_1", signature: SIGNATURE });

    // Anthropic and Responses read the id a client gives back the same way.
    const anthropicBack = anthropicCodec.parseRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: signed, name: "read", input: {} }],
        },
      ],
    });
    expect(anthropicBack.messages[0]?.parts[0]).toMatchObject({
      id: "call_1",
      signature: SIGNATURE,
    });
    const responsesBack = openAiResponsesCodec.parseRequest({
      input: [{ type: "function_call", call_id: signed, name: "read", arguments: "{}" }],
    });
    expect(responsesBack.messages[0]?.parts[0]).toMatchObject({
      id: "call_1",
      signature: SIGNATURE,
    });
    // Their replies to the client carry it in the id too.
    const anthropicReply = anthropicCodec.parseResponse({ content: [] });
    anthropicReply.parts.push({
      type: "tool_call",
      id: "call_1",
      name: "read",
      arguments: "{}",
      signature: SIGNATURE,
    });
    expect(JSON.stringify(anthropicCodec.buildResponseBody(anthropicReply, "m"))).toContain(signed);
    const responsesReply = openAiResponsesCodec.parseResponse({ output: [] });
    responsesReply.parts.push({
      type: "tool_call",
      id: "call_1",
      name: "read",
      arguments: "{}",
      signature: SIGNATURE,
    });
    expect(JSON.stringify(openAiResponsesCodec.buildResponseBody(responsesReply, "m"))).toContain(
      signed,
    );
    // A request to another upstream gives the id the call had.
    const plain = anthropicCodec.parseRequest({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: signed, name: "read", input: {} }],
        },
      ],
    });
    expect(JSON.stringify(anthropicCodec.buildRequestBody(plain, "m"))).not.toContain("__ts");
  });

  it("reads and writes Gemini's own field", () => {
    const response = geminiCodec.parseResponse({
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "read", args: {} }, thoughtSignature: SIGNATURE }],
          },
        },
      ],
    });
    expect(response.parts[0]).toMatchObject({ type: "tool_call", signature: SIGNATURE });

    const request = geminiCodec.parseRequest({ contents: [] });
    request.messages.push({
      role: "assistant",
      parts: [
        { type: "tool_call", id: "call_1", name: "read", arguments: "{}", signature: SIGNATURE },
      ],
    });
    request.messages.push({
      role: "assistant",
      parts: [{ type: "tool_call", id: "call_2", name: "write", arguments: "{}" }],
    });
    const built = geminiCodec.buildRequestBody(request, "m");
    const parts = JSON.stringify(built);
    expect(parts).toContain(`"thoughtSignature":"${SIGNATURE}"`);
    expect(parts).toContain(`"thoughtSignature":"${SKIP_SIGNATURE}"`);
  });

  it("moves a Chat id's signature to Gemini's extra_content", () => {
    expect(isGeminiCompat("https://generativelanguage.googleapis.com/v1beta/openai")).toBe(true);
    expect(isGeminiCompat("https://api.openai.com/v1")).toBe(false);
    const signed = signCallId("call_1", SIGNATURE);
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { id: signed, type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: signed, content: "x" },
      ],
    };
    const fitted = withGeminiCallSignatures(body, unsignCallId);
    const messages = fitted.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "read", arguments: "{}" },
        extra_content: { google: { thought_signature: SIGNATURE } },
      },
    ]);
    expect(messages[1]?.tool_call_id).toBe("call_1");
    const plain = { messages: [{ role: "user", content: "hi" }] };
    expect(withGeminiCallSignatures(plain, unsignCallId)).toBe(plain);
  });
});
