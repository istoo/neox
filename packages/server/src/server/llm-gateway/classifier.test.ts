import { describe, expect, it, vi } from "vitest";
import { classifyTurn } from "./classifier.js";

function reply(text: string): unknown {
  return { choices: [{ message: { content: text } }] };
}

describe("classifyTurn", () => {
  it("asks the intent and the effort in one request", async () => {
    const transport = vi.fn(async () => reply('{"intent": 2, "effort": 3}'));
    const said = await classifyTurn({
      model: "p/m",
      intents: ["code", "chat"],
      effort: true,
      text: "fix the failing login test",
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(said).toEqual({ intent: "chat", effort: "high" });
  });

  it("reads an answer wrapped in the model's prose", async () => {
    const transport = vi.fn(async () => reply('Sure.\n```json\n{"intent": 1, "effort": 4}\n```'));
    const said = await classifyTurn({
      model: "w/m",
      intents: ["code"],
      effort: true,
      text: "why does this deadlock",
      transport,
    });
    expect(said).toEqual({ intent: "code", effort: "xhigh" });
  });

  it("answers nothing when the reply carries no JSON", async () => {
    const transport = vi.fn(async () => reply("none"));
    const said = await classifyTurn({
      model: "n/m",
      intents: ["code"],
      effort: true,
      text: "hello there",
      transport,
    });
    expect(said).toEqual({ intent: null, effort: null });
  });

  it("asks only the intent when the group does not pick the effort", async () => {
    const transport = vi.fn(async () => reply("code"));
    const said = await classifyTurn({
      model: "i/m",
      intents: ["code", "chat"],
      effort: false,
      text: "add a test for the parser",
      transport,
    });
    expect(said).toEqual({ intent: "code", effort: null });
    const body = transport.mock.calls[0]?.[0] as unknown as { body: { messages: unknown[] } };
    expect(body.body.messages).toHaveLength(1);
  });

  it("asks only the effort when the rules name no intent", async () => {
    const transport = vi.fn(async () => reply("2"));
    const said = await classifyTurn({
      model: "e/m",
      intents: [],
      effort: true,
      text: "rename this variable",
      transport,
    });
    expect(said).toEqual({ intent: null, effort: "medium" });
  });

  it("keeps the answer for ten minutes instead of asking again", async () => {
    const transport = vi.fn(async () => reply('{"intent": 1, "effort": 1}'));
    const input = {
      model: "c/m",
      intents: ["code"],
      effort: true,
      text: "the answer is kept",
      transport,
    };
    await classifyTurn(input);
    const again = await classifyTurn(input);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ intent: "code", effort: "low" });
  });
});
