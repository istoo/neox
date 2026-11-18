import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionParse } from "./types.js";

/** Bump when a parsed field's meaning changes; an older file is ignored. */
export const PARSE_CACHE_VERSION = 1;

const CACHE_FILENAME = "external-sessions-parse-cache.json";

/** What one session file said, keyed by the mtime and size it was read at. */
export interface CachedParse {
  mtimeMs: number;
  size: number;
  metaKey: string;
  parse: SessionParse;
}

interface ParseCacheFile {
  version: number;
  entries: [string, CachedParse][];
}

/**
 * Session files are large and rewritten only while a session runs, so the
 * parse a daemon already did is worth keeping across daemon restarts. The
 * file lives beside the rest of Neolix's state, not in the agent's folder.
 */
export function parseCachePath(neolixHome: string): string {
  return path.join(neolixHome, CACHE_FILENAME);
}

export async function readParseCache(neolixHome: string): Promise<Map<string, CachedParse>> {
  const entries = new Map<string, CachedParse>();
  let text: string;
  try {
    text = await readFile(parseCachePath(neolixHome), "utf8");
  } catch {
    return entries;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return entries;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== PARSE_CACHE_VERSION
  ) {
    return entries;
  }
  const raw = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) {
    return entries;
  }
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const [key, cached] = entry as [unknown, unknown];
    if (typeof key !== "string" || !isCachedParse(cached)) {
      continue;
    }
    entries.set(key, cached);
  }
  return entries;
}

/** Replaces the whole file, so a reader sees the old cache or the new one. */
export async function writeParseCache(
  neolixHome: string,
  entries: Map<string, CachedParse>,
): Promise<void> {
  const target = parseCachePath(neolixHome);
  const body: ParseCacheFile = { version: PARSE_CACHE_VERSION, entries: [...entries] };
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(body)}\n`, "utf8");
  await rename(temp, target);
}

function isCachedParse(value: unknown): value is CachedParse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const cached = value as Partial<CachedParse>;
  return (
    typeof cached.mtimeMs === "number" &&
    typeof cached.size === "number" &&
    typeof cached.metaKey === "string" &&
    isParse(cached.parse)
  );
}

function isParse(value: unknown): value is SessionParse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const parse = value as Partial<SessionParse>;
  return (
    typeof parse.title === "string" &&
    typeof parse.cwd === "string" &&
    typeof parse.start === "string" &&
    typeof parse.last === "string" &&
    typeof parse.messages === "number" &&
    typeof parse.tokens === "object" &&
    parse.tokens !== null &&
    Array.isArray(parse.models) &&
    typeof parse.cost === "number" &&
    typeof parse.priced === "boolean"
  );
}
