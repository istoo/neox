import { DatabaseSync } from "node:sqlite";

// debt: node:sqlite exposes only a synchronous API. These run on user-requested
// actions (a Codex provider move) and on one cached read of OpenCode's own
// database per list, so the daemon's event loop blocks for the duration of one
// bounded query set. Move the reads into a worker if a session database ever
// grows enough for that to show.

/** Sets one Codex thread's provider in a state database; false when it has none. */
export function setCodexThreadProvider(dbPath: string, id: string, provider: string): boolean {
  const db = open(dbPath, false);
  try {
    if (!hasColumns(db, "threads", ["id", "model_provider"])) {
      return false;
    }
    const result = db
      .prepare("UPDATE threads SET model_provider = ? WHERE id = ?")
      .run(provider, id);
    return Number(result.changes) > 0;
  } finally {
    db.close();
  }
}

export interface OpenCodeRawTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenCodeRawSession {
  id: string;
  parent: string;
  directory: string;
  title: string;
  agent: string;
  model: string;
  cost: number;
  tokens: OpenCodeRawTokens;
  created: number;
  updated: number;
  messages: number;
  store: "v1" | "v2";
}

/** Reads OpenCode's sessions from whichever schema version its database has. */
export function readOpenCodeSessions(dbPath: string): OpenCodeRawSession[] {
  const db = open(dbPath, true);
  try {
    const v2 = hasTable(db, "session_v2") ? readV2Sessions(db) : [];
    const v1 = hasTable(db, "session") ? readV1Sessions(db, v2.length > 0) : [];
    return [...v2, ...v1];
  } finally {
    db.close();
  }
}

/** The first words typed in a session, for when its row has no title. */
export function readOpenCodeFirstPrompt(
  dbPath: string,
  session: { id: string; store: "v1" | "v2" },
): string {
  const db = open(dbPath, true);
  try {
    if (session.store === "v2") {
      const row = db
        .prepare(
          "SELECT data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1",
        )
        .get(session.id) as { data?: string } | undefined;
      return textOfJson(row?.data, "text");
    }
    const rows = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(session.id) as Array<{ id: string; data: string }>;
    for (const row of rows) {
      if (jsonField(row.data, "role") !== "user") {
        continue;
      }
      const parts = db
        .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id")
        .all(row.id) as Array<{ data: string }>;
      for (const part of parts) {
        const data = parseJson(part.data);
        if (data?.type !== "text" || data.ignored === true) {
          continue;
        }
        return typeof data.text === "string" ? data.text : "";
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    db.close();
  }
}

export interface OpenCodeRawMessage {
  /** v2: the row's type; v1: its role. */
  kind: string;
  data: string;
  /** v1 only: the message's parts, in order. */
  parts: string[];
}

/** A session's conversation rows, oldest first, as its store keeps them. */
export function readOpenCodeMessages(
  dbPath: string,
  session: { id: string; store: "v1" | "v2" },
): OpenCodeRawMessage[] {
  const db = open(dbPath, true);
  try {
    if (session.store === "v2") {
      const rows = db
        .prepare(
          `SELECT type, data FROM session_message
           WHERE session_id = ? AND type IN ('user', 'assistant', 'compaction', 'skill')
           ORDER BY seq`,
        )
        .all(session.id) as Array<{ type: string; data: string }>;
      return rows.map((row) => ({ kind: row.type, data: row.data, parts: [] }));
    }
    const messages = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(session.id) as Array<{ id: string; data: string }>;
    return messages.map((message) => {
      const parts = db
        .prepare("SELECT data FROM part WHERE message_id = ? ORDER BY id")
        .all(message.id) as Array<{ data: string }>;
      return {
        kind: jsonField(message.data, "role") ?? "",
        data: message.data,
        parts: parts.map((part) => part.data),
      };
    });
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function readV2Sessions(db: DatabaseSync): OpenCodeRawSession[] {
  return querySessions(
    db,
    `SELECT s.id, COALESCE(s.parent_id, '') AS parent, s.directory,
       COALESCE(s.title, '') AS title, COALESCE(s.agent, '') AS agent,
       COALESCE(s.model, '') AS model, s.cost,
       s.tokens_input, s.tokens_output, s.tokens_reasoning,
       s.tokens_cache_read, s.tokens_cache_write,
       s.time_created, s.time_updated,
       (SELECT count(*) FROM session_message m
        WHERE m.session_id = s.id AND m.type IN ('user', 'assistant')) AS messages
     FROM session_v2 s
     WHERE s.time_archived IS NULL`,
    "v2",
  );
}

function readV1Sessions(db: DatabaseSync, hasV2: boolean): OpenCodeRawSession[] {
  return querySessions(
    db,
    `SELECT s.id, COALESCE(s.parent_id, '') AS parent, s.directory,
       s.title, COALESCE(s.agent, '') AS agent, COALESCE(s.model, '') AS model, s.cost,
       s.tokens_input, s.tokens_output, s.tokens_reasoning,
       s.tokens_cache_read, s.tokens_cache_write,
       s.time_created, s.time_updated,
       (SELECT count(*) FROM message m WHERE m.session_id = s.id) AS messages
     FROM session s
     WHERE s.time_archived IS NULL${hasV2 ? " AND s.id NOT IN (SELECT id FROM session_v2)" : ""}`,
    "v1",
  );
}

function querySessions(db: DatabaseSync, sql: string, store: "v1" | "v2"): OpenCodeRawSession[] {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: String(row.id ?? ""),
    parent: String(row.parent ?? ""),
    directory: String(row.directory ?? ""),
    title: String(row.title ?? ""),
    agent: String(row.agent ?? ""),
    model: String(row.model ?? ""),
    cost: Number(row.cost ?? 0),
    tokens: {
      input: Number(row.tokens_input ?? 0),
      output: Number(row.tokens_output ?? 0) + Number(row.tokens_reasoning ?? 0),
      reasoning: Number(row.tokens_reasoning ?? 0),
      cacheRead: Number(row.tokens_cache_read ?? 0),
      cacheWrite: Number(row.tokens_cache_write ?? 0),
    },
    created: Number(row.time_created ?? 0),
    updated: Number(row.time_updated ?? 0),
    messages: Number(row.messages ?? 0),
    store,
  }));
}

function open(dbPath: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { n?: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

function hasColumns(db: DatabaseSync, table: string, columns: readonly string[]): boolean {
  const placeholders = columns.map(() => "?").join(", ");
  try {
    const row = db
      .prepare(`SELECT count(*) AS n FROM pragma_table_info(?) WHERE name IN (${placeholders})`)
      .get(table, ...columns) as { n?: number } | undefined;
    return Number(row?.n ?? 0) === columns.length;
  } catch {
    return false;
  }
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined || !text.startsWith("{")) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function jsonField(text: string, field: string): string | null {
  const value = parseJson(text)?.[field];
  return typeof value === "string" ? value : null;
}

function textOfJson(text: string | undefined, field: string): string {
  return jsonField(text ?? "", field) ?? "";
}
export interface AgySummary {
  title: string;
  cwd: string;
  lastMs: number;
}

/** What Antigravity's conversation_summaries.db says of each conversation. */
export function readAgySummaries(dbPath: string): Map<string, AgySummary> {
  const out = new Map<string, AgySummary>();
  const db = open(dbPath, true);
  try {
    if (!hasTable(db, "conversation_summaries")) {
      return out;
    }
    const rows = db
      .prepare(
        "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries",
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.conversation_id ?? "");
      if (id.length === 0) {
        continue;
      }
      const uris = parseUriList(row.workspace_uris);
      let cwd = "";
      for (const uri of uris) {
        cwd = folderOfUri(uri);
        if (cwd.length > 0) {
          break;
        }
      }
      out.set(id, {
        title: typeof row.title === "string" ? row.title : "",
        cwd,
        lastMs: agyTimeOf(row.last_modified_time),
      });
    }
    return out;
  } catch {
    return out;
  } finally {
    db.close();
  }
}

function parseUriList(value: unknown): string[] {
  const text = textOfValue(value);
  if (text.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** A file:// workspace URI as the folder it names. */
export function folderOfUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:" || url.pathname.length === 0) {
      return "";
    }
    const decoded = decodeURIComponent(url.pathname);
    if (process.platform !== "win32") {
      return url.hostname.length > 0 && url.hostname !== "localhost" ? "" : decoded;
    }
    if (url.hostname.length > 0 && url.hostname !== "localhost") {
      return `\\\\${url.hostname}${decoded.replace(/\//gu, "\\")}`;
    }
    const drive = /^\/([A-Za-z]):/u.exec(decoded);
    const rest = drive === null ? decoded : `${drive[1]?.toUpperCase() ?? ""}:${decoded.slice(3)}`;
    return rest.replace(/\//gu, "\\");
  } catch {
    return "";
  }
}

function textOfValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";
}

function agyTimeOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const text = textOfValue(value);
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(" ", "T").replace(/(\.\d{3})\d+/u, "$1");
  const at = Date.parse(normalized);
  return Number.isNaN(at) ? 0 : at;
}
