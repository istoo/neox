import { describe, expect, it } from "vitest";
import {
  HandoverFilter,
  handsOver,
  policyRefusal,
  RefusalHandover,
  refusalAsksAgain,
  refusedDetail,
  SpliceFilter,
  streamEvent,
} from "./refusal-handover.js";

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

describe("refusal handover", () => {
  it("reads what an event is, before an answer begins", () => {
    expect(streamEvent(sse({ choices: [{ delta: { role: "assistant" } }] })).kind).toBe("lead");
    expect(streamEvent(sse({ choices: [{ delta: { reasoning_content: "hm" } }] })).kind).toBe(
      "thinking",
    );
    expect(streamEvent(sse({ choices: [{ delta: { content: "hi" } }] })).kind).toBe("answer");
    const filtered = streamEvent(
      sse({ choices: [{ delta: {}, finish_reason: "content_filter" }] }),
    );
    expect(filtered.kind).toBe("refusal");
    expect(filtered.message).toContain("content_filter");

    const anthropic = streamEvent(
      event("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_details: { category: "cyber", explanation: "not allowed" },
        },
      }),
    );
    expect(anthropic.kind).toBe("refusal");
    expect(anthropic.message).toContain("category cyber");
    expect(anthropic.message).toContain("not allowed");
    expect(refusedDetail("refusal", { explanation: "x".repeat(300) }).length).toBeLessThan(260);

    const incomplete = streamEvent(
      event("response.incomplete", {
        type: "response.incomplete",
        response: { incomplete_details: { reason: "content_filter" } },
      }),
    );
    expect(incomplete.kind).toBe("refusal");
    const failed = streamEvent(
      event("response.failed", {
        type: "response.failed",
        response: { error: { code: "cyber_policy", message: "blocked" } },
      }),
    );
    expect(failed.kind).toBe("refusal_error");

    expect(
      streamEvent(event("response.metadata", { type: "response.metadata", safety_buffering: 1 }))
        .kind,
    ).toBe("buffering");
    expect(streamEvent(event("codex.rate_limits", { type: "codex.rate_limits" })).kind).toBe(
      "lead",
    );

    const gemini = streamEvent(
      sse({ candidates: [{ content: { parts: [{ text: "hm", thought: true }] } }] }),
    );
    expect(gemini.kind).toBe("thinking");
    const blocked = streamEvent(
      sse({ candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }),
    );
    expect(blocked.kind).toBe("refusal");
  });

  it("knows a safety refusal in an error", () => {
    expect(policyRefusal({ error: { code: "content_filter" } })).toContain("content_filter");
    expect(policyRefusal({ code: "bio_policy" })).toContain("bio_policy");
    expect(
      policyRefusal({ error: { type: "invalid_prompt", message: "prompt flagged" } }),
    ).not.toBeNull();
    expect(policyRefusal({ code: "rate_limit" })).toBeNull();
  });

  it("hands over only a stream, not the last try, before an answer", () => {
    const base = { streams: true, last: false, wantWhole: false, from: "anthropic", refusals: 0 };
    expect(handsOver({ ...base, retries: undefined })).toBe(true);
    expect(handsOver({ ...base, last: true, retries: undefined })).toBe(false);
    expect(handsOver({ ...base, wantWhole: true, retries: undefined })).toBe(false);
    expect(handsOver({ ...base, from: "gemini", retries: undefined })).toBe(false);
    expect(handsOver({ ...base, refusals: 2, retries: 2 })).toBe(false);
    expect(handsOver({ ...base, refusals: 1, retries: 2 })).toBe(true);
    expect(refusalAsksAgain(99, -1)).toBe(true);
  });

  it("passes reasoning and frames, then hands a refusal over", () => {
    const handover = new RefusalHandover("anthropic", { canHandOver: true });
    const filter = new HandoverFilter(handover);
    const started = event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    });
    expect(filter.write(started)).toBe(started);
    const thought = event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "hm" },
    });
    expect(filter.write(thought)).toBe(thought);
    expect(handover.handed).toBe(false);

    const refused = event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "refusal" },
    });
    const out = filter.write(refused);
    expect(out).toContain("content_block_stop");
    expect(out).not.toContain("message_delta");
    expect(handover.handed).toBe(true);
    expect(handover.handOver?.status).toBe(400);
    expect(filter.write(event("message_stop", { type: "message_stop" }))).toBe("");
  });

  it("splices the next try's stream after the handed-over one", () => {
    const anthropic = new RefusalHandover("anthropic", { canHandOver: true });
    const first = new HandoverFilter(anthropic);
    first.write(
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    first.write(
      event("message_delta", { type: "message_delta", delta: { stop_reason: "refusal" } }),
    );
    const spliced = new SpliceFilter(anthropic);
    expect(spliced.write(event("message_start", { type: "message_start", message: {} }))).toBe("");
    const block = event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(spliced.write(block)).toContain('"index":1');

    const responses = new RefusalHandover("openai-responses", { canHandOver: true });
    const watch = new HandoverFilter(responses);
    watch.write(
      event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning" },
        sequence_number: 4,
      }),
    );
    watch.write(
      event("response.failed", {
        type: "response.failed",
        response: { error: { code: "content_filter" } },
      }),
    );
    const next = new SpliceFilter(responses);
    expect(next.write(event("response.created", { type: "response.created", response: {} }))).toBe(
      "",
    );
    const item = JSON.parse(
      next
        .write(
          event("response.output_item.added", {
            type: "response.output_item.added",
            output_index: 0,
            sequence_number: 0,
            item: { type: "message" },
          }),
        )
        .replace(/^event: [^\n]*\ndata: /, "")
        .replace(/\n\n$/, ""),
    );
    expect(item.output_index).toBe(1);
    expect(item.sequence_number).toBe(5);
  });
});
