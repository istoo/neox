/**
 * A search the gateway ran for a model that can't search by itself is told
 * to the client as the provider's own: Anthropic's server_tool_use and
 * web_search_tool_result blocks, which Claude Code's WebSearch counts and
 * takes its links from, or a Responses web_search_call item
 * (myna's search_cite.go and the encoders' KSearch).
 */
import { randomUUID } from "node:crypto";
import type { IrCitation, IrSearchPage } from "./ir.js";
import { urlIn } from "./search-cite.js";

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

/**
 * Where a line names a page's address, -1 when it doesn't. A page kept with
 * its trailing slash is also found as the line spells it (search-cite.ts's
 * citesOf reads both forms).
 */
function citationAt(text: string, url: string): { at: number; length: number } {
  const at = urlIn(text, url);
  if (at >= 0) {
    return { at, length: url.length };
  }
  const cut = url.endsWith("/") ? url.slice(0, -1) : url;
  const withoutSlash = cut === "" ? -1 : urlIn(text, cut);
  return withoutSlash < 0 ? { at: -1, length: 0 } : { at: withoutSlash, length: cut.length };
}

/**
 * A cited line's pages as the annotations OpenAI's Chat and Responses APIs
 * use: the address's own span in the reply's text, offset by what came
 * before this line (OpenAI's url_citation).
 */
export function urlCitationAnnotations(
  text: string,
  citations: readonly IrCitation[],
  offset: number,
): Json[] {
  const annotations: Json[] = [];
  for (const citation of citations) {
    const found = citationAt(text, citation.url);
    if (found.at < 0) {
      continue;
    }
    annotations.push({
      type: "url_citation",
      url_citation: {
        url: citation.url,
        title: citation.title,
        start_index: offset + found.at,
        end_index: offset + found.at + found.length,
      },
    });
  }
  return annotations;
}

/**
 * Gemini's groundingMetadata: the pages a reply cited, each once, and the
 * span of text that cited it (Gemini's own groundingChunks and
 * groundingSupports). A line of citations is one support; its pages are
 * numbered as the chunks list them.
 */
export class GeminiGrounding {
  private readonly queries: string[] = [];
  private readonly chunks: Json[] = [];
  private readonly chunkIndex = new Map<string, number>();
  private readonly supports: Json[] = [];

  /** The search queries the reply ran, for webSearchQueries. */
  public search(query: string): void {
    if (query.length > 0 && !this.queries.includes(query)) {
      this.queries.push(query);
    }
  }

  /** A line of text and the pages it cites, at its offset in the reply. */
  public cite(text: string, citations: readonly IrCitation[], offset: number): void {
    if (citations.length === 0) {
      return;
    }
    const indices: number[] = [];
    for (const citation of citations) {
      let index = this.chunkIndex.get(citation.url);
      if (index === undefined) {
        index = this.chunks.length;
        this.chunkIndex.set(citation.url, index);
        this.chunks.push({
          web: {
            uri: citation.url,
            ...(citation.title.length === 0 ? {} : { title: citation.title }),
          },
        });
      }
      if (!indices.includes(index)) {
        indices.push(index);
      }
    }
    this.supports.push({
      segment: { startIndex: offset, endIndex: offset + [...text].length, text },
      groundingChunkIndices: indices,
    });
  }

  /** The metadata so far, or null when the reply cited nothing and searched nothing. */
  public metadata(): Json | null {
    if (this.queries.length === 0 && this.chunks.length === 0) {
      return null;
    }
    return {
      ...(this.queries.length === 0 ? {} : { webSearchQueries: this.queries }),
      ...(this.chunks.length === 0 ? {} : { groundingChunks: this.chunks }),
      ...(this.supports.length === 0 ? {} : { groundingSupports: this.supports }),
    };
  }
}
