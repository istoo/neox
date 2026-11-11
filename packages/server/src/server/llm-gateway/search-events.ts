/**
 * A search the gateway ran for a model that can't search by itself is told
 * to the client as the provider's own: Anthropic's server_tool_use and
 * web_search_tool_result blocks, which Claude Code's WebSearch counts and
 * takes its links from, or a Responses web_search_call item
 * (myna's search_cite.go and the encoders' KSearch).
 */
import { randomUUID } from "node:crypto";
import type { IrSearchPage } from "./ir.js";

type Json = Record<string, unknown>;

/** The id a search's tool_use and its result share. */
export function searchToolId(): string {
  return `srvtoolu_${randomUUID().replaceAll("-", "")}`;
}

/** The search item a Responses client sees. */
export function searchItem(query: string, id: string, pages: readonly IrSearchPage[]): Json {
  const sources = pages
    .filter((page) => page.url.length > 0)
    .map((page) => ({ type: "url", url: page.url }));
  return {
    id,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query, queries: [query], sources },
  };
}

/** Anthropic's own block of the pages a search found. */
function searchResultBlock(toolId: string, pages: readonly IrSearchPage[]): Json {
  return {
    type: "web_search_tool_result",
    tool_use_id: toolId,
    content: pages.map((page) => ({
      type: "web_search_result",
      title: page.title,
      url: page.url,
      // The searcher's own sealed content is not another vendor's to carry.
      encrypted_content: "",
      ...(page.age === undefined ? {} : { page_age: page.age }),
    })),
  };
}

/** The two Anthropic blocks a search is told in: its call, then its pages. */
export function anthropicSearchBlocks(
  toolId: string,
  query: string,
  pages: readonly IrSearchPage[],
): Json[] {
  return [
    { type: "server_tool_use", id: toolId, name: "web_search", input: { query } },
    searchResultBlock(toolId, pages),
  ];
}

/** The second block alone, for a stream that opened the call itself. */
export function anthropicSearchResultBlock(toolId: string, pages: readonly IrSearchPage[]): Json {
  return searchResultBlock(toolId, pages);
}
