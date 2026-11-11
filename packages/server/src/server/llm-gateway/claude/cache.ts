/** The header a caller sends to have its own cache marks replayed. */
export const CACHE_MARKS_HEADER = "x-neolix-cache-marks";
/** myna's name for the same header: clients configured for myna keep working. */
export const MAGPIE_CACHE_MARKS_HEADER = "x-magpie-cache-marks";
/** The header that says how many of the caller's marks could not be used. */
export const CACHE_MARKS_DROPPED_HEADER = "x-neolix-cache-marks-dropped";

export type CacheTtl = "5m" | "1h";

export interface CacheMark {
  /** Where the marked block ends, in characters of the text it marks. */
  end: number;
  ttl: CacheTtl;
}

export interface ClientCacheMarks {
  system: CacheMark[];
  /** Marks of each message, by its index in the caller's messages. */
  messages: Map<number, CacheMark[]>;
  /** Marks on tools, which Claude Code keeps itself. */
  tools: number;
  /** Marks that named no block of text, or came out of order. */
  dropped: number;
}

/** Whether a request opted in, by the header myna calls X-Magpie-Cache-Marks. */
export function wantsClientCacheMarks(headers: Record<string, unknown>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    const header = name.toLowerCase();
    if (
      (header === CACHE_MARKS_HEADER || header === MAGPIE_CACHE_MARKS_HEADER) &&
      typeof value === "string"
    ) {
      return value.trim().toLowerCase() === "client";
    }
  }
  return false;
}

/**
 * The caller's cache marks, read from the Anthropic request itself: the IR
 * keeps no `cache_control`, so the marks must be taken before translation.
 * A mark out of order, past its text, or on a block with no text is dropped
 * and counted, as myna drops them.
 */
export function readClientCacheMarks(body: Record<string, unknown>): ClientCacheMarks {
  const marks: ClientCacheMarks = { system: [], messages: new Map(), tools: 0, dropped: 0 };
  marks.system = marksOf(systemBlocks(body.system), marks);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, index) => {
    const record = asRecord(message);
    if (record === undefined) {
      return;
    }
    const found = marksOf(messageBlocks(record.content), marks);
    if (found.length > 0) {
      marks.messages.set(index, found);
    }
  });
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (hasCacheControl(tool)) {
      marks.tools += 1;
    }
  }
  return marks;
}

/** The dropped count as the reply says it, or null when nothing was dropped. */
export function droppedMarksHeader(marks: ClientCacheMarks): Record<string, string> {
  return marks.dropped === 0 ? {} : { [CACHE_MARKS_DROPPED_HEADER]: String(marks.dropped) };
}

/**
 * Splits text at its marks: each piece ends where a mark ended, and carries
 * that mark's TTL. The tail after the last mark carries none.
 */
export function splitTextAtMarks(
  text: string,
  marks: readonly CacheMark[],
): Array<{ text: string; ttl?: CacheTtl }> {
  const pieces: Array<{ text: string; ttl?: CacheTtl }> = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.end <= at || mark.end > text.length) {
      continue;
    }
    const piece = text.slice(at, mark.end);
    if (piece !== "") {
      pieces.push({ text: piece, ttl: mark.ttl });
    }
    at = mark.end;
  }
  const tail = text.slice(at);
  if (tail !== "") {
    pieces.push({ text: tail });
  }
  return pieces;
}

interface CacheBlock {
  text: string;
  cache: Record<string, unknown> | null;
}

function systemBlocks(system: unknown): CacheBlock[] {
  if (typeof system === "string") {
    return [{ text: system, cache: null }];
  }
  if (!Array.isArray(system)) {
    return [];
  }
  const blocks: CacheBlock[] = [];
  for (const block of system) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      blocks.push({ text: block.text, cache: cacheControlOf(block) });
    }
  }
  return blocks;
}

function messageBlocks(content: unknown): CacheBlock[] {
  if (typeof content === "string") {
    return [{ text: content, cache: null }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: CacheBlock[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      blocks.push({ text: block.text, cache: cacheControlOf(block) });
    }
  }
  return blocks;
}

function marksOf(blocks: readonly CacheBlock[], marks: ClientCacheMarks): CacheMark[] {
  const out: CacheMark[] = [];
  let offset = 0;
  let previous = 0;
  for (const block of blocks) {
    offset += block.text.length;
    const ttl = ttlOf(block.cache);
    if (ttl === null) {
      continue;
    }
    if (block.text === "" || offset <= previous) {
      marks.dropped += 1;
      continue;
    }
    out.push({ end: offset, ttl });
    previous = offset;
  }
  return out;
}

function ttlOf(cache: Record<string, unknown> | null): CacheTtl | null {
  if (cache === null || cache.type !== "ephemeral") {
    return null;
  }
  return cache.ttl === "1h" ? "1h" : "5m";
}

function cacheControlOf(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const cache = value.cache_control;
  return isRecord(cache) ? cache : null;
}

function hasCacheControl(value: unknown): boolean {
  return cacheControlOf(value) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
