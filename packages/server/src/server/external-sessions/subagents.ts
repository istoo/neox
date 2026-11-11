import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { cleanTitle } from "./read-session.js";
import type { ExternalSubagent, SessionFile } from "./types.js";

// debt: a session's subagents are capped so one huge fan-out can't stall the list;
// read them lazily per session if deeper nests must show.
const SUBAGENT_MAX = 200;
const TITLE_BYTES = 400_000;

/** A Claude Code subagent's own transcript, beside its session's. */
export function claudeSubagentPath(mainFile: SessionFile, sub: string): string | null {
  if (!/^[0-9A-Za-z_-]+$/u.test(sub)) {
    return null;
  }
  return path.join(path.dirname(mainFile.path), mainFile.id, "subagents", `agent-${sub}.jsonl`);
}

/**
 * The subagents a Claude Code session started, oldest first: each keeps its
 * conversation in `agent-<id>.jsonl`, and what it was asked in the meta file
 * beside it (or its own first user line when the meta names no task).
 */
export async function listClaudeSubagents(file: SessionFile): Promise<ExternalSubagent[]> {
  const dir = path.join(path.dirname(file.path), file.id, "subagents");
  const entries = await readdir(dir).catch(() => []);
  const out: ExternalSubagent[] = [];
  for (const name of entries.sort()) {
    if (out.length >= SUBAGENT_MAX || !name.startsWith("agent-") || !name.endsWith(".jsonl")) {
      continue;
    }
    const id = name.slice("agent-".length, -".jsonl".length);
    // A compaction's own run is not a subagent anyone started.
    if (id.length === 0 || id.startsWith("acompact-")) {
      continue;
    }
    const filePath = path.join(dir, name);
    const info = await stat(filePath).catch(() => null);
    if (info === null) {
      continue;
    }
    const meta = await readClaudeMeta(filePath);
    const title = meta.description.length > 0 ? meta.description : await readClaudeTask(filePath);
    out.push({
      id,
      title,
      kind: meta.agentType,
      ...(meta.parentAgentId.length > 0 ? { parent: meta.parentAgentId } : {}),
      start: new Date(info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs).toISOString(),
      last: new Date(info.mtimeMs).toISOString(),
    });
  }
  out.sort((a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.id.localeCompare(b.id));
  return out;
}

interface ClaudeSubagentMeta {
  agentType: string;
  description: string;
  parentAgentId: string;
}

async function readClaudeMeta(filePath: string): Promise<ClaudeSubagentMeta> {
  const text = await readFile(filePath.replace(/\.jsonl$/u, ".meta.json"), "utf8").catch(() => "");
  if (text.length === 0) {
    return { agentType: "", description: "", parentAgentId: "" };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const record =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      agentType: stringOf(record.agentType),
      description: cleanTitle(stringOf(record.description)),
      parentAgentId: stringOf(record.parentAgentId),
    };
  } catch {
    return { agentType: "", description: "", parentAgentId: "" };
  }
}

/** The first user line of a subagent's file, which is what it was asked. */
async function readClaudeTask(filePath: string): Promise<string> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let read = 0;
  try {
    for await (const line of lines) {
      read += line.length;
      if (read > TITLE_BYTES) {
        break;
      }
      if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) {
        continue;
      }
      const event = parseRecord(line);
      if (event === null || event.type !== "user" || event.isMeta === true) {
        continue;
      }
      const message = asRecord(event.message);
      if (message === null) {
        continue;
      }
      const title = cleanTitle(claudeText(message.content));
      if (title.length > 0) {
        return title;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return "";
}

function claudeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = asRecord(part);
      return record !== null && record.type === "text" && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseRecord(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
