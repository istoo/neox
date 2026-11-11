import { describe, expect, it } from "vitest";
import { ItemIdTidy, PhaseTidy, phaseWholeText } from "./responses-tidy.js";

function event(type: string, fields: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
}

function events(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("a message's phase", () => {
  it("makes a message before a call commentary", () => {
    const tidy = new PhaseTidy(true);
    const first = event("response.output_item.done", {
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    });
    const call = event("response.output_item.added", {
      output_index: 1,
      item: { type: "function_call", id: "fc_1", name: "bash" },
    });
    const completed = event("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        output: [
          { type: "message", id: "msg_1", role: "assistant", content: [] },
          { type: "function_call", id: "fc_1", name: "bash" },
        ],
      },
    });
    const out = tidy.write(first) + tidy.write(call) + tidy.write(completed) + tidy.flush();
    const done = events(out).find((entry) => entry.type === "response.output_item.done");
    const doneItem = done?.item as { phase?: string } | undefined;
    expect(doneItem?.phase).toBe("commentary");
    const end = events(out).find((entry) => entry.type === "response.completed");
    const response = end?.response as { output: Array<{ phase?: string }> } | undefined;
    expect(response).toBeDefined();
    const output = response?.output ?? [];
    expect(output[0]?.phase).toBe("commentary");
    expect(output[1]?.phase).toBeUndefined();
  });

  it("makes a reply's last message the final answer when it completed", () => {
    const tidy = new PhaseTidy(true);
    const done = event("response.output_item.done", {
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    });
    const completed = event("response.completed", {
      response: {
        id: "resp_1",
        object: "response",
        output: [{ type: "message", id: "msg_1", role: "assistant", content: [] }],
      },
    });
    const out = tidy.write(done) + tidy.write(completed) + tidy.flush();
    const end = events(out).find((entry) => entry.type === "response.completed");
    const response = end?.response as { output: Array<{ phase?: string }> } | undefined;
    expect(response).toBeDefined();
    const output = response?.output ?? [];
    expect(output[0]?.phase).toBe("final_answer");
  });

  it("gives a whole reply's messages their phase", () => {
    const body = JSON.stringify({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [{ type: "message", id: "msg_1", role: "assistant", content: [] }],
    });
    const out = phaseWholeText(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out ?? "{}") as {
      output: Array<{ phase?: string }>;
    };
    expect(parsed.output[0]?.phase).toBe("final_answer");
  });
});

describe("an item's id", () => {
  it("keeps the id its added gave it", () => {
    const tidy = new ItemIdTidy();
    const added = event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    });
    const delta = event("response.output_text.delta", {
      output_index: 0,
      item_id: "msg_2",
      delta: "hi",
    });
    const done = event("response.output_item.done", {
      output_index: 0,
      item: { type: "message", id: "msg_3" },
    });
    const completed = event("response.completed", {
      response: { output: [{ type: "message", id: "msg_4" }] },
    });
    const out = tidy.write(added) + tidy.write(delta) + tidy.write(done) + tidy.write(completed);
    const fixedDelta = events(out).find((entry) => entry.type === "response.output_text.delta");
    expect(fixedDelta?.item_id).toBe("msg_1");
    const fixedDone = events(out).find((entry) => entry.type === "response.output_item.done");
    const doneItem = fixedDone?.item as { id?: string } | undefined;
    expect(doneItem?.id).toBe("msg_1");
    const end = events(out).find((entry) => entry.type === "response.completed");
    const response = end?.response as { output: Array<{ id?: string }> } | undefined;
    expect(response).toBeDefined();
    const output = response?.output ?? [];
    expect(output[0]?.id).toBe("msg_1");
  });

  it("forwards a stream whose ids already agree", () => {
    const tidy = new ItemIdTidy();
    const added = event("response.output_item.added", {
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    });
    const delta = event("response.output_text.delta", {
      output_index: 0,
      item_id: "msg_1",
      delta: "hi",
    });
    expect(tidy.write(added) + tidy.write(delta)).toBe(added + delta);
  });
});
