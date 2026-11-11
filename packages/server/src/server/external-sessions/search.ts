import { createInterface } from "node:readline";
import { createLineStream } from "./compressed.js";
import type { ExternalSessionHit } from "@neolix/protocol/messages";
import type { SessionFile } from "./types.js";

// debt: a linear scan of the newest files within a time budget; index the files when search must cover all history.
export const HIT_MAX = 200;
const PREVIEW_CHARS = 90;
const LINE_MAX = 2_000_000;

export interface SessionSearchResult {
  hits: ExternalSessionHit[];
  searched: number;
  total: number;
  cut: boolean;
}

export interface LineText {
  role: string;
  kind: string;
  text: string;
}

/** Reads the newest files first and stops at the first match in each. */
export async function searchSessionFiles(input: {
  agent: string;
  files: readonly SessionFile[];
  query: string;
  budgetMs: number;
  now?: () => number;
}): Promise<SessionSearchResult> {
  const needle = normalizeQuery(input.query);
  const result: SessionSearchResult = {
    hits: [],
    searched: 0,
    total: input.files.length,
    cut: false,
  };
  if (needle.length < 2) {
    return result;
  }
  const now = input.now ?? Date.now;
  const deadline = now() + input.budgetMs;
  for (const file of input.files) {
    if (result.hits.length >= HIT_MAX || now() > deadline) {
      result.cut = true;
      break;
    }
    result.searched += 1;
    const hit = await firstHit(file.path, input.agent, needle, deadline, now);
    if (hit !== null) {
      result.hits.push({ id: file.id, ...hit });
    }
  }
  if (result.searched < result.total) {
    result.cut = true;
  }
  return result;
}

export function normalizeQuery(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}

async function firstHit(
  filePath: string,
  agent: string,
  needle: string,
  deadline: number,
  now: () => number,
): Promise<Omit<ExternalSessionHit, "id"> | null> {
  const stream = createLineStream(filePath);
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (now() > deadline) {
        return null;
      }
      if (line.length === 0 || line.length > LINE_MAX) {
        continue;
      }
      const texts = textsOfLine(agent, line);
      for (const part of texts) {
        const hit = findInText(part, needle);
        if (hit !== null) {
          return hit;
        }
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** The best hit among a session's parts: one said, else the first anywhere. */
export function bestHitInParts(
  parts: readonly LineText[],
  needle: string,
): Omit<ExternalSessionHit, "id"> | null {
  let fallback: Omit<ExternalSessionHit, "id"> | null = null;
  for (const part of parts) {
    if (part.role === "system" || part.kind === "context" || part.kind === "image") {
      continue;
    }
    const hit = findInText(part, needle);
    if (hit === null) {
      continue;
    }
    if (part.kind === "text" && (part.role === "user" || part.role === "assistant")) {
      return hit;
    }
    fallback ??= hit;
  }
  return fallback;
}

function findInText(part: LineText, needle: string): Omit<ExternalSessionHit, "id"> | null {
  const lower = part.text.toLowerCase();
  const at = lower.indexOf(needle);
  if (at < 0) {
    return null;
  }
  const from = Math.max(0, at - PREVIEW_CHARS);
  const to = Math.min(part.text.length, at + needle.length + PREVIEW_CHARS);
  return {
    role: part.role,
    kind: part.kind,
    before: part.text.slice(from, at).replace(/\s+/gu, " "),
    match: part.text.slice(at, at + needle.length),
    after: part.text.slice(at + needle.length, to).replace(/\s+/gu, " "),
  };
}

/**
 * What one line of a session file says, in the agent's own shape. Only text a
 * reader would recognize is searched; tool payloads and harness notes are not.
 */
export function textsOfLine(agent: string, line: string): LineText[] {
  if (!line.startsWith("{")) {
    return [];
  }
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(event)) {
    return [];
  }
  if (agent === "claude") {
    return claudeTexts(event);
  }
  if (agent === "codex") {
    return codexTexts(event);
  }
  if (agent === "pi") {
    return piTexts(event);
  }
  return [];
}

function claudeTexts(event: Record<string, unknown>): LineText[] {
  if (event.isSidechain === true || event.isMeta === true) {
    return [];
  }
  const message = asRecord(event.message);
  if (message === null) {
    return [];
  }
  if (event.type !== "user" && event.type !== "assistant") {
    return [];
  }
  const text = contentText(message.content, ["text"]);
  return text.length === 0 ? [] : [{ role: event.type, kind: "text", text }];
}

function codexTexts(event: Record<string, unknown>): LineText[] {
  if (event.type !== "response_item") {
    return [];
  }
  const payload = asRecord(event.payload);
  if (payload === null || payload.type !== "message") {
    return [];
  }
  const role = typeof payload.role === "string" ? payload.role : "";
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  const text = contentText(payload.content, ["input_text", "output_text", "text"]);
  return text.length === 0 ? [] : [{ role, kind: "text", text }];
}

function piTexts(event: Record<string, unknown>): LineText[] {
  if (event.type !== "message") {
    return [];
  }
  const message = asRecord(event.message);
  if (message === null) {
    return [];
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return [];
  }
  const text = contentText(message.content, ["text"]);
  return text.length === 0 ? [] : [{ role, kind: "text", text }];
}

function contentText(content: unknown, kinds: readonly string[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const out: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record === null) {
      continue;
    }
    if (typeof record.type === "string" && !kinds.includes(record.type)) {
      continue;
    }
    if (typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
