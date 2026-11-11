import { describe, expect, it } from "vitest";
import type { IrMessage, IrRequest } from "./ir.js";
import { mayLoop, toolLoopNotice, toolLoopOf } from "./tool-loop.js";

function request(turns: number, result = "same output"): IrRequest {
  const messages: IrMessage[] = [{ role: "user", parts: [{ type: "text", text: "go" }] }];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: `call_${index}`,
          name: "bash",
          arguments: '{"command":"ls"}',
        },
      ],
    });
    messages.push({
      role: "user",
      parts: [
        { type: "tool_result", toolCallId: `call_${index}`, content: result, isError: false },
      ],
    });
  }
  return {
    system: null,
    messages,
    tools: [],
    toolChoice: null,
    format: null,
    maxTokens: null,
    temperature: null,
    topP: null,
    stop: [],
    stream: false,
  };
}

describe("a conversation stuck in a tool loop", () => {
  it("stops the ninth turn of the same call answered the same", () => {
    const loop = toolLoopOf(request(8));
    expect(loop?.turns).toBe(8);
    expect(toolLoopNotice(loop ?? { calls: [], turns: 0 })).toContain(
      "ran the same tool call 8 times",
    );
  });

  it("lets nine turns through", () => {
    expect(toolLoopOf(request(7))).toBeNull();
  });

  it("starts the count again when a result changed", () => {
    const messages = request(8).messages;
    const last = messages[messages.length - 1];
    expect(last?.parts[0]?.type).toBe("tool_result");
    if (last?.parts[0]?.type === "tool_result") {
      last.parts[0].content = "different output";
    }
    expect(toolLoopOf(request(8))).not.toBeNull();
    expect(toolLoopOf({ ...request(8), messages })).toBeNull();
  });

  it("never stops a turn that only waits", () => {
    const waiting = request(8, "ok");
    for (const message of waiting.messages) {
      for (const part of message.parts) {
        if (part.type === "tool_call") {
          part.name = "clock__sleep";
          part.arguments = '{"duration_ms":60000}';
        }
      }
    }
    expect(toolLoopOf(waiting)).toBeNull();
  });

  it("skips a body with too few results", () => {
    expect(mayLoop("openai", '{"messages":[]}')).toBe(false);
    expect(mayLoop("openai", '"tool_call_id"'.repeat(8))).toBe(true);
  });
});
