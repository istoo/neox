import { describe, expect, it } from "vitest";
import { parseClaudeCallbackBody } from "./callback.js";

describe("parseClaudeCallbackBody", () => {
  it("reads the helper's call", () => {
    expect(
      parseClaudeCallbackBody({
        tool_call_id: "toolu_1",
        name: "read",
        arguments: { path: "a" },
      }),
    ).toEqual({ toolCallId: "toolu_1", name: "read", arguments: '{"path":"a"}' });
  });

  it("keeps arguments already written as JSON", () => {
    expect(
      parseClaudeCallbackBody({ tool_call_id: "t", name: "read", arguments: '{"path":"a"}' }),
    ).toEqual({ toolCallId: "t", name: "read", arguments: '{"path":"a"}' });
  });

  it("refuses a body without a call id or name", () => {
    expect(parseClaudeCallbackBody({ name: "read" })).toBeNull();
    expect(parseClaudeCallbackBody({ tool_call_id: "", name: "read" })).toBeNull();
    expect(parseClaudeCallbackBody({ tool_call_id: "t" })).toBeNull();
    expect(parseClaudeCallbackBody(null)).toBeNull();
  });
});
