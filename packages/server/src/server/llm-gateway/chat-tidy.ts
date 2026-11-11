import { randomUUID } from "node:crypto";
import { textCallID, wholeChatTextCalls } from "./text-calls.js";

/**
 * Mends a Chat Completions reply relayed as it came (myna's chattidy.go).
 * Vendors send shapes the OpenAI contract doesn't have, and strict clients
 * refuse the chunk — or the whole turn — for one:
 *
 * - WorkBuddy keeps sending `"reasoning_content": ""` after thinking ends;
 *   Qoder reads each as a new thinking block.
 * - Every unfinished chunk says `"finish_reason": ""` where the contract has
 *   null; the AI SDK rejects it.
 * - Every tool-call fragment after the first repeats `"function": {"name":
 *   ""}`; a last-wins merge (the grok CLI) assembles a call named "".
 * - Every delta carries `"tool_calls": []`; Qoder closes its text block on
 *   each one.
 * - Mistral sends a reasoning model's thinking as typed parts in `content`,
 *   where the contract has a string or null.
 * - A tool call's first fragment may carry no id (OpenCode Zen's DeepSeek),
 *   which the agent keeps as "" and a strict upstream turns away later.
 * - A call may name no function in a JSON string (no name, null, another
 *   kind); a client checking every frame's shape refuses the turn.
 * - A legacy `function_call` may carry an empty name and arguments.
 * - Gemini's OpenAI-compatible API sends tool calls with no `index`; the AI
 *   SDK refuses the chunk.
 * - A choice that made calls and ended `"stop"` ends `"tool_calls"`.
 * - A usage may tell its cache only in Anthropic's, DeepSeek's or Moonshot's
 *   names; OpenAI's are filled in too (`openAiUsage`).
 *
 * Lines pass whole, as they came, unless one has any of them.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json | null {
  return isRecord(value) ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function callId(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `aName` (whole_stream.go:68): a name a client's shape check takes. */
function aName(value: unknown): value is string {
  return typeof value === "string";
}

function newCallId(): string {
  return `call_${randomUUID().replaceAll("-", "")}`;
}

const EMPTY_REASONING = '"reasoning_content":""';
const EMPTY_FINISH_REASON = '"finish_reason":""';
const EMPTY_TOOL_NAME = '"name":""';
const EMPTY_TOOL_CALLS = '"tool_calls":[]';
const CONTENT_PARTS = '"content":[';
const CONTENT_PARTS_SPACE = '"content": [';
const TOOL_CALLS_FIELD = '"tool_calls"';
const FUNCTION_CALL_FIELD = '"function_call":{';
const USAGE_FIELD = '"usage"';
const CACHED_TOKENS_FIELD = '"cached_tokens"';
const FINISH_REASON_FIELD = '"finish_reason"';
/** The names other than OpenAI's that `openAiUsage` reads a cache in. */
const OTHER_CACHE_FIELDS = [
  '"prompt_cache_hit_tokens"',
  '"cache_read_input_tokens"',
  '"cache_creation_input_tokens"',
];

/** Whether a line carries any of the shapes the tidy mends. */
function needsTidy(line: string): boolean {
  return (
    line.includes(EMPTY_REASONING) ||
    line.includes(EMPTY_FINISH_REASON) ||
    line.includes(EMPTY_TOOL_NAME) ||
    line.includes(EMPTY_TOOL_CALLS) ||
    line.includes(CONTENT_PARTS) ||
    line.includes(CONTENT_PARTS_SPACE) ||
    line.includes(TOOL_CALLS_FIELD) ||
    line.includes(FUNCTION_CALL_FIELD)
  );
}

/**
 * Whether the line holds a usage that may tell its cache in names other
 * than OpenAI's: any of DeepSeek's, Anthropic's, or Moonshot's top-level
 * `cached_tokens` beside the one in `prompt_tokens_details`.
 */
function mayMendUsage(text: string): boolean {
  if (!text.includes(USAGE_FIELD)) {
    return false;
  }
  if (OTHER_CACHE_FIELDS.some((field) => text.includes(field))) {
    return true;
  }
  return text.split(CACHED_TOKENS_FIELD).length - 1 > 1;
}

interface Counts {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  details: { cachedTokens: number; cacheWriteTokens: number } | null;
  promptCacheHitTokens: number;
  cachedTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function countsOf(raw: Json): Counts {
  const details = asRecord(raw.prompt_tokens_details);
  return {
    promptTokens: numberField(raw.prompt_tokens) ?? 0,
    completionTokens: numberField(raw.completion_tokens) ?? 0,
    totalTokens: numberField(raw.total_tokens) ?? 0,
    details:
      details === null
        ? null
        : {
            cachedTokens: numberField(details.cached_tokens) ?? 0,
            cacheWriteTokens: numberField(details.cache_write_tokens) ?? 0,
          },
    promptCacheHitTokens: numberField(raw.prompt_cache_hit_tokens) ?? 0,
    cachedTokens: numberField(raw.cached_tokens) ?? 0,
    cacheReadInputTokens: numberField(raw.cache_read_input_tokens) ?? 0,
    cacheCreationInputTokens: numberField(raw.cache_creation_input_tokens) ?? 0,
  };
}

/**
 * A Chat usage whose cache is told only in another vendor's names, told in
 * OpenAI's as well (myna's `openAIUsage`, chattidy.go:205). Returns whether
 * it changed the object. Every field the upstream sent stays.
 */
function cacheOf(all: Counts): { read: number; write: number; input: number } {
  let read = all.details?.cachedTokens ?? 0;
  let write = all.details?.cacheWriteTokens ?? 0;
  for (const other of [all.promptCacheHitTokens, all.cachedTokens]) {
    if (read === 0) {
      read = other;
    }
  }
  // prompt_tokens counts what was cached too, as OpenAI's does; Anthropic's
  // names are counted the other way, and only when they come to less.
  let whole = true;
  if (read === 0 && write === 0) {
    read = all.cacheReadInputTokens;
    write = all.cacheCreationInputTokens;
    whole = all.promptTokens >= read + write;
  }
  return {
    read,
    write,
    input: whole ? Math.max(all.promptTokens - read - write, 0) : all.promptTokens,
  };
}

/** The usage told in OpenAI's names as well, or null when it already is. */
function mendUsage(raw: unknown): Json | null {
  const counts = asRecord(raw);
  if (counts === null) {
    return null;
  }
  const all = countsOf(counts);
  const cache = cacheOf(all);
  if (cache.read === 0 && cache.write === 0) {
    return null;
  }
  const details = all.details;
  // prompt_tokens counts what was cached too, as OpenAI's does.
  const promptTotal = cache.input + cache.read + cache.write;
  if (
    details !== null &&
    details.cachedTokens === cache.read &&
    details.cacheWriteTokens === cache.write &&
    all.promptTokens === promptTotal
  ) {
    return null;
  }
  const m: Json = { ...counts };
  const nextDetails: Json = asRecord(m.prompt_tokens_details) ?? {};
  nextDetails.cached_tokens = cache.read;
  if ("cache_write_tokens" in nextDetails || cache.write > 0) {
    nextDetails.cache_write_tokens = cache.write;
  }
  m.prompt_tokens_details = nextDetails;
  if (all.promptTokens !== promptTotal) {
    m.prompt_tokens = promptTotal;
    if ("total_tokens" in m) {
      m.total_tokens = all.totalTokens + promptTotal - all.promptTokens;
    }
  }
  return m;
}

/** A usage told in OpenAI's names as well, for the billing side to read. */
export function openAiUsage(raw: unknown): { usage: unknown; changed: boolean } {
  const mended = mendUsage(raw);
  return mended === null ? { usage: raw, changed: false } : { usage: mended, changed: true };
}

/** Mistral's thinking: a plain string, or a list of text parts. */
function thinkingText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return "";
  }
  let think = "";
  for (const inner of raw) {
    const piece = asRecord(inner);
    if (piece !== null && typeof piece.text === "string") {
      think += piece.text;
    }
  }
  return think;
}

/** The thinking and text of a content that is an array of typed parts. */
function partsText(raw: unknown): { text: string; think: string } | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  let text = "";
  let think = "";
  for (const entry of raw) {
    const part = asRecord(entry);
    if (part === null) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    } else if (part.type === "thinking") {
      think += thinkingText(part.thinking);
    }
  }
  return { text, think };
}

/**
 * Turns a delta's or message's content of typed parts into a string
 * content, and its thinking into `reasoning_content`. A delta with no text
 * left goes without content; a whole message keeps an empty one.
 */
function flattenContent(message: Json, whole: boolean): boolean {
  const parts = partsText(message.content);
  if (parts === null) {
    return false;
  }
  if (parts.text !== "" || whole) {
    message.content = parts.text;
  } else {
    delete message.content;
  }
  if (parts.think !== "") {
    const had = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    message.reasoning_content = had + parts.think;
  }
  return true;
}

/** Whether a legacy `function_call` carries nothing (myna #4659). */
function emptyFunctionCall(raw: unknown): boolean {
  if (raw === null) {
    return false;
  }
  const call = asRecord(raw);
  if (call === null) {
    return false;
  }
  const name = call.name;
  const args = call.arguments;
  // A null reads as "" here, as myna's string fields do: the contract's
  // own nothing is a null object, not a null name.
  const stringish = (value: unknown): boolean =>
    value === undefined || value === null || typeof value === "string";
  return (
    (name === undefined || name === null || name === "") &&
    (args === undefined || args === null || args === "") &&
    stringish(name) &&
    stringish(args)
  );
}

/** Drops an empty `name` from fragments, keeping real ones. */
function withoutEmptyNames(calls: unknown[]): boolean {
  let changed = false;
  for (const entry of calls) {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    if (call === null || fn === null || fn.name !== "") {
      continue;
    }
    delete fn.name;
    call.function = fn;
    changed = true;
  }
  return changed;
}

interface OpenCall {
  open: boolean;
  id: string;
  index: number;
  next: number;
}

/**
 * Gives a fragment with no `index` the index of the call it belongs to
 * (myna's `streamCallIndexes.give`, chattidy.go:439). A fragment with an id
 * other than the open call's, or after the first in its delta, starts the
 * next call; one with an index keeps it.
 */
function giveIndexes(open: OpenCall, calls: unknown[]): boolean {
  let changed = false;
  calls.forEach((entry, position) => {
    const call = asRecord(entry);
    if (call === null) {
      return;
    }
    const id = callId(call.id);
    const index = call.index;
    if (index !== undefined && index !== null) {
      const given = numberField(index);
      if (given !== null) {
        open.open = true;
        open.id = id !== "" ? id : open.id;
        open.index = given;
        open.next = Math.max(open.next, given + 1);
      }
      return;
    }
    if (!open.open || position > 0 || (id !== "" && id !== open.id)) {
      open.open = true;
      open.id = id;
      open.index = open.next;
      open.next += 1;
    }
    call.index = open.index;
    changed = true;
  });
  return changed;
}

/**
 * Drops the fragments of a streamed call whose first names no function in a
 * JSON string, with its later fragments (myna #1475); a name of another
 * kind on a later fragment only loses the field.
 */
function dropNameless(
  tidy: ChatTidy,
  choice: number,
  calls: unknown[],
): { kept: unknown[] | null; changed: boolean } {
  const kept: unknown[] = [];
  let changed = false;
  for (const entry of calls) {
    const call = asRecord(entry);
    if (call === null) {
      kept.push(entry);
      continue;
    }
    const index = numberField(call.index) ?? 0;
    const key = `${choice}:${index}`;
    if (tidy.bad.has(key)) {
      changed = true;
      continue;
    }
    const first = !tidy.seen.has(key);
    tidy.seen.add(key);
    const fn = asRecord(call.function);
    const hasName = fn !== null && "name" in fn;
    if (hasName && aName(fn?.name)) {
      tidy.named.add(choice);
      kept.push(call);
    } else if (hasName && !first) {
      // it would write itself over the name the first fragment carried.
      delete fn?.name;
      if (fn !== null) {
        call.function = fn;
      }
      kept.push(call);
      changed = true;
    } else if (!first) {
      kept.push(call);
    } else {
      // No name the client reads, and a call's name goes with its first
      // fragment: no fragment of this call will name it.
      tidy.bad.add(key);
      changed = true;
    }
  }
  if (!changed) {
    return { kept: calls, changed: false };
  }
  return { kept: kept.length === 0 ? null : kept, changed: true };
}

/** Gives a streamed call with no id one; drops an empty id from later ones. */
function mendCallIds(seenIds: Set<string>, choice: number, calls: unknown[]): boolean {
  let changed = false;
  calls.forEach((entry, position) => {
    const call = asRecord(entry);
    if (call === null) {
      return;
    }
    const index = numberField(call.index) ?? position;
    const key = `${choice}:${index}`;
    if (!seenIds.has(key)) {
      seenIds.add(key);
      if (callId(call.id) === "") {
        call.id = newCallId();
        changed = true;
      }
    } else if ("id" in call && callId(call.id) === "") {
      delete call.id;
      changed = true;
    }
  });
  return changed;
}

export class ChatTidy {
  private buffer = "";
  private readonly seenIds = new Set<string>();
  private readonly indexes = new Map<number, OpenCall>();
  private readonly called = new Set<number>();
  /** The choices with a call whose name a client reads. */
  readonly named = new Set<number>();
  readonly seen = new Set<string>();
  readonly bad = new Set<string>();

  /** Takes what was read; returns every complete line, mended. */
  public write(piece: string): string {
    this.buffer += piece;
    const at = this.buffer.lastIndexOf("\n");
    if (at < 0) {
      return "";
    }
    const out = this.lines(this.buffer.slice(0, at + 1));
    this.buffer = this.buffer.slice(at + 1);
    return out;
  }

  /** What is left once the stream ends. */
  public flush(): string {
    const out = this.lines(this.buffer);
    this.buffer = "";
    return out;
  }

  private lines(text: string): string {
    if (!this.needs(text)) {
      return text;
    }
    let out = "";
    let rest = text;
    while (rest.length > 0) {
      const at = rest.indexOf("\n");
      if (at < 0) {
        out += this.line(rest);
        break;
      }
      out += this.line(rest.slice(0, at + 1));
      rest = rest.slice(at + 1);
    }
    return out;
  }

  private needs(text: string): boolean {
    return (
      needsTidy(text) ||
      (this.called.size > 0 && text.includes(FINISH_REASON_FIELD)) ||
      mayMendUsage(text)
    );
  }

  /** Mends one line; a line it doesn't know comes back as it was. */
  public line(line: string): string {
    if (!this.needs(line)) {
      return line;
    }
    const trimmed = line.replace(/[\r\n]+$/, "");
    const end = line.slice(trimmed.length);
    if (!trimmed.startsWith("data:")) {
      return line;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(trimmed.slice("data:".length));
    } catch {
      return line;
    }
    const record = asRecord(chunk);
    if (record === null) {
      return line;
    }
    let usageMended = false;
    if ("usage" in record) {
      const usage = mendUsage(record.usage);
      if (usage !== null) {
        record.usage = usage;
        usageMended = true;
      }
    }
    let choices: unknown[] | null = Array.isArray(record.choices) ? record.choices : null;
    if (choices === null) {
      if (!usageMended) {
        return line;
      }
      choices = [];
    }
    let changed = false;
    choices.forEach((entry, position) => {
      if (this.mendChoice(entry, position)) {
        changed = true;
      }
    });
    if (!changed && !usageMended) {
      return line;
    }
    record.choices = choices;
    return `data: ${JSON.stringify(record)}${end}`;
  }

  /** Mends one choice of a chunk; reports whether anything changed. */
  private mendChoice(entry: unknown, position: number): boolean {
    const choice = asRecord(entry);
    if (choice === null) {
      return false;
    }
    let changed = false;
    if (choice.finish_reason === "") {
      choice.finish_reason = null;
      changed = true;
    }
    const index = numberField(choice.index) ?? position;
    const delta = asRecord(choice.delta);
    if (delta === null) {
      return changed;
    }
    if (this.mendDelta(index, delta)) {
      changed = true;
    }
    return this.mendFinish(choice, index) || changed;
  }

  /** Mends one delta's content and tool calls. */
  private mendDelta(index: number, delta: Json): boolean {
    let changed = flattenContent(delta, false);
    if (delta.reasoning_content === "") {
      delete delta.reasoning_content;
      changed = true;
    }
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
      delete delta.tool_calls;
      changed = true;
    }
    if ("function_call" in delta && emptyFunctionCall(delta.function_call)) {
      delete delta.function_call;
      changed = true;
    }
    if (Array.isArray(delta.tool_calls) && this.mendCalls(index, delta)) {
      changed = true;
    }
    return changed;
  }

  /** Mends a delta's tool-call fragments and gives the delta its list back. */
  private mendCalls(index: number, delta: Json): boolean {
    let calls: unknown[] | null = Array.isArray(delta.tool_calls)
      ? (delta.tool_calls as unknown[])
      : null;
    if (calls === null) {
      return false;
    }
    let changed = false;
    let open = this.indexes.get(index);
    if (open === undefined) {
      open = { open: false, id: "", index: 0, next: 0 };
      this.indexes.set(index, open);
    }
    if (giveIndexes(open, calls)) {
      changed = true;
    }
    this.called.add(index);
    const dropped = dropNameless(this, index, calls);
    if (dropped.changed) {
      calls = dropped.kept;
      changed = true;
    }
    if (calls === null) {
      delete delta.tool_calls;
      return true;
    }
    if (mendCallIds(this.seenIds, index, calls)) {
      changed = true;
    }
    if (withoutEmptyNames(calls)) {
      changed = true;
    }
    delta.tool_calls = calls;
    return changed;
  }

  /** A finish that names the wrong thing, once the choice made a call. */
  private mendFinish(choice: Json, index: number): boolean {
    if (!this.called.has(index)) {
      return false;
    }
    if (choice.finish_reason === "stop" && this.named.has(index)) {
      choice.finish_reason = "tool_calls";
      return true;
    }
    if (choice.finish_reason === "tool_calls" && !this.named.has(index)) {
      // The call the finish named named no function: it ends stop.
      choice.finish_reason = "stop";
      return true;
    }
    return false;
  }
}

/**
 * Mends a Chat Completions reply that came whole, not streamed (myna's
 * `chatWhole`, chattidy.go:625): typed-part content, calls with no id,
 * nameless calls, a finish that names the wrong thing, and a usage in
 * another vendor's cache names.
 */
function wholeNeedsTidy(text: string, names: Set<string> | null): boolean {
  return (
    text.includes(CONTENT_PARTS) ||
    text.includes(CONTENT_PARTS_SPACE) ||
    text.includes(TOOL_CALLS_FIELD) ||
    text.includes('"function_call":{') ||
    mayMendUsage(text) ||
    (names !== null &&
      ["tool_call", "DSML", "invoke name=", "function_calls"].some((mark) => text.includes(mark)))
  );
}

/** Mends one choice of a whole reply; reports whether anything changed. */
function mendWholeChoice(entry: unknown, parts: boolean, names: Set<string> | null): boolean {
  const choice = asRecord(entry);
  const message = asRecord(choice?.message);
  if (choice === null || message === null) {
    return false;
  }
  let changed = (parts && flattenContent(message, true)) || wholeCallIds(message);
  const dropped = wholeNameless(message);
  changed = dropped || changed;
  // A call the model wrote into its text becomes the call it is, as it
  // does on the relayed stream (myna's chatWhole and wholeTextCalls).
  const wrote = wholeChatTextCalls(message.content, message.tool_calls, names);
  if (wrote.wrote) {
    message.content = wrote.content ?? null;
    if (wrote.called && wrote.calls !== undefined) {
      message.tool_calls = wrote.calls.map((call) => ({
        id: textCallID(),
        type: "function",
        function: { name: call.name, arguments: call.args },
      }));
      choice.finish_reason = "tool_calls";
    }
    changed = true;
  }
  if (
    choice.finish_reason === "stop" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  ) {
    choice.finish_reason = "tool_calls";
    changed = true;
  }
  if (dropped && choice.finish_reason === "tool_calls" && !wholeNamedCall(message)) {
    choice.finish_reason = "stop";
    changed = true;
  }
  if (changed) {
    choice.message = message;
  }
  return changed;
}

export function chatWholeTidy(text: string, names: Set<string> | null = null): string {
  if (!wholeNeedsTidy(text, names)) {
    return text;
  }
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    return text;
  }
  const record = asRecord(reply);
  if (record === null) {
    return text;
  }
  let usageMended = false;
  if ("usage" in record) {
    const usage = mendUsage(record.usage);
    if (usage !== null) {
      record.usage = usage;
      usageMended = true;
    }
  }
  const choices = Array.isArray(record.choices) ? record.choices : null;
  if (choices === null && !usageMended) {
    return text;
  }
  const parts = text.includes(CONTENT_PARTS) || text.includes(CONTENT_PARTS_SPACE);
  let changed = false;
  for (const entry of choices ?? []) {
    if (mendWholeChoice(entry, parts, names)) {
      changed = true;
    }
  }
  if (!changed && !usageMended) {
    return text;
  }
  if (changed) {
    record.choices = choices ?? [];
  }
  return JSON.stringify(record);
}

/** Gives each whole-reply call that came with no id one. */
function wholeCallIds(message: Json): boolean {
  if (!Array.isArray(message.tool_calls)) {
    return false;
  }
  let changed = false;
  for (const entry of message.tool_calls) {
    const call = asRecord(entry);
    if (call !== null && callId(call.id) === "") {
      call.id = newCallId();
      changed = true;
    }
  }
  return changed;
}

/** Drops the whole-reply calls whose function names nothing. */
function wholeNameless(message: Json): boolean {
  if (!Array.isArray(message.tool_calls)) {
    return false;
  }
  const kept = message.tool_calls.filter((entry) => {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    return fn !== null && aName(fn.name);
  });
  if (kept.length === message.tool_calls.length) {
    return false;
  }
  if (kept.length === 0) {
    delete message.tool_calls;
    return true;
  }
  message.tool_calls = kept;
  return true;
}

/** Whether a whole reply still carries a call naming itself in a string. */
function wholeNamedCall(message: Json): boolean {
  if (!Array.isArray(message.tool_calls)) {
    return false;
  }
  return message.tool_calls.some((entry) => {
    const call = asRecord(entry);
    const fn = asRecord(call?.function);
    return fn !== null && aName(fn.name);
  });
}
