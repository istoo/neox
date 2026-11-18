import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import { geminiCodec } from "./gemini-codec.js";
import type { IrCitation, IrResponse } from "./ir.js";
import { openAiChatCodec } from "./openai-chat-codec.js";
import { openAiResponsesCodec } from "./openai-responses-codec.js";
import { Citer, CiteStream, citesOf, citeText, urlIn } from "./search-cite.js";

function sseEvents(stream: string): Array<Record<string, unknown>> {
  return stream
    .split("\n\n")
    .map((event) => event.slice(event.indexOf("data:") + 5).trim())
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

function citedReply(): IrResponse {
  return {
    id: "m",
    parts: [
      {
        type: "text",
        text: "see https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
      },
    ],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

const urlCitation = {
  type: "url_citation",
  url_citation: {
    url: "https://a.test/page",
    title: "A",
    start_index: 4,
    end_index: 23,
  },
};

const PAGES = [
  { url: "https://a.test/page", title: "A", text: "  a snippet  " },
  { url: "https://b.test/x/", title: "B", text: "b" },
];

function citationOf(url: string): IrCitation {
  return {
    type: "web_search_result_location",
    url,
    title: url === "https://a.test/page" ? "A" : "B",
    encrypted_index: "",
    cited_text: url === "https://a.test/page" ? "a snippet" : "b",
  };
}

describe("search citations", () => {
  it("finds a page the line names at a boundary", () => {
    expect(urlIn("see https://a.test/page.", "https://a.test/page")).toBe(4);
    expect(urlIn("see https://a.test/page/path", "https://a.test/page")).toBe(-1);
    expect(urlIn("见 https://a.test/page。", "https://a.test/page")).toBe(2);
    expect(urlIn("(https://a.test/page)", "https://a.test/page")).toBe(1);
    expect(urlIn("https://a.test/page, and", "https://a.test/page")).toBe(0);
  });

  it("cites the pages a line names, in the order it names them", () => {
    const line = "B first https://b.test/x then https://a.test/page.\n";
    expect(citesOf(line, PAGES)).toEqual([
      citationOf("https://b.test/x/"),
      citationOf("https://a.test/page"),
    ]);
    expect(citesOf("nothing here", PAGES)).toEqual([]);
    // A page named twice is cited once.
    expect(citesOf("https://a.test/page and https://a.test/page", PAGES).length).toBe(1);
  });

  it("cuts text into lines, holding whitespace for the next", () => {
    const citer = new Citer(PAGES);
    const lines = [
      ...citer.feed("one https://a.test/page.\n"),
      ...citer.feed("\n"),
      ...citer.feed("two\n  "),
      ...citer.flush(),
    ];
    expect(lines).toEqual([
      {
        text: "one https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
        tail: false,
      },
      { text: "\ntwo\n", citations: [], tail: false },
      { text: "  ", citations: [], tail: true },
    ]);
    expect(citeText("one https://a.test/page.\nrest", PAGES)).toEqual([
      { text: "one https://a.test/page.\n", citations: [citationOf("https://a.test/page")] },
      { text: "rest" },
    ]);
  });

  it("quotes at most 150 characters of a page", () => {
    const page = { url: "https://c.test/", title: "C", text: "x".repeat(200) };
    expect(citesOf("https://c.test/", [page])[0]?.cited_text.length).toBe(150);
  });

  it("streams text as cited lines", () => {
    const stream = new CiteStream(PAGES);
    expect(stream.push({ type: "text_delta", text: "see https://a.test/page" })).toEqual([]);
    const said = stream.push({ type: "text_delta", text: ".\nmore" });
    expect(said).toEqual([
      {
        type: "text_delta",
        text: "see https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
      },
    ]);
    expect(stream.push({ type: "stop", reason: "end_turn" })).toEqual([
      { type: "stop", reason: "end_turn" },
    ]);
    expect(stream.flush()).toEqual([{ type: "text_delta", text: "more" }]);
  });

  it("gives Anthropic the citations on its text block and stream", () => {
    const response = anthropicCodec.buildResponseBody(
      {
        id: "m",
        parts: [
          {
            type: "text",
            text: "see https://a.test/page.\n",
            citations: [citationOf("https://a.test/page")],
          },
        ],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      "claude",
    );
    const content = response.content as Record<string, unknown>[];
    expect(content[0]?.citations).toEqual([citationOf("https://a.test/page")]);

    const encoder = anthropicCodec.createStreamEncoder("claude");
    encoder.push({ type: "start", id: "m" });
    const out = encoder.push({
      type: "text_delta",
      text: "see https://a.test/page.\n",
      citations: [citationOf("https://a.test/page")],
    });
    expect(out).toContain('"type":"citations_delta"');
    expect(out).toContain("https://a.test/page");
    expect(out.indexOf("citations_delta")).toBeLessThan(out.indexOf("text_delta"));
  });

  it("gives Chat clients url_citation annotations on the message and stream", () => {
    const body = openAiChatCodec.buildResponseBody(citedReply(), "gpt");
    const choices = body.choices as Array<{ message: Record<string, unknown> }>;
    expect(choices[0]?.message.annotations).toEqual([urlCitation]);

    const encoder = openAiChatCodec.createStreamEncoder("gpt");
    const stream =
      encoder.start() +
      encoder.push({
        type: "text_delta",
        text: "see https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
      }) +
      encoder.end();
    const annotated = sseEvents(stream)
      .map((chunk) => (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta)
      .find((delta) => delta?.annotations !== undefined);
    expect(annotated?.annotations).toEqual([urlCitation]);
  });

  it("gives Responses clients url_citation annotations on output_text", () => {
    const body = openAiResponsesCodec.buildResponseBody(citedReply(), "gpt");
    const output = body.output as Array<Record<string, unknown>>;
    const message = output.find((item) => item.type === "message");
    const content = message?.content as Array<Record<string, unknown>>;
    expect(content[0]?.annotations).toEqual([urlCitation]);

    const encoder = openAiResponsesCodec.createStreamEncoder("gpt");
    const stream =
      encoder.start() +
      encoder.push({
        type: "text_delta",
        text: "see https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
      }) +
      encoder.push({ type: "stop", reason: "end_turn" }) +
      encoder.end();
    const added = sseEvents(stream).find(
      (event) => event.type === "response.output_text.annotation.added",
    );
    expect(added?.annotation).toEqual(urlCitation);
  });

  it("gives Gemini clients grounding metadata on the candidate and stream", () => {
    const body = geminiCodec.buildResponseBody(
      {
        ...citedReply(),
        parts: [
          { type: "search", query: "neolix", pages: PAGES },
          {
            type: "text",
            text: "see https://a.test/page.\n",
            citations: [citationOf("https://a.test/page")],
          },
        ],
      },
      "gemini",
    );
    const candidates = body.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]?.groundingMetadata).toEqual({
      webSearchQueries: ["neolix"],
      groundingChunks: [{ web: { uri: "https://a.test/page", title: "A" } }],
      groundingSupports: [
        {
          segment: { startIndex: 0, endIndex: 25, text: "see https://a.test/page.\n" },
          groundingChunkIndices: [0],
        },
      ],
    });

    const encoder = geminiCodec.createStreamEncoder("gemini");
    const stream =
      encoder.start() +
      encoder.push({ type: "search", query: "neolix", pages: PAGES }) +
      encoder.push({
        type: "text_delta",
        text: "see https://a.test/page.\n",
        citations: [citationOf("https://a.test/page")],
      }) +
      encoder.push({ type: "stop", reason: "end_turn" }) +
      encoder.end();
    const last = sseEvents(stream).at(-1);
    const streamedCandidates = last?.candidates as Array<Record<string, unknown>> | undefined;
    const streamed = streamedCandidates?.[0];
    expect(streamed?.groundingMetadata).toEqual({
      webSearchQueries: ["neolix"],
      groundingChunks: [{ web: { uri: "https://a.test/page", title: "A" } }],
      groundingSupports: [
        {
          segment: { startIndex: 0, endIndex: 25, text: "see https://a.test/page.\n" },
          groundingChunkIndices: [0],
        },
      ],
    });
  });
});
