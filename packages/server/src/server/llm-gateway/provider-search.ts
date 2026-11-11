import type { GatewayProvider } from "./config.js";
import type { FoundPage } from "./search-apis.js";

/**
 * myna's provider-as-searcher (gateway/search.go searchWith, searchBody):
 * when a model can't search the web itself, the searcher's own model is
 * asked once, with its provider's web-search tool, and its reply is read
 * for the pages it found. myna always asks itself on Anthropic's Messages
 * API and lets the gateway translate; Neolix asks on the searcher's own
 * wire instead, so the reply needs no second translation to be read.
 *
 * The request is the caller's: a `post` that reaches the gateway's own
 * endpoint for the protocol, carrying `provider/model` as the model. This
 * module only builds the body and reads the reply, so it can be tested
 * with a fixture.
 */

/** myna's searchSystem: the searcher reports pages, not what it remembers. */
export const SEARCH_SYSTEM =
  "You are a web search tool. Search the web for what is asked and report what the results say: the facts that answer it, as specifically as they are given (numbers, dates, versions, names), each with the title and URL of its page. Report only what the pages say; don't answer from memory, don't add advice. Be concise.";

/** How many pages a searcher's reply is read for. */
const MAX_PAGES = 20;
/** The output room a searcher's reply is given (myna's replyRoom 4096). */
const MAX_TOKENS = 4096;
/** How long one searcher is given (myna's searchTimeout). */
export const SEARCH_TIMEOUT_MS = 2 * 60_000;

export type SearchProtocol = GatewayProvider["protocol"];

export interface ProviderSearchRequest {
  path: string;
  protocol: SearchProtocol;
  body: Record<string, unknown>;
}

export interface ProviderSearchResult {
  /** What the searcher's model said, its pages' titles and URLs in it. */
  said: string;
  pages: FoundPage[];
  /** Whether the reply shows a search was run (myna's errNotSearched). */
  searched: boolean;
}

/**
 * What one searcher is asked, and where. `provider/model` as the model
 * makes the gateway route it to that provider; the path follows its wire.
 */
export function providerSearchRequest(
  provider: GatewayProvider,
  model: string,
  query: string,
): ProviderSearchRequest {
  const ref = `${provider.id}/${model}`;
  const asked = `Search the web for: ${query}`;
  switch (provider.protocol) {
    case "anthropic":
      return {
        path: "/v1/messages",
        protocol: "anthropic",
        body: {
          model: ref,
          max_tokens: MAX_TOKENS,
          stream: false,
          system: SEARCH_SYSTEM,
          messages: [{ role: "user", content: asked }],
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        },
      };
    case "openai-responses":
      return {
        path: "/v1/responses",
        protocol: "openai-responses",
        body: {
          model: ref,
          instructions: SEARCH_SYSTEM,
          input: asked,
          tools: [{ type: "web_search" }],
          max_output_tokens: MAX_TOKENS,
          stream: false,
          store: false,
        },
      };
    case "gemini":
      return {
        path: `/v1beta/models/${ref}:generateContent`,
        protocol: "gemini",
        body: {
          contents: [{ role: "user", parts: [{ text: asked }] }],
          systemInstruction: { parts: [{ text: SEARCH_SYSTEM }] },
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: MAX_TOKENS },
        },
      };
    default:
      return {
        path: "/v1/chat/completions",
        protocol: "openai",
        body: {
          model: ref,
          max_tokens: MAX_TOKENS,
          stream: false,
          messages: [
            { role: "system", content: SEARCH_SYSTEM },
            { role: "user", content: asked },
          ],
          web_search_options: {},
        },
      };
  }
}

/** One page as a reply names it: title, address, and what a citation quotes of it. */
interface FoundRef {
  title: string;
  url: string;
  text: string;
  age?: string;
}

/** The pages of a reply, each address once, in the order they were found. */
function collect(refs: readonly FoundRef[]): FoundPage[] {
  const out: FoundPage[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.url.length === 0 || seen.has(ref.url)) {
      continue;
    }
    seen.add(ref.url);
    out.push({
      title: ref.title.length === 0 ? ref.url : ref.title,
      url: ref.url,
      text: ref.text,
      ...(ref.age === undefined ? {} : { age: ref.age }),
    });
    if (out.length >= MAX_PAGES) {
      break;
    }
  }
  return out;
}

/** The refs with what the reply's citations quote of each page, where it said. */
function withQuoted(refs: readonly FoundRef[], quoted: ReadonlyMap<string, string>): FoundRef[] {
  return refs.map((ref) => {
    const cited = quoted.get(ref.url);
    if (cited === undefined) {
      return ref;
    }
    return {
      title: ref.title,
      url: ref.url,
      text: cited,
      ...(ref.age === undefined ? {} : { age: ref.age }),
    };
  });
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function addCitation(
  refs: FoundRef[],
  quoted: Map<string, string>,
  url: string,
  title: string,
  cited: string,
): void {
  if (url.length === 0) {
    return;
  }
  if (cited.length > 0 && !quoted.has(url)) {
    quoted.set(url, cited);
  }
  refs.push({ title, url, text: "" });
}

/** Reads Anthropic's Messages reply: its text, citations and search results. */
export function parseAnthropicSearch(reply: unknown): ProviderSearchResult {
  const content = listOf(recordOf(reply)?.content);
  let said = "";
  let searched = false;
  const refs: FoundRef[] = [];
  const quoted = new Map<string, string>();
  for (const raw of content) {
    const block = recordOf(raw);
    if (block === null) {
      continue;
    }
    const type = textOf(block.type);
    if (type === "text") {
      said += textOf(block.text);
      for (const citation of listOf(block.citations)) {
        const found = recordOf(citation);
        if (found !== null) {
          addCitation(
            refs,
            quoted,
            textOf(found.url),
            textOf(found.title),
            textOf(found.cited_text),
          );
        }
      }
      continue;
    }
    if (type === "server_tool_use") {
      searched = true;
      continue;
    }
    if (type !== "web_search_tool_result") {
      continue;
    }
    searched = true;
    for (const result of listOf(block.content)) {
      const page = recordOf(result);
      if (page === null || textOf(page.type) === "web_search_tool_result_error") {
        continue;
      }
      refs.push({
        title: textOf(page.title),
        url: textOf(page.url),
        text: "",
        ...(typeof page.page_age === "string" ? { age: page.page_age } : {}),
      });
    }
  }
  const pages = collect(withQuoted(refs, quoted));
  return { said: said.trim(), pages, searched };
}

/** Reads a Responses reply: its output text, citations and web_search_call sources. */
export function parseResponsesSearch(reply: unknown): ProviderSearchResult {
  const output = listOf(recordOf(reply)?.output);
  let said = "";
  let searched = false;
  const refs: FoundRef[] = [];
  const quoted = new Map<string, string>();
  for (const raw of output) {
    const item = recordOf(raw);
    if (item === null) {
      continue;
    }
    const type = textOf(item.type);
    if (type === "web_search_call") {
      searched = true;
      const action = recordOf(item.action);
      for (const source of listOf(action?.sources)) {
        const entry = recordOf(source);
        if (entry !== null) {
          addCitation(refs, quoted, textOf(entry.url), textOf(entry.title), "");
        }
      }
      for (const result of listOf(item.results)) {
        const entry = recordOf(result);
        if (entry !== null) {
          addCitation(
            refs,
            quoted,
            textOf(entry.url),
            textOf(entry.title),
            textOf(entry.snippet) || textOf(entry.text),
          );
        }
      }
      continue;
    }
    if (type !== "message") {
      continue;
    }
    for (const rawPart of listOf(item.content)) {
      const part = recordOf(rawPart);
      if (part === null) {
        continue;
      }
      said += textOf(part.text);
      for (const annotation of listOf(part.annotations)) {
        const found = recordOf(annotation);
        if (found !== null && textOf(found.type) === "url_citation") {
          addCitation(refs, quoted, textOf(found.url), textOf(found.title), "");
        }
      }
    }
  }
  const pages = collect(withQuoted(refs, quoted));
  return { said: said.trim(), pages, searched };
}

/** Reads a Gemini reply: its parts' text and the pages its grounding names. */
export function parseGeminiSearch(reply: unknown): ProviderSearchResult {
  const candidates = listOf(recordOf(reply)?.candidates);
  let said = "";
  const refs: FoundRef[] = [];
  const quoted = new Map<string, string>();
  let searched = false;
  for (const raw of candidates) {
    const candidate = recordOf(raw);
    if (candidate === null) {
      continue;
    }
    for (const rawPart of listOf(recordOf(candidate.content)?.parts)) {
      said += textOf(recordOf(rawPart)?.text);
    }
    const grounding = recordOf(candidate.groundingMetadata);
    if (grounding === undefined || grounding === null) {
      continue;
    }
    searched = true;
    readGrounding(grounding, refs, quoted);
  }
  const pages = collect(withQuoted(refs, quoted));
  return { said: said.trim(), pages, searched };
}

/** The pages a Gemini reply's grounding names, and what each supports. */
function readGrounding(
  grounding: Record<string, unknown>,
  refs: FoundRef[],
  quoted: Map<string, string>,
): void {
  const chunks = listOf(grounding.groundingChunks);
  for (const rawChunk of chunks) {
    const web = recordOf(recordOf(rawChunk)?.web);
    if (web !== null && web !== undefined) {
      addCitation(refs, quoted, textOf(web.uri), textOf(web.title), "");
    }
  }
  for (const rawSupport of listOf(grounding.groundingSupports)) {
    readSupport(rawSupport, chunks, quoted);
  }
}

/** What one grounding support says of the chunks it cites. */
function readSupport(raw: unknown, chunks: readonly unknown[], quoted: Map<string, string>): void {
  const support = recordOf(raw);
  const saidText = textOf(recordOf(support?.segment)?.text);
  if (saidText.length === 0) {
    return;
  }
  for (const index of listOf(support?.groundingChunkIndices)) {
    const web = recordOf(recordOf(chunks[Number(index)])?.web);
    const url = web === undefined || web === null ? "" : textOf(web.uri);
    if (url.length > 0 && !quoted.has(url)) {
      quoted.set(url, saidText);
    }
  }
}

/** Reads a Chat Completions reply: its text and url_citation annotations. */
export function parseChatSearch(reply: unknown): ProviderSearchResult {
  const choice = recordOf(listOf(recordOf(reply)?.choices)[0]);
  const message = recordOf(choice?.message);
  const said = textOf(message?.content);
  const refs: FoundRef[] = [];
  const quoted = new Map<string, string>();
  for (const raw of listOf(message?.annotations)) {
    const annotation = recordOf(raw);
    if (annotation !== null && textOf(annotation.type) === "url_citation") {
      addCitation(
        refs,
        quoted,
        textOf(annotation.url),
        textOf(annotation.title),
        textOf(annotation.text),
      );
    }
  }
  const pages = collect(withQuoted(refs, quoted));
  return { said: said.trim(), pages, searched: pages.length > 0 };
}

/** Reads one searcher's reply by the wire it was asked on. */
export function parseProviderSearch(
  protocol: SearchProtocol,
  reply: unknown,
): ProviderSearchResult {
  switch (protocol) {
    case "anthropic":
      return parseAnthropicSearch(reply);
    case "openai-responses":
      return parseResponsesSearch(reply);
    case "gemini":
      return parseGeminiSearch(reply);
    default:
      return parseChatSearch(reply);
  }
}

/**
 * Whether a searcher's reply is usable, myna's searchWith: it shows a
 * search was run, and names a page. A reply that answered without
 * searching is not (errNotSearched), nor one whose search found no page
 * and whose text carries no address (errFoundNothing).
 */
export function providerSearchFound(result: ProviderSearchResult): boolean {
  if (result.pages.length > 0) {
    return true;
  }
  return result.searched && result.said.includes("://");
}

/**
 * Asks one searcher and reads what it found. `post` does the asking; it
 * should give the call SEARCH_TIMEOUT_MS at most and reject on a refusal.
 */
export async function searchWithProvider(input: {
  provider: GatewayProvider;
  model: string;
  query: string;
  post: (request: ProviderSearchRequest) => Promise<unknown>;
}): Promise<ProviderSearchResult> {
  const request = providerSearchRequest(input.provider, input.model, input.query);
  const reply = await input.post(request);
  return parseProviderSearch(request.protocol, reply);
}
