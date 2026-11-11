import { describe, expect, it } from "vitest";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import {
  isClaudeSeal,
  openSealedThinking,
  reasoningItem,
  sealThinking,
  thinkingOfReasoningItem,
  withoutClaudeSeals,
} from "./claude-seal.js";

describe("Claude's sealed reasoning", () => {
  it("seals and opens a signed thinking block", () => {
    const sealed = sealThinking("plan", "sig");
    expect(isClaudeSeal(sealed)).toBe(true);
    expect(openSealedThinking(sealed)).toEqual({ text: "plan", signature: "sig" });
    expect(openSealedThinking("gAAAAB")).toBeNull();
    expect(openSealedThinking("neolix-claude1:notbase64!")).toBeNull();
  });

  it("travels through a Responses client's request and reply", () => {
    const request = openAiResponsesCodec.parseRequest({ input: "hi" });
    request.messages.push({
      role: "assistant",
      parts: [{ type: "thinking", text: "plan", signature: "sig" }],
    });
    const body = openAiResponsesCodec.buildRequestBody(request, "m");
    const item = (body.input as Array<Record<string, unknown>>).at(-1);
    expect(item?.type).toBe("reasoning");
    expect(openSealedThinking(item?.encrypted_content)).toEqual({ text: "plan", signature: "sig" });

    const parsed = openAiResponsesCodec.parseRequest({ input: [item] });
    expect(parsed.messages[0]?.parts).toEqual([
      { type: "thinking", text: "plan", signature: "sig" },
    ]);

    const reply = openAiResponsesCodec.parseResponse({ output: [] });
    reply.parts.push({ type: "thinking", text: "plan", signature: "sig" });
    const built = openAiResponsesCodec.buildResponseBody(reply, "m");
    const output = built.output as Array<Record<string, unknown>>;
    expect(output[0]?.type).toBe("reasoning");
    expect(openSealedThinking(output[0]?.encrypted_content)).toEqual({
      text: "plan",
      signature: "sig",
    });
  });

  it("drops its seals before a Responses upstream", () => {
    const kept = reasoningItem("plan", "sig", "rs_1");
    kept.summary = [{ type: "summary_text", text: "plan" }];
    const body = {
      input: [
        { type: "message", role: "user", content: "hi" },
        kept,
        { type: "reasoning", id: "rs_2", summary: [], encrypted_content: sealThinking("", "sig") },
        { type: "reasoning", id: "rs_3", encrypted_content: "gAAAAB" },
      ],
    };
    const fitted = withoutClaudeSeals(body);
    const input = fitted.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[1]?.encrypted_content).toBeUndefined();
    expect(input[1]?.summary).toEqual([{ type: "summary_text", text: "plan" }]);
    expect(input[2]).toEqual({ type: "reasoning", id: "rs_3", encrypted_content: "gAAAAB" });
    const plain = { input: [{ type: "message" }] };
    expect(withoutClaudeSeals(plain)).toBe(plain);
  });

  it("streams the reasoning item with its block sealed", () => {
    const encoder = openAiResponsesCodec.createStreamEncoder("m");
    const stream =
      encoder.start() +
      encoder.push({ type: "thinking_delta", text: "plan" }) +
      encoder.push({ type: "signature_delta", signature: "sig" }) +
      encoder.push({ type: "text_delta", text: "done" }) +
      encoder.push({ type: "usage", usage: { inputTokens: 1, outputTokens: 2 } }) +
      encoder.push({ type: "stop", reason: "end_turn" }) +
      encoder.end();
    const done = stream
      .split("\n\n")
      .filter((event) => event.includes("response.output_item.done"))
      .map(
        (event) =>
          JSON.parse(event.slice(event.indexOf("data:") + 5).trim()) as Record<string, unknown>,
      );
    const reasoning = done.find(
      (event) => (event.item as Record<string, unknown>).type === "reasoning",
    );
    expect(reasoning).toBeDefined();
    const item = reasoning?.item as Record<string, unknown>;
    expect(openSealedThinking(item.encrypted_content)).toEqual({ text: "plan", signature: "sig" });
    expect(JSON.stringify(reasoning)).toContain("summary_text");
    expect(thinkingOfReasoningItem(item)).toEqual({
      type: "thinking",
      text: "plan",
      signature: "sig",
    });
    // The answer's text item comes after the reasoning item.
    const text = done.find((event) => (event.item as Record<string, unknown>).type === "message");
    expect(text?.output_index).toBe(1);
  });
});
