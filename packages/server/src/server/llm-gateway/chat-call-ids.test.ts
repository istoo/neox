import { describe, expect, it } from "vitest";
import { chatCallIds, placedCallId } from "./chat-call-ids.js";

describe("a Chat call with no id", () => {
  it("gets one, and its tool message the same", () => {
    const body = chatCallIds({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [
            { type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
          ],
        },
        { role: "tool", content: "a.txt" },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    const calls = (messages[1]?.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
    const call = calls[0];
    const id = call?.id;
    expect(typeof id).toBe("string");
    expect(id).toBe(placedCallId(1, 0, "bash", '{"command":"ls"}'));
    expect(messages[2]?.tool_call_id).toBe(id);
  });

  it("gives each call of a turn its own, in the calls' order", () => {
    const body = chatCallIds({
      messages: [
        {
          role: "assistant",
          tool_calls: [
            { type: "function", function: { name: "a", arguments: "{}" } },
            { type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "one" },
        { role: "tool", content: "two" },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    const calls = messages[0]?.tool_calls as Array<Record<string, unknown>>;
    expect(messages[1]?.tool_call_id).toBe(calls[0]?.id);
    expect(messages[2]?.tool_call_id).toBe(calls[1]?.id);
  });

  it("says the same id for the same history", () => {
    const history = {
      messages: [
        { role: "assistant", tool_calls: [{ function: { name: "a", arguments: "{}" } }] },
        { role: "tool", content: "x" },
      ],
    };
    const once = chatCallIds(structuredClone(history));
    const twice = chatCallIds(structuredClone(history));
    expect(once).toEqual(twice);
  });

  it("leaves a body whose calls have ids as it came", () => {
    const body = {
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "a", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "x" },
        { role: "user", content: "next" },
        { role: "assistant", tool_calls: [{ function: { name: "b", arguments: "{}" } }] },
      ],
    };
    const fixed = chatCallIds(structuredClone(body));
    const messages = fixed.messages as Array<Record<string, unknown>>;
    expect(messages[0]?.tool_calls).toEqual(
      body.messages[0]?.tool_calls as Array<Record<string, unknown>>,
    );
    expect(messages[1]?.tool_call_id).toBe("call_1");
  });

  it("fills a missing result id only for calls it named", () => {
    const body = chatCallIds({
      messages: [
        {
          role: "assistant",
          tool_calls: [{ id: "call_1", function: { name: "a", arguments: "{}" } }],
        },
        { role: "tool", content: "x" },
      ],
    });
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.tool_call_id).toBeUndefined();
  });
});
