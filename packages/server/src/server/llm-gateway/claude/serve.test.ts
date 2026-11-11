import { describe, expect, it } from "vitest";
import { claudeJsonSchema, claudeTurnRequest, defaultClaudeConfigDir } from "./serve.js";

describe("claudeTurnRequest", () => {
  it("reads the caller's instructions and messages", () => {
    const request = claudeTurnRequest({
      system: [
        { type: "text", text: "be brief" },
        { type: "text", text: "and kind" },
      ],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    });
    expect(request.system).toBe("be brief\n\nand kind");
    expect(request.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "hello" }] },
    ]);
  });

  it("keeps the caller's tool calls and their results", () => {
    const request = claudeTurnRequest({
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "contents" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    expect(request.messages[1]?.parts).toEqual([
      { kind: "toolCall", id: "toolu_1", name: "read", arguments: '{"path":"a"}' },
    ]);
    expect(request.messages[2]?.parts).toEqual([
      { kind: "toolResult", callId: "toolu_1", text: "contents", isError: false },
      { kind: "text", text: "thanks" },
    ]);
  });

  it("offers the caller's tools with their schemas", () => {
    const request = claudeTurnRequest({
      messages: [],
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
    });
    expect(request.tools).toEqual([
      { name: "read", description: "Read a file", inputSchema: { type: "object" } },
    ]);
  });

  it("ignores what it cannot read", () => {
    expect(claudeTurnRequest(null)).toEqual({ messages: [] });
    expect(
      claudeTurnRequest({ messages: [{ role: "system", content: "x" }, { role: "user" }] }),
    ).toEqual({ messages: [{ role: "user", parts: [] }] });
  });
});

describe("claudeJsonSchema", () => {
  it("takes the schema the caller asked its answer to fit", () => {
    expect(
      claudeJsonSchema({ type: "json_schema", name: "answer", schema: { type: "object" } }),
    ).toBe('{"type":"object"}');
  });

  it("has none when the caller asked for no schema", () => {
    expect(claudeJsonSchema(null)).toBeUndefined();
    expect(claudeJsonSchema({ type: "json_object", name: "answer" })).toBeUndefined();
  });
});

describe("defaultClaudeConfigDir", () => {
  it("uses a saved account's own directory", () => {
    expect(defaultClaudeConfigDir("/neolix/claude-accounts/a")).toBe("/neolix/claude-accounts/a");
  });
});
