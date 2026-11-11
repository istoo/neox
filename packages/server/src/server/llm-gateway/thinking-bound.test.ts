import { describe, expect, it } from "vitest";
import {
  BoundThinking,
  boundBlockAt,
  refuseBoundThinking,
  refusedBoundThinking,
  thinkingKey,
  withoutForeignThinking,
  withoutRefusedThinking,
  withoutThinkingBlocks,
} from "./thinking-bound.js";

const REFUSAL =
  "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.";

function thinking(signature: string): Record<string, unknown> {
  return { type: "thinking", thinking: "hmm", signature };
}

function bodyOf(messages: unknown[]): Record<string, unknown> {
  return { model: "claude-sonnet-5-5", messages };
}

describe("thinking bound to another conversation", () => {
  it("reads Claude's refusal and where it says the block is", () => {
    expect(refusedBoundThinking(REFUSAL)).toBe(true);
    expect(refusedBoundThinking("invalid data in `redacted_thinking` block")).toBe(true);
    expect(refusedBoundThinking("rate limit exceeded")).toBe(false);
    expect(boundBlockAt(REFUSAL)).toEqual({ message: 1, block: 0 });
    expect(boundBlockAt("bound to a different conversation")).toBeNull();
  });

  it("names a block by its signature, sealed data or text", () => {
    const key = thinkingKey(thinking("sig-a"));
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(thinkingKey(thinking("sig-a"))).toBe(key);
    expect(thinkingKey(thinking("sig-b"))).not.toBe(key);
    expect(thinkingKey({ type: "redacted_thinking", data: "sig-a" })).not.toBe(key);
    expect(thinkingKey({ type: "thinking", thinking: "hmm" })).toBe(
      thinkingKey({ type: "thinking", thinking: "hmm" }),
    );
  });

  it("leaves out the blocks it is told to, and a message left empty", () => {
    const body = bodyOf([
      { role: "user", content: "hi" },
      { role: "assistant", content: [thinking("sig-a"), { type: "text", text: "one" }] },
      { role: "assistant", content: [thinking("sig-b")] },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
    ]);
    const told = withoutThinkingBlocks(body, (_m, _b, block) => block.signature !== undefined);
    expect(told.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "one" }] },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
    ]);
    expect(withoutThinkingBlocks(body, () => false)).toBe(body);
  });

  it("remembers the named block and every thinking block after it", () => {
    const body = bodyOf([
      { role: "assistant", content: [thinking("before")] },
      { role: "assistant", content: [thinking("named"), { type: "text", text: "said" }] },
      { role: "assistant", content: [thinking("after")] },
      { role: "user", content: "next" },
    ]);
    const refused = new BoundThinking();
    const owner = "pool\u0000account";
    expect(refuseBoundThinking({ owner, errorText: REFUSAL, body, refused })).toBe(true);
    expect(refused.refusedBefore(owner, thinkingKey(thinking("before")))).toBe(false);
    expect(refused.refusedBefore(owner, thinkingKey(thinking("named")))).toBe(true);
    expect(refused.refusedBefore(owner, thinkingKey(thinking("after")))).toBe(true);

    const again = withoutRefusedThinking(owner, body, refused);
    expect(again.messages).toEqual([
      { role: "assistant", content: [thinking("before")] },
      { role: "assistant", content: [{ type: "text", text: "said" }] },
      { role: "user", content: "next" },
    ]);
    // A body whose thinking blocks are all refused already has nothing
    // new to remember.
    refused.refuse(owner, [
      thinkingKey(thinking("before")),
      thinkingKey(thinking("named")),
      thinkingKey(thinking("after")),
    ]);
    expect(refuseBoundThinking({ owner, errorText: REFUSAL, body, refused })).toBe(false);
    // Another provider or account is not affected.
    expect(withoutRefusedThinking("other\u0000account", body, refused)).toBe(body);
  });

  it("leaves DeepSeek's UUID-signed thinking out of a request to Claude", () => {
    const uuid = "0b9d3f0e-6a1c-4a52-9f0e-3c2d1a4b5c6d";
    const claudeSignature = "EqQBCkYIBRgCKkA" + "a".repeat(700);
    const body = bodyOf([
      {
        role: "assistant",
        content: [thinking(uuid), thinking(claudeSignature), { type: "text", text: "hi" }],
      },
    ]);
    const sent = withoutForeignThinking("api.anthropic.com", "claude-sonnet-5-5", body);
    expect(sent.messages).toEqual([
      {
        role: "assistant",
        content: [thinking(claudeSignature), { type: "text", text: "hi" }],
      },
    ]);
    // DeepSeek's own endpoint gets the body as it was, and so does a body
    // to another vendor for another model.
    expect(withoutForeignThinking("api.deepseek.com", "deepseek-v4", body)).toBe(body);
    expect(withoutForeignThinking("api.example.com", "glm-5", body)).toBe(body);
  });
});
