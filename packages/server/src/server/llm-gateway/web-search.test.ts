import { describe, expect, it } from "vitest";
import { lastUserText, wantsWebSearch, withSearchResults } from "./web-search.js";

describe("web search in a request", () => {
  it("finds the tool and the words in each protocol", () => {
    expect(wantsWebSearch("openai", { tools: [{ type: "web_search" }] })).toBe(true);
    expect(wantsWebSearch("openai", { web_search_options: {} })).toBe(true);
    expect(wantsWebSearch("openai", { tools: [{ type: "function", function: {} }] })).toBe(false);
    expect(wantsWebSearch("anthropic", { tools: [{ type: "web_search_20250305" }] })).toBe(true);
    expect(wantsWebSearch("openai-responses", { tools: [{ type: "web_search_preview" }] })).toBe(
      true,
    );
    expect(wantsWebSearch("gemini", { tools: [{ googleSearch: {} }] })).toBe(true);
  });

  it("reads the last thing the user said", () => {
    expect(
      lastUserText("openai", {
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "older" },
          { role: "assistant", content: "a" },
          { role: "user", content: [{ type: "text", text: "weather in Paris" }] },
        ],
      }),
    ).toBe("weather in Paris");
    expect(
      lastUserText("anthropic", {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      }),
    ).toBe("hi");
    expect(lastUserText("openai-responses", { input: "hello" })).toBe("hello");
    expect(
      lastUserText("gemini", {
        contents: [{ role: "user", parts: [{ text: "hola" }] }],
      }),
    ).toBe("hola");
  });

  it("strips the search tool and gives the model what was found", () => {
    const chat = withSearchResults(
      "openai",
      {
        messages: [{ role: "system", content: "be terse" }],
        tools: [{ type: "web_search" }, { type: "function", function: { name: "f" } }],
        web_search_options: {},
      },
      "1. A — https://a\ntext",
    );
    expect(chat.web_search_options).toBeUndefined();
    expect(chat.tools).toHaveLength(1);
    expect(JSON.stringify(chat.messages)).toContain("Web search results");
    expect(JSON.stringify(chat.messages)).toContain("https://a");

    const anthropic = withSearchResults(
      "anthropic",
      { system: "sys", tools: [{ type: "web_search_20250305" }] },
      "1. A",
    );
    expect(anthropic.tools).toEqual([]);
    expect(anthropic.system).toContain("sys");
    expect(anthropic.system).toContain("Web search results");

    const responses = withSearchResults("openai-responses", {}, "1. A");
    expect(responses.instructions).toContain("1. A");

    const gemini = withSearchResults("gemini", { systemInstruction: { parts: [] } }, "1. A");
    expect(JSON.stringify(gemini.systemInstruction)).toContain("Web search results");
  });
});
