import { describe, expect, it } from "vitest";
import {
  fillThinkingBack,
  markNeedsThinkingBack,
  needsThinkingBack,
  refusedThinkingBack,
} from "./thinking-back.js";

describe("thinking back", () => {
  it("reads the refusals", () => {
    expect(
      refusedThinkingBack(
        "The `content[].thinking` in the thinking mode must be passed back to the API.",
      ),
    ).toBe(true);
    expect(refusedThinkingBack("reasoning_content is required")).toBe(true);
    expect(refusedThinkingBack("Invalid request body")).toBe(false);
  });

  it("fills an Anthropic tool turn with a space", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "t1", name: "read", input: {} },
          ],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
      ],
    };
    const { changed, body: filled } = fillThinkingBack("anthropic", body);
    expect(changed).toBe(true);
    const assistant = (
      filled.messages as Array<{ content: Array<{ type: string; thinking?: string }> }>
    )[1];
    expect(assistant?.content[0]).toEqual({ type: "thinking", thinking: " " });
    // A turn that thinks already is left as it is.
    const already = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "tool_use", id: "t1", name: "read", input: {} },
          ],
        },
      ],
    };
    expect(fillThinkingBack("anthropic", already).changed).toBe(false);
  });

  it("fills a Chat tool call's reasoning_content", () => {
    const body = {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function" }] },
        { role: "tool", tool_call_id: "c1", content: "x" },
      ],
    };
    const { changed, body: filled } = fillThinkingBack("openai", body);
    expect(changed).toBe(true);
    const message = (filled.messages as Array<Record<string, unknown>>)[0];
    expect(message.reasoning_content).toBe(" ");
    const kept = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "c1" }],
          reasoning_content: "why",
          reasoning: "why",
        },
      ],
    };
    expect(fillThinkingBack("openai", kept).changed).toBe(false);
  });

  it("learns that a provider needs it", () => {
    expect(needsThinkingBack("p", "m", "anthropic")).toBe(false);
    markNeedsThinkingBack("p", "m", "anthropic");
    expect(needsThinkingBack("p", "m", "anthropic")).toBe(true);
    expect(needsThinkingBack("p", "m", "openai")).toBe(false);
  });
});
