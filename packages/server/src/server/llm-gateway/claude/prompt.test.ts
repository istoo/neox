import { describe, expect, it } from "vitest";
import { bridgeToolName } from "./tools.js";
import {
  callsTool,
  historyEnd,
  renderClaudePrompt,
  renderClaudeTurn,
  resolveCalledTool,
  type ClaudePromptMessage,
} from "./prompt.js";

const msg = (role: "user" | "assistant", text: string): ClaudePromptMessage => ({
  role,
  parts: [{ kind: "text", text }],
});

describe("historyEnd", () => {
  it("splits after the last reply that calls no tool", () => {
    expect(historyEnd([msg("user", "hi"), msg("assistant", "hello"), msg("user", "next")])).toBe(2);
    expect(historyEnd([msg("user", "hi")])).toBe(0);
    expect(historyEnd([msg("user", "hi"), msg("assistant", "hello")])).toBe(0);
  });

  it("treats a reply that calls a tool as part of the turn", () => {
    const call: ClaudePromptMessage = {
      role: "assistant",
      parts: [{ kind: "toolCall", id: "c1", name: "read", arguments: "{}" }],
    };
    expect(callsTool(call)).toBe(true);
    expect(historyEnd([msg("user", "hi"), call, msg("user", "result")])).toBe(0);
  });
});

describe("renderClaudePrompt", () => {
  it("keeps the caller's instructions as content with the cache mark", () => {
    const blocks = renderClaudePrompt({
      system: "be brief",
      messages: [msg("user", "hi")],
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toContain("<external_system_instructions>");
    expect(blocks[0]?.text).toContain("be brief");
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1]?.text).toContain("Human: hi");
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it("wraps answered turns and marks the one to answer", () => {
    const blocks = renderClaudePrompt({
      messages: [msg("user", "hi"), msg("assistant", "hello"), msg("user", "next")],
    });
    const text = blocks.map((block) => block.text).join("");
    expect(text).toContain("<conversation_history>");
    expect(text).toContain("Human: hi\n\nAssistant: hello\n\n");
    expect(text).toContain("</conversation_history>");
    expect(text).toContain("<current_turn>\nThe turn to answer now:\n\nHuman: next");
    expect(text).toContain("</current_turn>");
  });

  it("tells past tool calls and results as text", () => {
    const blocks = renderClaudePrompt({
      tools: [{ name: "read" }],
      messages: [
        { role: "user", parts: [{ kind: "text", text: "read it" }] },
        {
          role: "assistant",
          parts: [{ kind: "toolCall", id: "c1", name: "read", arguments: '{"path":"a"}' }],
        },
        {
          role: "user",
          parts: [
            { kind: "toolResult", callId: "c1", text: "contents" },
            { kind: "text", text: "thanks" },
          ],
        },
      ],
    });
    const text = blocks.map((block) => block.text).join("");
    expect(text).toContain('[tool call mcp__neox__read id=c1 args={"path":"a"}]');
    expect(text).toContain("[tool result id=c1]\ncontents\n[end of tool result id=c1]");
    expect(text).toContain("call a tool only with the tool itself");
  });

  it("never leaves an empty prompt", () => {
    const blocks = renderClaudePrompt({ messages: [] });
    expect(blocks).toEqual([{ type: "text", text: "[continue]" }]);
  });
});

describe("renderClaudePrompt with the client's marks", () => {
  const cache = (system: Array<{ end: number; ttl: "5m" | "1h" }>, messages = new Map()) => ({
    system,
    messages,
    tools: 0,
    dropped: 0,
  });

  it("splits the instructions where the client marked them", () => {
    const blocks = renderClaudePrompt(
      { system: "be brief", messages: [msg("user", "hi")] },
      cache([{ end: 3, ttl: "1h" }]),
    );
    expect(blocks[0]?.text.endsWith("be ")).toBe(true);
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(blocks[1]?.text.startsWith("brief")).toBe(true);
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it("splits a message where the client marked it", () => {
    const marked = new Map([[0, [{ end: 1, ttl: "5m" as const }]]]);
    const blocks = renderClaudePrompt({ messages: [msg("user", "hi")] }, cache([], marked));
    const markedBlock = blocks.find((block) => block.cache_control?.ttl === "5m");
    expect(markedBlock?.text.endsWith("h")).toBe(true);
  });

  it("leaves the bridge's own mark when the client made none", () => {
    const blocks = renderClaudePrompt(
      { system: "be brief", messages: [msg("user", "hi")] },
      cache([]),
    );
    expect(blocks[0]?.cache_control).toBeUndefined();
  });
});

describe("renderClaudeTurn", () => {
  it("tells only the messages since the reply the run had", () => {
    const blocks = renderClaudeTurn(
      [msg("user", "next"), { role: "assistant", parts: [{ kind: "text", text: "on it" }] }],
      [],
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("Human: next\n\nAssistant: on it\n\n");
  });
});

describe("resolveCalledTool", () => {
  it("maps a name Claude Code had to change back to the caller's", () => {
    const tools = [{ name: "spawn.agent" }, { name: "read" }];
    const hashed = bridgeToolName("spawn.agent");
    expect(resolveCalledTool(tools, `mcp__neox__${hashed}`)).toBe("spawn.agent");
    expect(resolveCalledTool(tools, "mcp__neox__read")).toBe("read");
  });
});
