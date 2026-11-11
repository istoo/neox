import { describe, expect, it } from "vitest";
import { saltToolUseId, ToolUseIds, unsaltRequestIds, unsaltToolUseId } from "./tool-use-ids.js";

describe("tool_use ids", () => {
  it("round-trips a salted id and rejects anything else", () => {
    const salted = saltToolUseId("fc_0", "abc");
    expect(salted.startsWith("mp_")).toBe(true);
    expect(unsaltToolUseId(salted)).toBe("fc_0");
    expect(unsaltToolUseId("mp_")).toBeNull();
    expect(unsaltToolUseId("toolu_01abc")).toBeNull();
    expect(unsaltToolUseId("mp_!!!!")).toBeNull();
  });

  it("salts only the ids the client holds again", () => {
    const ids = new ToolUseIds(["fc_0"]);
    const first = ids.event({ type: "tool_call_start", id: "fc_1", name: "read" });
    expect(first).toEqual({ type: "tool_call_start", id: "fc_1", name: "read" });
    const again = ids.event({ type: "tool_call_start", id: "fc_0", name: "read" });
    expect(again.type).toBe("tool_call_start");
    const salted = again.type === "tool_call_start" ? again.id : "";
    expect(salted).not.toBe("fc_0");
    expect(unsaltToolUseId(salted)).toBe("fc_0");
    expect(ids.event({ type: "tool_args_delta", id: "fc_0", args: "{}" })).toEqual({
      type: "tool_args_delta",
      id: salted,
      args: "{}",
    });
  });

  it("salts a whole reply's repeated id", () => {
    const ids = new ToolUseIds(["fc_0"]);
    const reply = {
      parts: [
        { type: "tool_call" as const, id: "fc_0", name: "read", arguments: "{}" },
        { type: "text" as const, text: "ok" },
      ],
      stopReason: "tool_use" as const,
      usage: null,
    };
    const salted = ids.response(reply);
    const part = salted.parts[0];
    expect(part?.type).toBe("tool_call");
    expect(part?.type === "tool_call" && unsaltToolUseId(part.id)).toBe("fc_0");
    expect(salted.parts[1]).toEqual({ type: "text", text: "ok" });
  });

  it("salts a relayed stream's call id across chunks", () => {
    const ids = new ToolUseIds(["fc_0"]);
    const event = (id: string): string =>
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name: "read", input: {} },
      })}\n\n`;
    const first = ids.write(Buffer.from(event("fc_0").slice(0, 30)));
    expect(first.length).toBe(0);
    const rest = Buffer.concat([
      first,
      Buffer.from(ids.write(Buffer.from(event("fc_0").slice(30)))),
    ]).toString();
    const data = rest.slice(rest.indexOf("data:") + 5).trim();
    const parsed = JSON.parse(data) as { content_block: { id: string } };
    expect(unsaltToolUseId(parsed.content_block.id)).toBe("fc_0");
    // An id the client does not hold goes as it came.
    const fresh = Buffer.from(ids.write(Buffer.from(event("fc_9")))).toString();
    expect(fresh).toContain('"id":"fc_9"');
  });

  it("gives the upstream back its own ids on the next request", () => {
    const salted = saltToolUseId("fc_0", "abc");
    const body = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: salted, name: "read", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: salted, content: "x" }] },
      ],
    };
    const fitted = unsaltRequestIds(body);
    expect(fitted.messages).toEqual([
      { role: "assistant", content: [{ type: "tool_use", id: "fc_0", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "fc_0", content: "x" }] },
    ]);
    const plain = { messages: [{ role: "user", content: "hi" }] };
    expect(unsaltRequestIds(plain)).toBe(plain);
  });
});
