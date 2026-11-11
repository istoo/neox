import { describe, expect, it } from "vitest";
import { afterEach } from "vitest";
import {
  askSearchApi,
  buildSearchAsk,
  parseSearchReply,
  readySearchApis,
  searchBase,
  searchKeys,
  searchRestFor,
  SearchKeyPicker,
} from "./search-apis.js";
import { configurePluginSearch } from "./plugin-search.js";
import pino from "pino";

describe("search APIs", () => {
  it("lists a vendor's keys once, split on commas, spaces and lines", () => {
    expect(searchKeys({ vendor: "tavily", key: "a, b;\nc\na" })).toEqual(["a", "b", "c"]);
  });

  it("keeps only the APIs that are ready and on", () => {
    const apis = readySearchApis([
      { vendor: "tavily", key: "a" },
      { vendor: "tavily", key: "b", off: true },
      { vendor: "searxng" },
      { vendor: "searxng", url: "https://searx.example" },
      { vendor: "unknown", key: "x" },
    ]);
    expect(apis.map((api) => api.vendor)).toEqual(["tavily", "searxng"]);
  });

  it("takes a base URL without the vendor's own path", () => {
    expect(searchBase({ vendor: "tavily", url: "https://api.tavily.com/search/" })).toBe(
      "https://api.tavily.com",
    );
    expect(searchBase({ vendor: "searxng", url: "https://searx.example" })).toBe(
      "https://searx.example",
    );
  });

  it("asks Tavily and Brave as myna does", () => {
    const tavily = buildSearchAsk({ vendor: "tavily", key: "tv" }, "tv", "weather");
    expect(tavily.url).toBe("https://api.tavily.com/search");
    expect(tavily.headers.authorization).toBe("Bearer tv");
    expect(tavily.body).toMatchObject({ query: "weather" });

    const brave = buildSearchAsk({ vendor: "brave" }, "br", "weather");
    expect(brave.method).toBe("GET");
    expect(brave.url).toContain("/res/v1/web/search?q=weather");
    expect(brave.headers["x-subscription-token"]).toBe("br");
  });

  it("reads the pages of each reply shape", () => {
    expect(
      parseSearchReply("tavily", { results: [{ title: "A", url: "https://a", content: "x" }] }),
    ).toEqual([{ title: "A", url: "https://a", text: "x" }]);
    expect(
      parseSearchReply("brave", { web: { results: [{ title: "B", url: "https://b" }] } }),
    ).toEqual([{ title: "B", url: "https://b", text: "" }]);
    expect(
      parseSearchReply("firecrawl", { data: { web: [{ title: "C", url: "https://c" }] } }),
    ).toEqual([{ title: "C", url: "https://c", text: "" }]);
    expect(parseSearchReply("you", { hits: [{ title: "D", url: "https://d" }] })).toEqual([
      { title: "D", url: "https://d", text: "" },
    ]);
  });

  it("takes a refused key last in order, and turns otherwise", () => {
    let now = 1_000;
    const picker = new SearchKeyPicker(() => now);
    const order = { vendor: "tavily", key: "a,b", pick: "order" as const };
    expect(picker.pick(order)).toBe("a");
    picker.refuse(order, "a", 401);
    expect(picker.pick(order)).toBe("b");
    now += 601_000;
    expect(picker.pick(order)).toBe("a");

    const turns = { vendor: "tavily", key: "a,b" };
    expect(picker.pick(turns)).toBe("a");
    expect(picker.pick(turns)).toBe("b");
    expect(picker.pick(turns)).toBe("a");
  });

  it("rests a key as long as its refusal says", () => {
    expect(searchRestFor("tavily", 401, null)).toBe(600_000);
    expect(searchRestFor("tavily", 402, null)).toBe(3_600_000);
    expect(searchRestFor("tavily", 432, null)).toBe(3_600_000);
    expect(searchRestFor("brave", 432, null)).toBe(60_000);
    expect(searchRestFor("brave", 429, "120")).toBe(120_000);
    expect(searchRestFor("brave", 429, "5")).toBe(30_000);
    expect(searchRestFor("brave", 429, "9999")).toBe(600_000);
  });
});

describe("plugin search APIs", () => {
  afterEach(() => {
    configurePluginSearch(null);
  });

  it("takes a plugin vendor where a built-in one goes", () => {
    configurePluginSearch({
      list: () => [{ vendor: "plugin:acme:web", name: "Acme", keyOptional: true, needURL: true }],
      run: async () => [{ title: "Hit", url: "https://a", text: "found" }],
    });
    const ready = readySearchApis([
      { vendor: "plugin:acme:web", url: "https://search.acme" },
      { vendor: "plugin:acme:web" },
      { vendor: "plugin:acme:web", url: "https://search.acme", off: true },
    ]);
    expect(ready).toHaveLength(1);
    expect(searchBase({ vendor: "plugin:acme:web", url: "https://search.acme/" })).toBe(
      "https://search.acme/",
    );
  });

  it("asks the plugin and reads its pages", async () => {
    const seen: Array<unknown> = [];
    configurePluginSearch({
      list: () => [{ vendor: "plugin:acme:web", name: "Acme", keyOptional: true }],
      run: async (vendor, input) => {
        seen.push({ vendor, input });
        return [
          { title: "Hit", url: "https://a", text: "found", age: "2026-01-01" },
          { title: 4 },
          "nope",
        ];
      },
    });
    const pages = await askSearchApi({
      api: { vendor: "plugin:acme:web" },
      key: null,
      query: "neolix",
      logger: pino({ level: "silent" }),
    });
    expect(seen).toEqual([
      { vendor: "plugin:acme:web", input: { query: "neolix", key: null, url: null } },
    ]);
    expect(pages).toEqual([{ title: "Hit", url: "https://a", text: "found", age: "2026-01-01" }]);
  });
});
