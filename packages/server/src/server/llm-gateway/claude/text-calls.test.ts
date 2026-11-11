import { describe, expect, it } from "vitest";
import type { ClaudeStreamEvent } from "./stream.js";
import { filterTextCalls, TextCallsFilter } from "./text-calls.js";

async function runFilter(events: readonly ClaudeStreamEvent[]): Promise<ClaudeStreamEvent[]> {
  async function* source(): AsyncGenerator<ClaudeStreamEvent> {
    for (const event of events) {
      yield event;
    }
  }
  const out: ClaudeStreamEvent[] = [];
  for await (const event of filterTextCalls(source())) {
    out.push(event);
  }
  return out;
}

describe("TextCallsFilter", () => {
  it("lets ordinary words through", () => {
    const filter = new TextCallsFilter();
    expect(filter.push("Hello there.\nSecond line.")).toBe("Hello there.\nSecond line.");
    expect(filter.end()).toEqual({ held: "", seen: false });
  });

  it("holds a call written as text from its first line", () => {
    const filter = new TextCallsFilter();
    expect(filter.push("Let me read it.\n[tool call read id=1 args={}]\n")).toBe(
      "Let me read it.\n",
    );
    expect(filter.end()).toEqual({
      held: "[tool call read id=1 args={}]\n",
      seen: true,
    });
  });

  it("waits when a line could still open a call", () => {
    const filter = new TextCallsFilter();
    expect(filter.push("Hi\n[tool ")).toBe("Hi\n");
    expect(filter.push("call read]")).toBe("");
    expect(filter.end().seen).toBe(true);
  });

  it("recognizes Claude's own call form", () => {
    const filter = new TextCallsFilter();
    filter.push('<invoke name="Read"><parameter name="path">a</parameter></invoke>');
    expect(filter.end().seen).toBe(true);
  });
});

describe("filterTextCalls", () => {
  it("drops a fake call when the reply made a real one", async () => {
    const events = await runFilter([
      { kind: "text", text: "I will read it.\n[tool call read id=1]" },
      { kind: "toolCall", id: "toolu_1", name: "read", arguments: "{}" },
      { kind: "stop", stop: "tool_use" },
    ]);
    expect(events).toEqual([
      { kind: "text", text: "I will read it.\n" },
      { kind: "toolCall", id: "toolu_1", name: "read", arguments: "{}" },
      { kind: "stop", stop: "tool_use" },
    ]);
  });

  it("shows the words when no real call came and none can be asked for", async () => {
    const events = await runFilter([
      { kind: "text", text: "Reading now.\n[tool call read id=1]" },
      { kind: "stop", stop: "end_turn" },
    ]);
    expect(events).toEqual([
      { kind: "text", text: "Reading now.\n" },
      { kind: "text", text: "[tool call read id=1]" },
      { kind: "stop", stop: "end_turn" },
    ]);
  });
});
