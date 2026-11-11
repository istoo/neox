import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import { anthropicSearchBlocks, searchItem, searchToolId } from "./search-events.js";

const pages = [
  { title: "Neox", url: "https://example.com/", age: "2026-01-01" },
  { title: "Docs", url: "https://example.com/docs" },
];

function sseEvents(stream: string): Array<Record<string, unknown>> {
  return stream
    .split("\n\n")
    .map((event) => event.slice(event.indexOf("data:") + 5).trim())
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

describe("a search the gateway ran", () => {
  it("tells Anthropic clients as two of its own blocks", () => {
    const id = "srvtoolu_1";
    const [call, result] = anthropicSearchBlocks(id, "neolix", pages);
    expect(call).toEqual({
      type: "server_tool_use",
      id,
      name: "web_search",
      input: { query: "neolix" },
    });
    expect(result).toEqual({
      type: "web_search_tool_result",
      tool_use_id: id,
      content: [
        {
          type: "web_search_result",
          title: "Neox",
          url: "https://example.com/",
          encrypted_content: "",
          page_age: "2026-01-01",
        },
        {
          type: "web_search_result",
          title: "Docs",
          url: "https://example.com/docs",
          encrypted_content: "",
        },
      ],
    });
    expect(searchToolId()).toMatch(/^srvtoolu_[0-9a-f]+$/);
  });

  it("tells Responses clients as a web_search_call item", () => {
    expect(searchItem("neolix", "ws_1", pages)).toEqual({
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        query: "neolix",
        queries: ["neolix"],
        sources: [
          { type: "url", url: "https://example.com/" },
          { type: "url", url: "https://example.com/docs" },
        ],
      },
    });
  });

  it("writes Anthropic's blocks whole and streamed", () => {
    const reply = anthropicCodec.parseResponse({ content: [] });
    reply.parts.push({ type: "search", query: "neolix", pages });
    reply.parts.push({ type: "text", text: "It is a phone app." });
    const body = anthropicCodec.buildResponseBody(reply, "m");
    const content = body.content as Array<Record<string, unknown>>;
    expect(content[0]?.type).toBe("server_tool_use");
    expect(content[1]?.type).toBe("web_search_tool_result");
    expect(content[1]?.tool_use_id).toBe(content[0]?.id);
    expect(content[2]).toEqual({ type: "text", text: "It is a phone app." });

    const encoder = anthropicCodec.createStreamEncoder("m");
    const stream =
      encoder.start() +
      encoder.push({ type: "search", query: "neolix", pages }) +
      encoder.push({ type: "text_delta", text: "ok" }) +
      encoder.push({ type: "stop", reason: "end_turn" }) +
      encoder.end();
    const events = sseEvents(stream);
    const blocks = events
      .filter((event) => event.type === "content_block_start")
      .map((event) => event.content_block as Record<string, unknown>);
    expect(blocks[0]?.type).toBe("server_tool_use");
    expect(blocks[1]?.type).toBe("web_search_tool_result");
    expect(blocks[1]?.tool_use_id).toBe(blocks[0]?.id);
    expect(blocks[2]).toEqual({ type: "text", text: "" });
    const delta = events.find(
      (event) =>
        event.type === "content_block_delta" &&
        (event.delta as Record<string, unknown>).type === "input_json_delta",
    );
    expect(delta).toBeDefined();
    if (delta === undefined) {
      throw new Error("the search call must carry its query");
    }
    expect((delta.delta as Record<string, unknown>).partial_json).toBe('{"query":"neolix"}');
  });

  it("writes a Responses web_search_call item whole and streamed", () => {
    const reply = openAiResponsesCodec.parseResponse({ output: [] });
    reply.parts.push({ type: "search", query: "neolix", pages });
    reply.parts.push({ type: "text", text: "ok" });
    const body = openAiResponsesCodec.buildResponseBody(reply, "m");
    const output = body.output as Array<Record<string, unknown>>;
    expect(output[0]?.type).toBe("web_search_call");

    const encoder = openAiResponsesCodec.createStreamEncoder("m");
    const stream =
      encoder.start() +
      encoder.push({ type: "search", query: "neolix", pages }) +
      encoder.push({ type: "text_delta", text: "ok" }) +
      encoder.push({ type: "stop", reason: "end_turn" }) +
      encoder.end();
    const events = sseEvents(stream);
    const completed = events.find((event) => event.type === "response.web_search_call.completed");
    expect(completed?.item_id).toMatch(/^ws_/);
    const text = events.find(
      (event) =>
        event.type === "response.output_item.added" &&
        (event.item as Record<string, unknown>).type === "message",
    );
    expect(text?.output_index).toBe(1);
  });
});
