/**
 * After a search the gateway ran for a model, the model's answer names the
 * pages it used by their addresses. An Anthropic client is told which
 * pages a line cites as Anthropic's own search tells it: a text block
 * whose citations are web_search_result_location entries for the pages of
 * the reply's web_search_tool_result blocks (myna's search_cite.go). A
 * line naming a page found is its own text block with those citations;
 * the lines between them run together as before. The text is the model's,
 * unchanged.
 */

import type { IrCitation, IrEvent } from "./ir.js";

/** A page a search found, as the citer reads it. */
export interface CitePage {
  url: string;
  title: string;
  /** What the search said of the page, quoted by a citation. */
  text?: string;
}

export interface CitedLine {
  text: string;
  citations: IrCitation[];
  /** Whitespace held after the last line, said on the block last. */
  tail: boolean;
}

/** How much of a page's text a citation quotes, as Anthropic's does. */
const CITED_MOST = 150;
const URL_END = " \t\r\n)]}>\"'`|";

function withoutSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function firstRunes(text: string, count: number): string {
  return [...text].slice(0, count).join("");
}

/** Whether what follows a URL ends its naming of it. */
function urlEnds(rest: string): boolean {
  const trimmed = rest.replace(/^[.,;:!?*_]+/u, "");
  if (trimmed === "") {
    return true;
  }
  return trimmed.charCodeAt(0) >= 0x80 || URL_END.includes(trimmed[0] ?? "");
}

/** Where a line names the address, the whole of it; -1 when it doesn't. */
export function urlIn(line: string, url: string): number {
  let from = 0;
  for (;;) {
    const found = line.indexOf(url, from);
    if (found < 0) {
      return -1;
    }
    const rest = line.slice(found + url.length);
    if (urlEnds(rest.startsWith("/") ? rest.slice(1) : rest)) {
      return found;
    }
    from = found + 1;
  }
}

/** The citations of the pages a line names, in the order it names them. */
export function citesOf(line: string, pages: readonly CitePage[]): IrCitation[] {
  const found: { at: number; page: CitePage }[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const url = withoutSlash(page.url);
    if (url === "" || seen.has(url)) {
      continue;
    }
    const at = urlIn(line, url);
    if (at >= 0) {
      seen.add(url);
      found.push({ at, page });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return found.map(({ page }) => ({
    type: "web_search_result_location",
    url: page.url,
    title: page.title,
    encrypted_index: "",
    cited_text: firstRunes((page.text ?? "").trim(), CITED_MOST),
  }));
}

/**
 * Cuts a reply's text into lines once a search has found pages, and says
 * which pages each line cites. A whitespace-only line is held for the
 * next, so no block is whitespace alone.
 */
export class Citer {
  private readonly pages: readonly CitePage[];
  private line = "";
  private held = "";

  public constructor(pages: readonly CitePage[]) {
    this.pages = pages;
  }

  /** Whether there are pages a line may cite. */
  public on(): boolean {
    return this.pages.length > 0;
  }

  /** Takes text and says each line it ends: its text and citations. */
  public feed(text: string): CitedLine[] {
    this.line += text;
    const out: CitedLine[] = [];
    for (;;) {
      const at = this.line.indexOf("\n");
      if (at < 0) {
        return out;
      }
      const line = this.line.slice(0, at + 1);
      this.line = this.line.slice(at + 1);
      const said = this.end(line);
      if (said !== null) {
        out.push(said);
      }
    }
  }

  /** Says what is left: a line not ended, and the whitespace held. */
  public flush(): CitedLine[] {
    const line = this.line;
    this.line = "";
    if (line.trim() !== "") {
      const said = this.end(line);
      return said === null ? [] : [said];
    }
    const rest = this.held + line;
    this.held = "";
    return rest === "" ? [] : [{ text: rest, citations: [], tail: true }];
  }

  private end(line: string): CitedLine | null {
    if (line.trim() === "") {
      this.held += line;
      return null;
    }
    const said = this.held + line;
    this.held = "";
    return { text: said, citations: citesOf(said, this.pages), tail: false };
  }
}

/** A whole reply's text as the cited lines it says. */
export function citeText(
  text: string,
  pages: readonly CitePage[],
): { text: string; citations?: IrCitation[] }[] {
  const citer = new Citer(pages);
  const lines = [...citer.feed(text), ...citer.flush()];
  return lines.map((line) => {
    const part: { text: string; citations?: IrCitation[] } = { text: line.text };
    if (line.citations.length > 0) {
      part.citations = line.citations;
    }
    return part;
  });
}

/** A translated reply's events with its text cut into cited lines. */
export class CiteStream {
  private readonly citer: Citer;

  public constructor(pages: readonly CitePage[]) {
    this.citer = new Citer(pages);
  }

  public push(event: IrEvent): IrEvent[] {
    if (!this.citer.on() || event.type !== "text_delta") {
      return [event];
    }
    return this.citer.feed(event.text).map((line) => this.event(line));
  }

  public flush(): IrEvent[] {
    if (!this.citer.on()) {
      return [];
    }
    return this.citer.flush().map((line) => this.event(line));
  }

  private event(line: CitedLine): IrEvent {
    return {
      type: "text_delta",
      text: line.text,
      ...(line.citations.length === 0 ? {} : { citations: line.citations }),
    };
  }
}
