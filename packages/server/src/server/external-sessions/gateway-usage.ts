import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { ExternalSessionTokens, ExternalSessionVia } from "./types.js";

// debt: reads the ledger tail instead of indexing it; add an offset index if the ledger outgrows a few hundred MB.
const LEDGER_MAX_BYTES = 64 * 1024 * 1024;
const CLIENT_AGENTS: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
};

export interface GatewaySessionUsage {
  agent: string;
  session: string;
  start: string;
  last: string;
  tokens: ExternalSessionTokens;
  cost: number;
  via: ExternalSessionVia[];
}

interface Cache {
  mtimeMs: number;
  size: number;
  sessions: Map<string, GatewaySessionUsage>;
}

let cache: Cache | null = null;

/** Sessions the gateway served, as its usage ledger names them. */
export async function readGatewaySessionUsage(
  neolixHome: string,
): Promise<Map<string, GatewaySessionUsage>> {
  const file = path.join(neolixHome, "gateway-usage.jsonl");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    cache = null;
    return new Map();
  }
  if (cache !== null && cache.mtimeMs === info.mtimeMs && cache.size === info.size) {
    return cache.sessions;
  }
  const text = await readTail(file, info.size);
  const sessions = tally(text);
  cache = { mtimeMs: info.mtimeMs, size: info.size, sessions };
  return sessions;
}

export function identityOf(agent: string, session: string): string {
  return `${agent}\u0000${session}`;
}

async function readTail(file: string, size: number): Promise<string> {
  const length = Math.min(size, LEDGER_MAX_BYTES);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    if (length === size) {
      return text;
    }
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
  } finally {
    await handle.close();
  }
}

function tally(text: string): Map<string, GatewaySessionUsage> {
  const out = new Map<string, GatewaySessionUsage>();
  for (const line of text.split("\n")) {
    const record = parseRecord(line);
    if (record !== null) {
      accumulate(out, record);
    }
  }
  return out;
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accumulate(out: Map<string, GatewaySessionUsage>, record: Record<string, unknown>): void {
  if (record.ok !== true) {
    return;
  }
  const session = typeof record.session === "string" ? record.session.trim() : "";
  const client = typeof record.client === "string" ? record.client : "";
  const agent = CLIENT_AGENTS[client];
  const time = typeof record.time === "string" ? record.time : "";
  if (session.length === 0 || agent === undefined || time.length === 0) {
    return;
  }
  const key = identityOf(agent, session);
  const entry = out.get(key) ?? {
    agent,
    session,
    start: time,
    last: time,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    via: [],
  };
  applyRecord(entry, record, time);
  out.set(key, entry);
}

function applyRecord(
  entry: GatewaySessionUsage,
  record: Record<string, unknown>,
  time: string,
): void {
  entry.start = time < entry.start ? time : entry.start;
  entry.last = time > entry.last ? time : entry.last;
  entry.tokens.input += number(record.inputTokens);
  entry.tokens.output += number(record.outputTokens);
  entry.tokens.cacheRead += number(record.cacheReadTokens);
  entry.tokens.cacheWrite += number(record.cacheWriteTokens);
  entry.cost += number(record.costUsd);
  const requested = typeof record.requested === "string" ? record.requested : "";
  const served = typeof record.model === "string" ? record.model : "";
  if (requested.length === 0 || served.length === 0) {
    return;
  }
  const seen = entry.via.some((via) => via.requested === requested && via.model === served);
  if (!seen && entry.via.length < 6) {
    entry.via.push({ requested, model: served });
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
