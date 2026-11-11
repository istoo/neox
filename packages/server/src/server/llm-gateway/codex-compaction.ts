/**
 * Codex compacts its conversation remotely: it sends a `compaction_trigger`
 * input item and keeps the compaction item that comes back whole, sending it
 * again with every later turn. OpenAI's own providers answer that; a model
 * behind another API can't, so the gateway answers it itself, as myna does:
 * it asks the model for the summary, wraps it in a compaction item only the
 * gateway reads, and turns that item back into a user message on later turns.
 * A provider that carries Codex's own compaction (`nativeCompaction`) is sent
 * the trigger and gives back OpenAI's sealed item untouched.
 *
 * The summary mark, prefix, prompt and item shapes are myna's, so a rollout
 * compacted here is read back the same way.
 */

/** Begins the encrypted_content of a compaction item the gateway made. */
export const NEOLIX_COMPACTION_MARK = "neolix1:";
/** myna's mark, read back too: a rollout compacted by myna goes on here. */
const MYNA_COMPACTION_MARK = "myna1:";

/** Codex's own summary prefix (openai/codex, prompts/templates/compact). */
export const CODEX_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

/** Codex's own compaction ask (openai/codex, prompts/templates/compact). */
export const CODEX_COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const TURN_METADATA_HEADER = "x-codex-turn-metadata";

const COMPACTION_KINDS = new Set(["compaction", "compaction_summary"]);
const ADDITIONAL_TOOLS_ITEM = "additional_tools";

/** A Responses input message of the user's, as myna writes one. */
export function userMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

/** The encrypted_content of a compaction item for a summary. */
export function encryptedSummary(summary: string): string {
  return `${NEOLIX_COMPACTION_MARK}${Buffer.from(summary, "utf8").toString("base64")}`;
}

/**
 * What a compaction item's encrypted_content is read as: `ours` is false for
 * one another vendor made (left as it is), `message` is null for ours whose
 * summary can't be read (left out).
 */
export function summaryMessage(encrypted: unknown): {
  ours: boolean;
  message: Record<string, unknown> | null;
} {
  if (typeof encrypted !== "string") {
    return { ours: false, message: null };
  }
  const mark = encryptionMark(encrypted);
  if (mark === null) {
    return { ours: false, message: null };
  }
  const summary = Buffer.from(encrypted.slice(mark.length), "base64").toString("utf8");
  if (summary.length === 0) {
    return { ours: true, message: null };
  }
  return { ours: true, message: userMessage(`${CODEX_SUMMARY_PREFIX}\n${summary}`) };
}

function encryptionMark(encrypted: string): string | null {
  if (encrypted.startsWith(NEOLIX_COMPACTION_MARK)) {
    return NEOLIX_COMPACTION_MARK;
  }
  return encrypted.startsWith(MYNA_COMPACTION_MARK) ? MYNA_COMPACTION_MARK : null;
}

/** Whether a Responses body carries Codex's compaction trigger. */
export function hasCompactionTrigger(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.input) &&
    body.input.some((item) => isRecord(item) && item.type === "compaction_trigger")
  );
}

/** What an input item says, as text, the way myna's plain summary carries it. */
function itemText(item: Record<string, unknown>): { role: string; text: string } {
  const text = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (!Array.isArray(value)) {
      return "";
    }
    return value
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .filter((entry) => entry.length > 0)
      .join("\n");
  };
  switch (item.type) {
    case "message":
    case undefined:
      return {
        role: typeof item.role === "string" && item.role.length > 0 ? item.role : "user",
        text: text(item.content),
      };
    case "function_call":
    case "custom_tool_call":
      return {
        role: "tool call",
        text: `${String(item.name ?? "")} ${String(item.arguments ?? item.input ?? "")}`,
      };
    case "function_call_output":
    case "custom_tool_call_output": {
      const output = text(item.output);
      return {
        role: "tool output",
        text: output.length > 4000 ? `${output.slice(0, 2000)}\n…\n${output.slice(-2000)}` : output,
      };
    }
    case "reasoning":
      return { role: "reasoning", text: text(item.summary) };
    default:
      return { role: "", text: "" };
  }
}

/** Bounds the conversation's text a plain summary request carries. */
const PLAIN_SUMMARY_MAX = 400_000;
/** Bounds the user's messages a local summary keeps, the latest of them. */
const LOCAL_SUMMARY_MAX = 80_000;

/**
 * A summary request with the conversation as text, in one user message, and
 * Codex's ask after it: no item ids, sealed reasoning or calls a provider may
 * look up and not find. myna's plainCompact.
 */
export function plainSummaryBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : [];
  const parts: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    const { role, text } = itemText(item);
    if (text.trim().length === 0 || text === CODEX_COMPACT_PROMPT) {
      continue;
    }
    parts.push(`[${role}]\n${text}\n\n`);
  }
  let conversation = parts.join("");
  if (conversation.length > PLAIN_SUMMARY_MAX) {
    conversation = `…\n${conversation.slice(-PLAIN_SUMMARY_MAX)}`;
  }
  const next: Record<string, unknown> = {
    ...body,
    input: [
      userMessage(`This is the conversation so far:\n\n${conversation}`),
      userMessage(CODEX_COMPACT_PROMPT),
    ],
  };
  delete next.previous_response_id;
  return next;
}

/**
 * A summary made without a model: what the user asked (the summaries before
 * this one with it), the latest of it kept, and the last reply. myna's
 * localSummary, saying neolix where myna says itself.
 */
export function localFallbackSummary(body: Record<string, unknown>, why: string): string {
  const input = Array.isArray(body.input) ? body.input : [];
  const asked: string[] = [];
  let last = "";
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    const { role, text } = itemText(item);
    const said = text.trim();
    if (said.length === 0 || said === CODEX_COMPACT_PROMPT) {
      continue;
    }
    if (role === "user") {
      asked.push(said);
    } else if (role === "assistant") {
      last = said;
    }
  }
  let from = asked.length;
  let length = 0;
  while (from > 0) {
    const entry = asked[from - 1] ?? "";
    if (length + Buffer.byteLength(entry, "utf8") > LOCAL_SUMMARY_MAX) {
      break;
    }
    from -= 1;
    length += Buffer.byteLength(entry, "utf8");
  }
  const lines = [
    `Neox compacted this conversation without a model (${why}), so this is no summary: it is what the user asked${
      from > 0 ? ` (the latest ${asked.length - from} of ${asked.length} messages)` : ""
    } and the last reply. Look at the workspace for where the work stands before going on.`,
    "",
    "## The user's messages",
    "",
  ];
  for (const entry of asked.slice(from)) {
    lines.push(entry, "");
  }
  if (last.length > 0) {
    lines.push("## The last reply", "", last);
  }
  return lines.join("\n");
}

/** Whether a summary reply called a tool instead of writing the summary. */
export function answerCalledTool(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    return false;
  }
  return value.output.some(
    (item) => isRecord(item) && typeof item.type === "string" && item.type.endsWith("_call"),
  );
}

/** Whether a status means the summary may be asked again as plain text. */
export function retrySummaryAsText(status: number, body: string): boolean {
  if (status === 404 || status === 405 || status === 501 || status === 413) {
    return true;
  }
  if (status === 400 && /item\b.*not found/i.test(body)) {
    return true;
  }
  if (status >= 400 && status < 500 && /upstream request failed/i.test(body)) {
    return true;
  }
  return status === 502 && /response protection/i.test(body);
}

export interface CodexInputRewrite {
  body: Record<string, unknown>;
  /** The request asks for a summary the gateway must make. */
  compact: boolean;
  changed: boolean;
}

/**
 * Restores summaries the gateway made, turns a compaction trigger into the
 * summary ask when no upstream carries Codex's own, and leaves out reasoning
 * another vendor can't be asked.
 */
export function rewriteCodexInput(
  body: Record<string, unknown>,
  native: boolean,
): CodexInputRewrite {
  const input = body.input;
  if (!Array.isArray(input)) {
    return { body, compact: false, changed: false };
  }
  let compact = false;
  let changed = false;
  const kept: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      kept.push(item);
      continue;
    }
    const type = item.type;
    if (typeof type === "string" && COMPACTION_KINDS.has(type)) {
      const read = summaryMessage(item.encrypted_content);
      if (!read.ours) {
        kept.push(item);
        continue;
      }
      changed = true;
      if (read.message !== null) {
        kept.push(read.message);
      }
      continue;
    }
    if (type === "compaction_trigger") {
      if (native) {
        kept.push(item);
        continue;
      }
      changed = true;
      compact = true;
      kept.push(userMessage(CODEX_COMPACT_PROMPT));
      continue;
    }
    if (type === "reasoning" && !native && reasoningDropped(item)) {
      changed = true;
      continue;
    }
    kept.push(item);
  }
  if (!changed) {
    return { body, compact: false, changed: false };
  }
  let next: Record<string, unknown> = { ...body, input: kept };
  if (compact) {
    next = summaryRequestBody(next);
  }
  return { body: next, compact, changed: true };
}

/** OpenAI keeps no reasoning parts in replayed input, nor one with nothing sealed. */
function reasoningDropped(item: Record<string, unknown>): boolean {
  const content = item.content;
  if (content !== undefined && content !== null) {
    if (!Array.isArray(content) || content.length > 0) {
      return true;
    }
  }
  return typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0;
}

/** The summary request: no trigger, no tools, and Codex's metadata made local. */
function summaryRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input)
    ? body.input.filter((item) => !isRecord(item) || item.type !== ADDITIONAL_TOOLS_ITEM)
    : body.input;
  return {
    ...body,
    input,
    tools: [],
    tool_choice: "auto",
    parallel_tool_calls: false,
    ...(rewriteClientMetadata(body.client_metadata) === undefined
      ? {}
      : { client_metadata: rewriteClientMetadata(body.client_metadata) }),
  };
}

/**
 * Codex's turn metadata for a compaction the gateway summarises itself: the
 * implementation is "responses", as Codex says of a summary it asks a
 * provider for, not the remote compaction it named with the trigger.
 */
export function localCompactionTurn(meta: string): { meta: string; changed: boolean } {
  if (!meta.includes('"compaction"')) {
    return { meta, changed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(meta);
  } catch {
    return { meta, changed: false };
  }
  if (!isRecord(parsed) || !isRecord(parsed.compaction)) {
    return { meta, changed: false };
  }
  const implementation = parsed.compaction.implementation;
  if (typeof implementation !== "string" || implementation === "responses") {
    return { meta, changed: false };
  }
  const old = `"implementation":${JSON.stringify(implementation)}`;
  if (meta.split(old).length !== 2) {
    return { meta, changed: false };
  }
  return { meta: meta.replace(old, '"implementation":"responses"'), changed: true };
}

function rewriteClientMetadata(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  const turn = value[TURN_METADATA_HEADER];
  if (typeof turn !== "string") {
    return undefined;
  }
  const local = localCompactionTurn(turn);
  if (!local.changed) {
    return undefined;
  }
  return { ...value, [TURN_METADATA_HEADER]: local.meta };
}

/** The metadata body's own copy says, when it says anything at all. */
export function turnMetadataOf(body: Record<string, unknown>): string | null {
  const metadata = body.client_metadata;
  if (!isRecord(metadata)) {
    return null;
  }
  const turn = metadata[TURN_METADATA_HEADER];
  if (typeof turn === "string") {
    return turn;
  }
  if (isRecord(turn)) {
    return JSON.stringify(turn);
  }
  return null;
}

export type CodexSideKind = "title" | "description" | "summary" | "prediction";

const TITLE_KINDS = new Set(["thread_title", "thread_title_reconsideration", "title_generation"]);

/** Which hidden turn of Codex's the request is, judged as myna judges it. */
export function codexSideKind(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>,
): CodexSideKind | null {
  const subagent = readHeader(headers, "x-openai-subagent");
  const source = subagent ?? turnMetadataSource(headers, body);
  if (TITLE_KINDS.has(source)) {
    return "title";
  }
  if (source === "thread_description") {
    return "description";
  }
  if (source === "thread_summary") {
    return "summary";
  }
  if (source === "composer_predictions") {
    return "prediction";
  }
  return null;
}

function turnMetadataSource(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>,
): string {
  const raw = readHeader(headers, TURN_METADATA_HEADER) ?? turnMetadataOf(body);
  if (raw === null) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.thread_source === "string") {
      return parsed.thread_source;
    }
  } catch {
    return "";
  }
  return "";
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name];
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value) && value.length > 0 ? (value[0] ?? null) : null;
}

/** The string properties a title request's text.format asks for. */
export interface TitleShape {
  properties: Record<string, { type?: string; maxLength?: number }>;
  required: string[];
}

export function titleShapeOf(body: Record<string, unknown>): TitleShape {
  const schema = isRecord(body.text) ? body.text.format : undefined;
  const inner = isRecord(schema) && isRecord(schema.schema) ? schema.schema : undefined;
  if (!isRecord(inner)) {
    return { properties: {}, required: [] };
  }
  const properties: TitleShape["properties"] = {};
  if (isRecord(inner.properties)) {
    for (const [name, value] of Object.entries(inner.properties)) {
      if (isRecord(value)) {
        properties[name] = {
          ...(typeof value.type === "string" ? { type: value.type } : {}),
          ...(typeof value.maxLength === "number" ? { maxLength: value.maxLength } : {}),
        };
      }
    }
  }
  const required = Array.isArray(inner.required)
    ? inner.required.filter((name): name is string => typeof name === "string")
    : [];
  return { properties, required };
}

/** Where a reply's messages' text is, its reasoning left out. */
export function responseText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of value.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

export function responseStatus(value: unknown): string {
  return isRecord(value) && typeof value.status === "string" ? value.status : "completed";
}

export function responseId(value: unknown): string | null {
  return isRecord(value) && typeof value.id === "string" ? value.id : null;
}

export function responseUsage(value: unknown): unknown {
  return isRecord(value) ? value.usage : undefined;
}

/** A model's answer to a title request as Codex reads it, or "". */
export function titleJSON(said: string, shape: TitleShape): string {
  const t = cleanAnswer(said);
  if (t.length === 0 || t.startsWith("{")) {
    return "";
  }
  const fields = jsonFields(said);
  const title = clip(shape, "title", firstLine(t));
  if (title.length === 0) {
    return "";
  }
  const out: Record<string, string> = { title };
  for (const name of shape.required) {
    if (name === "title") {
      continue;
    }
    const type = shape.properties[name]?.type;
    if (type !== undefined && type !== "string") {
      continue;
    }
    const value = typeof fields[name] === "string" ? String(fields[name]) : "";
    out[name] = clip(shape, name, value.length > 0 ? value.replace(/\s+/g, " ") : title);
  }
  return JSON.stringify(out);
}

export function descriptionJSON(said: string): string {
  const fields = jsonFields(said);
  const saidText = typeof fields.description === "string" ? fields.description : cleanAnswer(said);
  const t = cleanAnswer(saidText);
  if (t.length === 0 || t.startsWith("{")) {
    return "";
  }
  return JSON.stringify({ description: t });
}

export function summaryJSON(said: string, shape: TitleShape): string {
  const fields = jsonFields(said);
  const raw = typeof fields.summary === "string" ? fields.summary : cleanAnswer(said);
  let t = raw.replace(/\s+/g, " ").trim();
  if (t.toLowerCase().startsWith("summary:")) {
    t = t.slice("summary:".length).trim();
  }
  t = t.replace(/^["'`*“”‘’]+|["'`*“”‘’]+$/g, "").trim();
  if (t.length === 0 || t.startsWith("{")) {
    return "";
  }
  const out: Record<string, string> = { summary: clip(shape, "summary", t) };
  for (const name of shape.required) {
    if (name === "summary") {
      continue;
    }
    const type = shape.properties[name]?.type;
    if (type !== undefined && type !== "string") {
      continue;
    }
    const saidField = typeof fields[name] === "string" ? String(fields[name]) : "";
    const value = saidField.replace(/\s+/g, " ").trim();
    out[name] = clip(shape, name, value.length > 0 ? value : t);
  }
  return JSON.stringify(out);
}

/** The model's answer as {"suggestion": …}: ok is false when it said none. */
export function predictionJSON(said: string): { json: string; ok: boolean } {
  const fields = jsonFields(said);
  if (!("suggestion" in fields)) {
    return { json: '{"suggestion":null}', ok: false };
  }
  const value = fields.suggestion;
  if (value === null) {
    return { json: '{"suggestion":null}', ok: true };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return { json: '{"suggestion":null}', ok: false };
  }
  return { json: JSON.stringify({ suggestion: value.trim() }), ok: true };
}

/** The answer with its code fence and the <thought> block of a reasoning model. */
function cleanAnswer(said: string): string {
  const open = "<thought>";
  const close = "</thought>";
  let t = said.trim();
  if (t.startsWith(open)) {
    const end = t.indexOf(close);
    if (end >= 0) {
      t = t.slice(end + close.length).trim();
    }
  }
  if (t.startsWith("```")) {
    const body = t.slice(3);
    const newline = body.indexOf("\n");
    t = (
      newline >= 0 && !body.slice(0, newline).includes("{") ? body.slice(newline + 1) : body
    ).trim();
    if (t.endsWith("```")) {
      t = t.slice(0, -3).trim();
    }
  }
  return t;
}

function jsonFields(said: string): Record<string, unknown> {
  const t = cleanAnswer(said);
  if (!t.startsWith("{")) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(t);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return "";
}

function clip(shape: TitleShape, name: string, value: string): string {
  const limit = shape.properties[name]?.maxLength;
  if (limit === undefined || limit <= 0) {
    return value.replace(/^["'`*#“”‘’]+|["'`*#“”‘’]+$/g, "").trim();
  }
  return value
    .replace(/^["'`*#“”‘’]+|["'`*#“”‘’]+$/g, "")
    .trim()
    .slice(0, limit)
    .trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
