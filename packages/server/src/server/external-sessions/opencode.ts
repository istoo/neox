import type { ExternalSession, ExternalSessionModel, ExternalSubagent } from "./types.js";
import { cleanTitle } from "./read-session.js";
import {
  readOpenCodeFirstPrompt,
  readOpenCodeMessages,
  readOpenCodeSessions,
  type OpenCodeRawMessage,
  type OpenCodeRawSession,
} from "./sqlite.js";
import { PartCollector, type Transcript } from "./transcript.js";

/**
 * OpenCode keeps its sessions in one database rather than a file each. They
 * are read only: Neolix never writes to it.
 *
 * debt: a session's own row is read as the page lists it, so deleting one
 * isn't offered; myna doesn't delete OpenCode sessions either.
 */
export function readOpenCodeListing(
  dbPath: string,
  knownRows?: readonly OpenCodeRawSession[],
): ExternalSession[] {
  const rows = knownRows ?? readOpenCodeSessions(dbPath);
  if (rows.length === 0) {
    return [];
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const children = new Map<string, ExternalSubagent[]>();
  const out: ExternalSession[] = [];
  for (const row of rows) {
    if (row.parent.length > 0) {
      const root = rootOf(row, byId);
      if (root === null || root === row.id) {
        continue;
      }
      const list = children.get(root) ?? [];
      list.push(subagentOf(row, root));
      children.set(root, list);
      continue;
    }
    out.push(sessionOf(dbPath, row));
  }
  for (const session of out) {
    const subagents = children.get(session.id);
    if (subagents !== undefined && subagents.length > 0) {
      subagents.sort(
        (a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.id.localeCompare(b.id),
      );
      session.subagents = subagents;
    }
  }
  return out;
}

/** A session's conversation as the database keeps it. */
export function readOpenCodeTranscript(
  dbPath: string,
  session: { id: string; store: "v1" | "v2" },
): Transcript {
  const collector = new PartCollector("file");
  for (const message of readOpenCodeMessages(dbPath, session)) {
    if (session.store === "v1") {
      readV1Message(message, collector);
    } else {
      readV2Message(message, collector);
    }
  }
  return collector.finish();
}

/** Which of OpenCode's two stores holds a session id. */
export function openCodeStoreOf(
  dbPath: string,
  id: string,
): { id: string; store: "v1" | "v2" } | null {
  for (const row of readOpenCodeSessions(dbPath)) {
    if (row.id === id) {
      return { id, store: row.store };
    }
  }
  return null;
}

function sessionOf(dbPath: string, row: OpenCodeRawSession): ExternalSession {
  const title = row.title.length > 0 ? cleanTitle(row.title) : openCodeTitle(dbPath, row);
  const model = modelOf(row.model);
  const models: ExternalSessionModel[] = [];
  if (model.id.length > 0) {
    models.push({
      model: model.id,
      ...(model.effort === undefined ? {} : { effort: model.effort }),
      tokens: {
        input: row.tokens.input,
        output: row.tokens.output,
        cacheRead: row.tokens.cacheRead,
        cacheWrite: row.tokens.cacheWrite,
      },
      cost: row.cost,
      priced: row.cost > 0,
    });
  }
  return {
    id: row.id,
    agent: "opencode",
    cwd: row.directory,
    title: title.length > 0 ? title : row.id,
    start: isoOf(row.created),
    last: isoOf(row.updated),
    messages: row.messages,
    size: 0,
    tokens: {
      input: row.tokens.input,
      output: row.tokens.output,
      cacheRead: row.tokens.cacheRead,
      cacheWrite: row.tokens.cacheWrite,
    },
    models,
    cost: row.cost,
    priced: row.cost > 0,
    resume: `opencode --session ${row.id}`,
    path: `${dbPath}#${row.id}`,
    deletable: false,
  };
}

function subagentOf(row: OpenCodeRawSession, root: string): ExternalSubagent {
  const named = splitSubagentTitle(row.title);
  const title = named.title.length > 0 ? named.title : openCodeTitleForSubagent(row);
  const kind = row.agent.length > 0 ? row.agent : named.kind;
  return {
    id: row.id,
    title,
    kind,
    ...(row.parent !== root ? { parent: row.parent } : {}),
    start: isoOf(row.created),
    last: isoOf(row.updated),
  };
}

function openCodeTitle(dbPath: string, row: OpenCodeRawSession): string {
  return cleanTitle(readOpenCodeFirstPrompt(dbPath, { id: row.id, store: row.store }));
}

function openCodeTitleForSubagent(row: OpenCodeRawSession): string {
  return cleanTitle(row.title);
}

/** "<description> (@<agent> subagent)" as OpenCode names a subagent's row. */
export function splitSubagentTitle(title: string): { title: string; kind: string } {
  const named = cleanTitle(title);
  if (!named.endsWith(" subagent)")) {
    return { title: named, kind: "" };
  }
  const rest = named.slice(0, -" subagent)".length);
  const at = rest.lastIndexOf(" (@");
  if (at <= 0) {
    return { title: named, kind: "" };
  }
  return { title: rest.slice(0, at).trim(), kind: rest.slice(at + 3) };
}

function rootOf(row: OpenCodeRawSession, byId: Map<string, OpenCodeRawSession>): string | null {
  let current = row;
  for (let step = 0; step < 64 && current.parent.length > 0; step += 1) {
    const parent = byId.get(current.parent);
    if (parent === undefined) {
      return null;
    }
    current = parent;
  }
  return current.parent.length === 0 ? current.id : null;
}

function modelOf(text: string): { id: string; effort?: string } {
  if (text.length === 0) {
    return { id: "" };
  }
  try {
    return modelOfRecord(JSON.parse(text));
  } catch {
    return { id: "" };
  }
}

function modelOfRecord(value: unknown): { id: string; effort?: string } {
  const record = asRecord(value);
  if (record === null) {
    return { id: "" };
  }
  const id = typeof record.id === "string" ? record.id : "";
  const variant = typeof record.variant === "string" ? record.variant : "";
  return variant.length > 0 && variant !== "default" ? { id, effort: variant } : { id };
}

function readV2Message(message: OpenCodeRawMessage, out: PartCollector): void {
  const data = parseRecord(message.data);
  if (data === null) {
    return;
  }
  if (message.kind === "user") {
    out.add(textPart("user", textOf(data.text)));
    return;
  }
  if (message.kind === "compaction") {
    out.add({ role: "user", kind: "context", text: textOf(data.summary) || textOf(data.text) });
    return;
  }
  if (message.kind !== "assistant") {
    return;
  }
  const model = modelOfRecord(data.model);
  const content = Array.isArray(data.content) ? data.content : [];
  for (const value of content) {
    const block = asRecord(value);
    if (block === null) {
      continue;
    }
    const type = textOf(block.type);
    if (type === "text") {
      out.add(textPart("assistant", textOf(block.text), model.id));
    } else if (type === "reasoning") {
      out.add({
        role: "assistant",
        kind: "thinking",
        text: textOf(block.text) || textOf(block.thinking),
        ...(model.id.length === 0 ? {} : { model: model.id }),
      });
    } else if (type === "tool" && typeof block.name === "string") {
      const state = asRecord(block.state);
      out.add({
        role: "assistant",
        kind: "tool_use",
        name: block.name,
        text: pretty(state?.input),
        ...(model.id.length === 0 ? {} : { model: model.id }),
      });
      const result = state === null ? "" : toolOutputOf(state);
      if (result.length > 0) {
        out.add({ role: "tool", kind: "tool_result", name: block.name, text: result });
      }
    }
  }
}

function readV1Message(message: OpenCodeRawMessage, out: PartCollector): void {
  const data = parseRecord(message.data);
  const role = message.kind === "user" || message.kind === "assistant" ? message.kind : "";
  if (data === null || role.length === 0) {
    return;
  }
  const model = typeof data.modelID === "string" ? data.modelID : "";
  for (const text of message.parts) {
    const part = parseRecord(text);
    if (part === null) {
      continue;
    }
    const type = textOf(part.type);
    if (type === "text") {
      if (part.ignored === true) {
        continue;
      }
      out.add(textPart(role, textOf(part.text), role === "assistant" ? model : undefined));
    } else if (type === "reasoning") {
      out.add({
        role: "assistant",
        kind: "thinking",
        text: textOf(part.text),
        ...(model.length === 0 ? {} : { model }),
      });
    } else if (type === "tool" && typeof part.tool === "string") {
      const state = asRecord(part.state);
      out.add({
        role: "assistant",
        kind: "tool_use",
        name: part.tool,
        text: pretty(state?.input),
        ...(model.length === 0 ? {} : { model }),
      });
      const result = state === null ? "" : toolOutputOf(state);
      if (result.length > 0) {
        out.add({ role: "tool", kind: "tool_result", name: part.tool, text: result });
      }
    }
  }
}

/** A tool call's output, however a store writes it. */
function toolOutputOf(state: Record<string, unknown>): string {
  if (typeof state.output === "string") {
    return state.output;
  }
  const content = state.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((value) => {
      const block = asRecord(value);
      return block !== null && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function textPart(
  role: string,
  text: string,
  model?: string,
): {
  role: string;
  kind: string;
  text: string;
  model?: string;
} {
  const head = text.trimStart();
  const kind = head.startsWith("<") || head.startsWith("# AGENTS.md") ? "context" : "text";
  return model === undefined ? { role, kind, text } : { role, kind, text, model };
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isoOf(ms: number): string {
  return ms > 0 ? new Date(ms).toISOString() : "";
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
