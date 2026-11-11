import { describe, expect, it } from "vitest";
import { wholeAsStream, wholeEvents } from "./whole-stream.js";

function dataOf(event: { data: string }): Record<string, unknown> {
  return JSON.parse(event.data);
}

describe("whole reply as its stream", () => {
  it("streams a Chat reply as chunks, numbering its calls", () => {
    const body = JSON.stringify({
      id: "chat_1",
      model: "m",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "hi",
            tool_calls: [
              { id: "a", function: { name: "read", arguments: "{}" } },
              { id: "b", function: { arguments: "{}" } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const events = wholeEvents("openai", body);
    expect(events).not.toBeNull();
    if (events === null) {
      return;
    }
    expect(events.map((event) => event.name)).toEqual(["", "", ""]);
    expect(events[2]?.data).toBe("[DONE]");
    const first = dataOf(events[0] as { data: string });
    const delta = (first.choices as Record<string, unknown>[])[0]?.delta as Record<string, unknown>;
    const calls = delta.tool_calls as Record<string, unknown>[];
    expect(calls.length).toBe(1); // the call naming nothing is dropped
    expect(calls[0]?.index).toBe(0);
    expect(first.id).toBe("chat_1");
    const second = dataOf(events[1] as { data: string });
    expect((second.choices as Record<string, unknown>[])[0]?.finish_reason).toBe("tool_calls");
    expect(second.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });

    // A reply whose only call names nothing ends stop, with no call.
    const nameless = JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: { role: "assistant", tool_calls: [{ function: { arguments: "{}" } }] },
        },
      ],
    });
    const only = wholeEvents("openai", nameless);
    expect(only).not.toBeNull();
    if (only === null) {
      return;
    }
    const droppedDelta = dataOf(only[0] as { data: string }).choices as Record<string, unknown>[];
    expect(droppedDelta[0]?.delta).toEqual({ role: "assistant" });
    const droppedEnd = dataOf(only[1] as { data: string }).choices as Record<string, unknown>[];
    expect(droppedEnd[0]?.finish_reason).toBe("stop");
  });

  it("streams a Responses reply item by item", () => {
    const body = JSON.stringify({
      object: "response",
      id: "resp_1",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "see this",
              annotations: [
                { type: "url_citation", url: "https://a", start_index: 0, end_index: 4 },
                { type: "url_citation", url: "https://b" },
              ],
            },
          ],
        },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "thought" }],
        },
        { type: "function_call", id: "call_1", name: "read", arguments: '{"p":1}' },
      ],
    });
    const events = wholeEvents("openai-responses", body);
    expect(events).not.toBeNull();
    if (events === null) {
      return;
    }
    const names = events.map((event) => event.name);
    expect(names.slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
    expect(names).toContain("response.output_text.delta");
    expect(names).toContain("response.reasoning_summary_text.delta");
    expect(names).toContain("response.function_call_arguments.delta");
    expect(names.at(-1)).toBe("response.completed");
    const annotations = events.filter(
      (event) => event.name === "response.output_text.annotation.added",
    );
    expect(annotations.length).toBe(1); // the one without offsets is dropped
    const sequences = events.map((event) => dataOf(event).sequence_number);
    expect(sequences).toEqual(events.map((_event, index) => index));
    const end = dataOf(events.at(-1) as { data: string });
    const response = end.response as Record<string, unknown>;
    const output = response.output as Record<string, unknown>[];
    const message = output.at(0);
    const parts = (message?.content ?? []) as Record<string, unknown>[];
    const keptAnnotations = parts.at(0)?.annotations;
    expect(Array.isArray(keptAnnotations) ? keptAnnotations.length : 0).toBe(1);
  });

  it("streams an Anthropic message block by block", () => {
    const body = JSON.stringify({
      type: "message",
      id: "msg_1",
      role: "assistant",
      model: "claude",
      content: [
        { type: "text", text: "hello", citations: [{ type: "x" }] },
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "tool_use", id: "t1", name: "read", input: { p: 1 } },
        { type: "redacted_thinking", data: "sealed" },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 7 },
      safeguard_results: { flagged: false },
    });
    const events = wholeEvents("anthropic", body);
    expect(events).not.toBeNull();
    if (events === null) {
      return;
    }
    const names = events.map((event) => event.name);
    expect(names[0]).toBe("message_start");
    expect(names.at(-2)).toBe("message_delta");
    expect(names.at(-1)).toBe("message_stop");
    const start = dataOf(events[0] as { data: string }).message as Record<string, unknown>;
    expect(start.content).toEqual([]);
    expect(start.stop_reason).toBeNull();
    expect((start.usage as Record<string, unknown>).output_tokens).toBe(0);
    expect(start.safeguard_results).toBeUndefined();
    const deltas = events
      .filter((event) => event.name === "content_block_delta")
      .map((event) => dataOf(event).delta as Record<string, unknown>);
    expect(deltas.map((delta) => delta.type)).toEqual([
      "citations_delta",
      "text_delta",
      "thinking_delta",
      "signature_delta",
      "input_json_delta",
    ]);
    const end = dataOf(events.at(-2) as { data: string });
    const stop = end.delta as Record<string, unknown>;
    expect(stop.stop_reason).toBe("end_turn");
    expect(stop.safeguard_results).toEqual({ flagged: false });
    expect(end.usage).toEqual({ input_tokens: 5, output_tokens: 7 });
  });

  it("writes the events as SSE, and refuses a body that isn't a reply", () => {
    const text = wholeAsStream("openai", JSON.stringify({ choices: [{ message: {} }] }));
    expect(text).toContain("data: ");
    expect(text).toContain("data: [DONE]\n\n");
    expect(wholeAsStream("openai", "{}")).toBeNull();
    expect(wholeAsStream("anthropic", JSON.stringify({ type: "error" }))).toBeNull();
    expect(wholeAsStream("gemini", "{}")).toBeNull();
  });
});
