import { describe, expect, it } from "vitest";
import { anthropicCodec } from "./anthropic-codec.js";
import type { IrCitation } from "./ir.js";
import { Citer, CiteStream, citesOf, citeText, urlIn } from "./search-cite.js";

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
});
