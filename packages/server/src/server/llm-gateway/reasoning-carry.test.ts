import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isGrokLike,
  packResponseReasoning,
  ReasoningCarry,
  reasoningIdSuffix,
  takeReasoning,
  withSealedReasoning,
} from "./reasoning-carry.js";
import { configureSigstore } from "./sigstore.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";

const ITEM = {
  id: "rs_1",
  type: "reasoning",
  status: "completed",
  summary: [],
  encrypted_content: "gAAAA-reasoning",
};

describe("reasoning carried in call ids", () => {
  afterEach(() => {
    configureSigstore(null);
  });

  it("round-trips the items", () => {
    const suffix = reasoningIdSuffix([ITEM]);
    expect(suffix.startsWith("__rc")).toBe(true);
    expect(takeReasoning(`call_1${suffix}`)).toEqual({ id: "call_1", items: [ITEM] });
    expect(takeReasoning("call_1")).toEqual({ id: "call_1", items: [] });
    const cut = `call_1${suffix}`.slice(0, -4);
    expect(takeReasoning(cut).items).toEqual([]);
  });

  it("packs a reply's step into its first call", () => {
    const reply = {
      parts: [
        { type: "reasoning_item" as const, item: ITEM },
        { type: "tool_call" as const, id: "call_1", name: "read", arguments: "{}" },
        { type: "tool_call" as const, id: "call_2", name: "grep", arguments: "{}" },
      ],
    };
    const packed = packResponseReasoning(reply);
    const first = packed.parts[0];
    expect(first?.type).toBe("tool_call");
    expect(first?.type === "tool_call" && takeReasoning(first.id)).toEqual({
      id: "call_1",
      items: [ITEM],
    });
    expect(first?.type === "tool_call" && first.reasoning).toEqual([ITEM]);
    const second = packed.parts[1];
    expect(second?.type === "tool_call" && second.id).toBe("call_2");
  });

  it("carries a streamed step", () => {
    const carry = new ReasoningCarry();
    expect(carry.event({ type: "reasoning_item", item: ITEM })).toEqual({
      type: "reasoning_item",
      item: ITEM,
    });
    const start = carry.event({ type: "tool_call_start", id: "call_1", name: "read" });
    expect(start.type).toBe("tool_call_start");
    const packedId = start.type === "tool_call_start" ? start.id : "";
    expect(takeReasoning(packedId).items).toEqual([ITEM]);
    expect(carry.event({ type: "tool_args_delta", id: "call_1", args: "{}" })).toEqual({
      type: "tool_args_delta",
      id: packedId,
      args: "{}",
    });
  });

  it("keeps long items under a short key, as myna does", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "neolix-reasoning-"));
    configureSigstore(home);
    const big = { ...ITEM, encrypted_content: "x".repeat(5000) };
    const suffix = reasoningIdSuffix([big]);
    expect(suffix.startsWith("__rck16__")).toBe(true);
    expect(suffix.length).toBeLessThan(40);
    expect(takeReasoning(`call_1${suffix}`)).toEqual({ id: "call_1", items: [big] });
    // A key of another home reads as no reasoning.
    configureSigstore(mkdtempSync(path.join(os.tmpdir(), "neolix-reasoning-")));
    expect(takeReasoning(`call_1${suffix}`).items).toEqual([]);
    // Without a folder a too-long item cannot travel.
    configureSigstore(null);
    expect(reasoningIdSuffix([big])).toBe("");
  });

  it("asks only a Grok-like Responses upstream for the items", () => {
    expect(isGrokLike({ baseUrl: "https://api.x.ai/v1", models: [] })).toBe(true);
    expect(isGrokLike({ baseUrl: "https://relay.test/v1", models: [{ id: "grok-4" }] })).toBe(true);
    expect(isGrokLike({ baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-5" }] })).toBe(
      false,
    );
    expect(withSealedReasoning({ include: ["foo"] })).toEqual({
      include: ["foo", "reasoning.encrypted_content"],
    });
    const asked = { include: ["reasoning.encrypted_content"] };
    expect(withSealedReasoning(asked)).toBe(asked);
  });

  it("makes over an item another vendor wrote with its text in it", () => {
    const theirs = {
      id: "rs_9",
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "their plan" }],
      encrypted_content: "their-seal",
      summary: [],
    };
    const reply = openAiResponsesCodec.parseResponse({ output: [theirs] });
    expect(reply.parts).toEqual([
      {
        type: "reasoning_item",
        item: {
          id: "rs_9",
          type: "reasoning",
          status: "completed",
          summary: [{ type: "summary_text", text: "their plan" }],
        },
      },
    ]);
  });

  it("keeps a Responses client's items as they came", () => {
    const reply = openAiResponsesCodec.parseResponse({ output: [ITEM] });
    expect(reply.parts).toEqual([{ type: "reasoning_item", item: ITEM }]);
    expect((openAiResponsesCodec.buildResponseBody(reply, "m").output as unknown[])[0]).toEqual(
      ITEM,
    );

    const request = openAiResponsesCodec.parseRequest({ input: [ITEM] });
    expect(request.messages[0]?.parts).toEqual([{ type: "reasoning_item", item: ITEM }]);
    const sent = openAiResponsesCodec.buildRequestBody(request, "m");
    expect(sent.input).toEqual([ITEM]);
  });

  it("unpacks a call's items before the call it made", () => {
    const suffix = reasoningIdSuffix([ITEM]);
    const request = openAiResponsesCodec.parseRequest({
      input: [{ type: "function_call", call_id: `call_1${suffix}`, name: "read", arguments: "{}" }],
    });
    expect(request.messages[0]?.parts[0]).toMatchObject({
      type: "tool_call",
      id: "call_1",
      reasoning: [ITEM],
    });
    const sent = openAiResponsesCodec.buildRequestBody(request, "m");
    expect((sent.input as unknown[])[0]).toEqual(ITEM);
    expect((sent.input as Array<Record<string, unknown>>)[1]).toMatchObject({ call_id: "call_1" });
  });
});
