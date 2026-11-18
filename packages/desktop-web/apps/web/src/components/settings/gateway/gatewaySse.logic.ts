// FILE: gatewaySse.logic.ts
// Purpose: Read a streamed gateway response as SSE events and rebuild the reply
//          object the provider would have sent whole. A body that is not a
//          stream parses to null, so the caller keeps its plain body view.

export interface SseEvent {
  /** The `event:` field; "" for providers that only type the data. */
  event: string;
  data: string;
}

/** The reply a stream spells, in the provider's own shape. */
export type SseReply = Record<string, unknown>;

type SseKind = "anthropic" | "responses" | "chat" | "gemini";

interface ReplyBuild {
  kind: SseKind | "";
  blocks: Record<string, unknown>[];
  byKey: Map<string, Record<string, unknown>>;
  out: Record<string, unknown>;
}

const SSE_FIRST_FIELD = /^\s*(?::[^\n]*\n\s*)*(event|data|id|retry):/;

/** Where each protocol keeps the reply's parts. */
const CONTENT_KEYS: Record<SseKind, string> = {
  anthropic: "content",
  responses: "output",
  chat: "choices",
  gemini: "parts",
};

/** The body's events; null when the body is not a stream. */
export function parseSseEvents(raw: string): SseEvent[] | null {
  if (raw.length === 0 || !SSE_FIRST_FIELD.test(raw)) {
    return null;
  }
  const events: SseEvent[] = [];
  let event = "";
  let data: string[] = [];
  const done = (): void => {
    if (data.length > 0) {
      events.push({ event, data: data.join("\n") });
    }
    event = "";
    data = [];
  };
  for (const line of raw.split(/\r?\n/u)) {
    if (line === "") {
      done();
      continue;
    }
    if (line.startsWith(":")) {
      continue; // a comment, a keep-alive
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  done();
  return events.length > 0 ? events : null;
}

/** An event's data, pretty-printed when it is JSON; [DONE] as it came. */
export function sseEventText(event: SseEvent): string {
  const value = jsonOf(event.data);
  const object = record(value);
  return object === null ? event.data : JSON.stringify(object, null, 2);
}

/** Everything a stream carried, as one body: what Copy in Events copies. */
export function sseStreamText(events: SseEvent[]): string {
  return events
    .map(
      (event) => (event.event.length === 0 ? "" : `event: ${event.event}\n`) + sseEventText(event),
    )
    .join("\n\n");
}

/** What the stream adds up to, or null when it names no reply. */
export function sseReply(events: SseEvent[]): SseReply | null {
  const build: ReplyBuild = { kind: "", blocks: [], byKey: new Map(), out: {} };
  for (const event of events) {
    const data = record(jsonOf(event.data));
    if (data === null) {
      continue;
    }
    readEvent(data, event.event, build);
  }
  if (build.kind === "" && build.out.error === undefined) {
    return null;
  }
  return assembleReply(build);
}

function assembleReply(build: ReplyBuild): SseReply {
  const rawContent = Array.isArray(build.out.output) ? build.out.output : build.blocks;
  // An empty Chat message is the frame that only carried reasoning or calls.
  const content = rawContent.filter((entry) => {
    if (build.kind !== "chat") {
      return true;
    }
    const item = record(entry);
    return (
      item === null ||
      item.type !== "message" ||
      item.content !== undefined ||
      item.reasoning !== undefined
    );
  });
  for (const entry of content) {
    const item = record(entry);
    if (item === null) {
      continue;
    }
    for (const field of ["input", "arguments"]) {
      const value = item[field];
      if (typeof value !== "string") {
        continue;
      }
      const parsed = value === "" && field === "input" ? {} : jsonOf(value);
      if (parsed !== undefined) {
        item[field] = parsed;
      }
    }
  }
  const reply: SseReply = {};
  for (const field of ["id", "model", "status"]) {
    if (build.out[field] !== undefined) {
      reply[field] = build.out[field];
    }
  }
  if (content.length > 0) {
    reply[build.kind === "" ? "choices" : CONTENT_KEYS[build.kind]] = content;
  }
  for (const field of [
    "stop_reason",
    "finish_reason",
    "finishReason",
    "incomplete",
    "usage",
    "error",
  ]) {
    if (build.out[field] !== undefined) {
      reply[field] = build.out[field];
    }
  }
  return reply;
}

function readEvent(data: Record<string, unknown>, eventName: string, build: ReplyBuild): void {
  if (data.error !== undefined) {
    build.out.error = data.error;
    return;
  }
  const type = typeof data.type === "string" ? data.type : eventName;
  if (type === "message_start") {
    readMessageStart(data, build);
    return;
  }
  if (type === "content_block_start") {
    readAnthropicStart(data, build);
    return;
  }
  if (type === "content_block_delta") {
    readAnthropicDelta(data, build);
    return;
  }
  if (type === "message_delta") {
    readMessageDelta(data, build);
    return;
  }
  if (type.startsWith("response.")) {
    readResponsesEvent(data, type, build);
    return;
  }
  if (Array.isArray(data.choices)) {
    readChatChoices(data, build);
    return;
  }
  if (Array.isArray(data.candidates)) {
    readGeminiCandidates(data, build);
  }
}

function readMessageStart(data: Record<string, unknown>, build: ReplyBuild): void {
  const message = record(data.message);
  if (message === null) {
    return;
  }
  build.kind = "anthropic";
  if (message.id !== undefined) {
    build.out.id = message.id;
  }
  if (message.model !== undefined) {
    build.out.model = message.model;
  }
  const usage = record(message.usage);
  if (usage !== null) {
    build.out.usage = { ...usage };
  }
}

function readAnthropicStart(data: Record<string, unknown>, build: ReplyBuild): void {
  const started = record(data.content_block);
  if (started === null) {
    return;
  }
  build.kind = "anthropic";
  const piece = blockOf(build, `a${indexOf(data)}`, { type: started.type });
  const type = started.type;
  if (type === "tool_use" || type === "server_tool_use") {
    piece.id = started.id;
    piece.name = started.name;
    piece.input = "";
    return;
  }
  if (type === "text") {
    piece.text = typeof started.text === "string" ? started.text : "";
    return;
  }
  if (type === "thinking") {
    piece.thinking = typeof started.thinking === "string" ? started.thinking : "";
    return;
  }
  Object.assign(piece, started);
}

function readAnthropicDelta(data: Record<string, unknown>, build: ReplyBuild): void {
  const delta = record(data.delta);
  if (delta === null) {
    return;
  }
  const piece = blockOf(build, `a${indexOf(data)}`, { type: "text" });
  if (delta.type === "text_delta") {
    piece.text = stringOf(piece.text) + stringOf(delta.text);
    return;
  }
  if (delta.type === "thinking_delta") {
    piece.thinking = stringOf(piece.thinking) + stringOf(delta.thinking);
    return;
  }
  if (delta.type === "input_json_delta") {
    piece.input = stringOf(piece.input) + stringOf(delta.partial_json);
  }
}

function readMessageDelta(data: Record<string, unknown>, build: ReplyBuild): void {
  const delta = record(data.delta);
  if (delta !== null && delta.stop_reason !== undefined) {
    build.out.stop_reason = delta.stop_reason;
  }
  const usage = record(data.usage);
  if (usage !== null) {
    build.out.usage = { ...record(build.out.usage), ...usage };
  }
}

function readResponsesEvent(data: Record<string, unknown>, type: string, build: ReplyBuild): void {
  build.kind = "responses";
  readResponsesMeta(data, type, build);
  const item = record(data.item);
  const key = `r${stringOf(data.item_id) || stringOf(item?.id) || stringOf(data.output_index)}`;
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    readResponsesItem(type, item, key, build);
    return;
  }
  readResponsesDelta(type, key, data, build);
}

function readResponsesMeta(data: Record<string, unknown>, type: string, build: ReplyBuild): void {
  const response = record(data.response);
  if (response === null) {
    return;
  }
  if (response.id !== undefined) {
    build.out.id = response.id;
  }
  if (response.model !== undefined) {
    build.out.model = response.model;
  }
  if (response.status !== undefined) {
    build.out.status = response.status;
  }
  const usage = record(response.usage);
  if (usage !== null) {
    build.out.usage = usage;
  }
  if (response.error !== undefined) {
    build.out.error = response.error;
  }
  if (response.incomplete_details !== undefined) {
    build.out.incomplete = response.incomplete_details;
  }
  if (
    type === "response.completed" &&
    Array.isArray(response.output) &&
    response.output.length > 0
  ) {
    build.out.output = response.output;
  }
}

function readResponsesDelta(
  type: string,
  key: string,
  data: Record<string, unknown>,
  build: ReplyBuild,
): void {
  const delta = stringOf(data.delta);
  if (type === "response.output_text.delta" || type === "response.refusal.delta") {
    const block = blockOf(build, key, { type: "message" });
    block.text = stringOf(block.text) + delta;
    return;
  }
  if (type === "response.reasoning_summary_text.delta") {
    const block = blockOf(build, key, { type: "reasoning" });
    block.summary = stringOf(block.summary) + delta;
    return;
  }
  if (type === "response.reasoning_text.delta") {
    const block = blockOf(build, key, { type: "reasoning" });
    block.text = stringOf(block.text) + delta;
    return;
  }
  if (type === "response.function_call_arguments.delta") {
    const block = blockOf(build, key, { type: "function_call" });
    block.arguments = stringOf(block.arguments) + delta;
    return;
  }
  if (type === "response.custom_tool_call_input.delta") {
    const block = blockOf(build, key, { type: "custom_tool_call" });
    block.input = stringOf(block.input) + delta;
  }
}

function readResponsesItem(
  type: string,
  item: Record<string, unknown> | null,
  key: string,
  build: ReplyBuild,
): void {
  if (item === null) {
    return;
  }
  const piece = blockOf(build, key, { type: item.type });
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    piece.call_id = item.call_id;
    piece.name = item.name;
  }
  if (type !== "response.output_item.done") {
    return;
  }
  if (item.arguments !== undefined) {
    piece.arguments = item.arguments;
  }
  if (item.input !== undefined) {
    piece.input = item.input;
  }
  const text = Array.isArray(item.content)
    ? item.content
        .map((part) => record(part))
        .map((part) => stringOf(part?.text) || stringOf(part?.refusal))
        .join("")
    : "";
  if (text.length > 0) {
    piece.text = text;
  }
  const summary = Array.isArray(item.summary)
    ? item.summary
        .map((part) => stringOf(record(part)?.text))
        .filter((line) => line.length > 0)
        .join("\n\n")
    : "";
  if (summary.length > 0) {
    piece.summary = summary;
  }
}

function readChatChoices(data: Record<string, unknown>, build: ReplyBuild): void {
  build.kind = "chat";
  if (data.id !== undefined) {
    build.out.id = data.id;
  }
  if (data.model !== undefined) {
    build.out.model = data.model;
  }
  const usage = record(data.usage);
  if (usage !== null) {
    build.out.usage = usage;
  }
  for (const choice of data.choices as unknown[]) {
    const entry = record(choice);
    if (entry === null) {
      continue;
    }
    const index = indexOf(entry);
    const delta = record(entry.delta) ?? record(entry.message) ?? {};
    const message = blockOf(build, `c${index}`, { type: "message" });
    if (typeof delta.content === "string") {
      message.content = stringOf(message.content) + delta.content;
    }
    const reasoning =
      typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof reasoning === "string") {
      message.reasoning = stringOf(message.reasoning) + reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      readChatToolCalls(delta.tool_calls, index, build);
    }
    if (entry.finish_reason !== undefined) {
      build.out.finish_reason = entry.finish_reason;
    }
  }
}

function readChatToolCalls(calls: unknown[], index: number, build: ReplyBuild): void {
  for (const call of calls) {
    const tool = record(call);
    if (tool === null) {
      continue;
    }
    const fn = record(tool.function);
    const suffix = tool.index === undefined ? stringOf(tool.id) : String(tool.index);
    const piece = blockOf(build, `c${index}:${suffix}`, { type: "tool_call" });
    if (tool.id !== undefined) {
      piece.id = tool.id;
    }
    if (fn !== null && fn.name !== undefined) {
      piece.name = stringOf(piece.name) + stringOf(fn.name);
    }
    if (fn !== null && fn.arguments !== undefined) {
      piece.arguments = stringOf(piece.arguments) + stringOf(fn.arguments);
    }
  }
}

function readGeminiCandidates(data: Record<string, unknown>, build: ReplyBuild): void {
  build.kind = "gemini";
  if (data.modelVersion !== undefined) {
    build.out.model = data.modelVersion;
  }
  const usage = record(data.usageMetadata);
  if (usage !== null) {
    build.out.usage = usage;
  }
  for (const candidate of data.candidates as unknown[]) {
    const entry = record(candidate);
    if (entry === null) {
      continue;
    }
    const index = indexOf(entry);
    const parts = record(entry.content)?.parts;
    if (Array.isArray(parts)) {
      readGeminiParts(parts, index, build);
    }
    if (entry.finishReason !== undefined) {
      build.out.finishReason = entry.finishReason;
    }
  }
}

function readGeminiParts(parts: unknown[], index: number, build: ReplyBuild): void {
  for (const part of parts) {
    const piece = record(part);
    if (piece === null) {
      continue;
    }
    if (typeof piece.text === "string") {
      const role = piece.thought === true ? "thought" : "text";
      const block = blockOf(build, `g${index}${role === "thought" ? "t" : ""}`, { type: role });
      block.text = stringOf(block.text) + piece.text;
      continue;
    }
    const call = record(piece.functionCall);
    if (call !== null) {
      build.blocks.push({ type: "functionCall", ...call });
    }
  }
}

function blockOf(
  build: ReplyBuild,
  key: string,
  init: Record<string, unknown>,
): Record<string, unknown> {
  const found = build.byKey.get(key);
  if (found !== undefined) {
    return found;
  }
  const created = { ...init };
  build.byKey.set(key, created);
  build.blocks.push(created);
  return created;
}

function indexOf(data: Record<string, unknown>): number {
  return typeof data.index === "number" ? data.index : 0;
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}
