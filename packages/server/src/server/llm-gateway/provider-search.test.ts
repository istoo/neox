import { describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import {
  parseAnthropicSearch,
  parseChatSearch,
  parseGeminiSearch,
  parseResponsesSearch,
  providerSearchFound,
  providerSearchRequest,
  searchWithProvider,
} from "./provider-search.js";

function providerOf(protocol: GatewayProvider["protocol"]): GatewayProvider {
  return {
    id: "relay",
    protocol,
    baseUrl: "https://relay.example/v1",
    models: [{ id: "finder" }],
  };
}

describe("asking a provider to search", () => {
  it("asks Anthropic's Messages API with its own web search tool", () => {
    const request = providerSearchRequest(providerOf("anthropic"), "finder", "neolix 0.15");
    expect(request.path).toBe("/v1/messages");
    expect(request.body).toMatchObject({
      model: "relay/finder",
      stream: false,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    });
    expect(JSON.stringify(request.body)).toContain("Search the web for: neolix 0.15");
  });

  it("asks Responses with web_search, and Gemini with google_search", () => {
    const responses = providerSearchRequest(providerOf("openai-responses"), "finder", "q");
    expect(responses.path).toBe("/v1/responses");
    expect(responses.body).toMatchObject({
      model: "relay/finder",
      tools: [{ type: "web_search" }],
    });

    const gemini = providerSearchRequest(providerOf("gemini"), "finder", "q");
    expect(gemini.path).toBe("/v1beta/models/relay/finder:generateContent");
    expect(gemini.body).toMatchObject({ tools: [{ google_search: {} }] });
  });

  it("asks a Chat provider with web_search_options", () => {
    const request = providerSearchRequest(providerOf("openai"), "finder", "q");
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.body).toMatchObject({ web_search_options: {} });
  });
});

describe("reading a searcher's reply", () => {
  it("reads Anthropic's text, citations and search results", () => {
    const result = parseAnthropicSearch({
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
        {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content: [
            {
              type: "web_search_result",
              title: "Neox",
              url: "https://example.com/a",
              page_age: "2d",
            },
            { type: "web_search_result", title: "Again", url: "https://example.com/a" },
            { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
          ],
        },
        {
          type: "text",
          text: "Neox 0.15 is out.",
          citations: [{ url: "https://example.com/a", cited_text: "0.15", title: "Neox" }],
        },
      ],
    });
    expect(result.searched).toBe(true);
    expect(result.said).toBe("Neox 0.15 is out.");
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({
      title: "Neox",
      url: "https://example.com/a",
      text: "0.15",
      age: "2d",
    });
  });

  it("reads a Responses reply's sources and citations", () => {
    const result = parseResponsesSearch({
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          action: { type: "search", sources: [{ type: "url", url: "https://a.example/1" }] },
          results: [{ title: "One", url: "https://a.example/1", snippet: "the fact" }],
        },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "The fact is so.",
              annotations: [{ type: "url_citation", url: "https://a.example/2", title: "Two" }],
            },
          ],
        },
      ],
    });
    expect(result.searched).toBe(true);
    expect(result.said).toBe("The fact is so.");
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://a.example/1",
      "https://a.example/2",
    ]);
    expect(result.pages[0]?.text).toBe("the fact");
  });

  it("reads Gemini's grounding pages and what it supports", () => {
    const result = parseGeminiSearch({
      candidates: [
        {
          content: { parts: [{ text: "It is 42." }] },
          groundingMetadata: {
            groundingChunks: [{ web: { uri: "https://b.example/1", title: "One" } }],
            groundingSupports: [
              {
                segment: { text: "It is 42." },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
    });
    expect(result.searched).toBe(true);
    expect(result.said).toBe("It is 42.");
    expect(result.pages[0]).toMatchObject({
      title: "One",
      url: "https://b.example/1",
      text: "It is 42.",
    });
  });

  it("reads a Chat reply's annotations", () => {
    const result = parseChatSearch({
      choices: [
        {
          message: {
            content: "So it is.",
            annotations: [{ type: "url_citation", url: "https://c.example/1", title: "One" }],
          },
        },
      ],
    });
    expect(result.searched).toBe(true);
    expect(result.pages[0]?.url).toBe("https://c.example/1");
  });

  it("counts a reply usable only when it names a page", () => {
    expect(providerSearchFound({ said: "I can't search.", pages: [], searched: false })).toBe(
      false,
    );
    expect(
      providerSearchFound({ said: "See https://a.example/1", pages: [], searched: true }),
    ).toBe(true);
    expect(
      providerSearchFound({
        said: "",
        pages: [{ title: "A", url: "https://a.example/1", text: "" }],
        searched: true,
      }),
    ).toBe(true);
  });

  it("asks through the caller's post and reads the reply by its wire", async () => {
    const asked: unknown[] = [];
    const result = await searchWithProvider({
      provider: providerOf("anthropic"),
      model: "finder",
      query: "q",
      post: (request) => {
        asked.push(request.body);
        return Promise.resolve({
          content: [
            {
              type: "web_search_tool_result",
              content: [{ title: "A", url: "https://a.example/1" }],
            },
            { type: "text", text: "Found." },
          ],
        });
      },
    });
    expect(asked).toHaveLength(1);
    expect(result.pages).toHaveLength(1);
    expect(result.said).toBe("Found.");
  });
});
