/**
 * A model deep into a long conversation may write its tool calls into its
 * text instead of making them: Hermes' <tool_call>{"name":…}</tool_call>,
 * GLM's name + <arg_key>/<arg_value> pairs, DeepSeek's DSML <invoke>, or
 * Claude's own <invoke name="…">. Relayed as it came, the agent receives
 * text, runs nothing, and the turn ends. Text from the first such mark is
 * held; at the reply's end each block that names an offered tool with
 * readable arguments becomes a real call (myna's textcalls.go,
 * textcalls_relay.go and textcalls_anthropic.go).
 */

import { randomUUID } from "node:crypto";

export interface WrittenCall {
  name: string;
  args: string;
}

interface CallText {
  calls: WrittenCall[];
  rest: string;
  ok: boolean;
}

export interface StreamFilter {
  write(piece: string): string;
  flush(): string;
}

const TEXT_CALL_MARKS = ["<tool_call>", "<invoke name=", "<function_calls>", "<minimax:tool_call>"];

/** Whether a model id names one of those models, prefix aside. */
export function mayWriteCalls(text: string, names: Set<string> | null): boolean {
  if (names === null) {
    return false;
  }
  return (
    text.includes("tool_call") ||
    text.includes("DSML") ||
    text.includes("invoke name=") ||
    text.includes("function_calls")
  );
}

/** The tools a request offers, by the names its calls would say. */
export function offeredToolNames(
  protocol: "anthropic" | "openai" | "openai-responses" | "gemini",
  body: unknown,
): Set<string> | null {
  const record = asRecord(body);
  const tools = record === null ? [] : asArray(record.tools);
  const names = new Set<string>();
  for (const entry of tools) {
    const tool = asRecord(entry);
    if (tool === null) {
      continue;
    }
    if (protocol === "gemini") {
      for (const declaration of asArray(tool.functionDeclarations)) {
        const name = asRecord(declaration)?.name;
        if (typeof name === "string" && name !== "") {
          names.add(name);
        }
      }
      continue;
    }
    const direct = tool.name;
    const nested = asRecord(tool.function)?.name;
    if (typeof nested === "string" && nested !== "") {
      names.add(nested);
    } else if (typeof direct === "string" && direct !== "") {
      names.add(direct);
    }
  }
  return names.size === 0 ? null : names;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function spacesAt(text: string, index: number): number {
  let at = index;
  while (at < text.length && " \t\r\n".includes(text[at] ?? "")) {
    at += 1;
  }
  return at;
}

/**
 * Whether s begins with a DSML tag's mark: <, spaces, / for a close, a
 * pipe, a run of pipes and spaces, DSML, another run. `length` is the
 * mark's length, `more` says s could be one still being written.
 */
function dsmlMark(s: string, closing: boolean): { length: number; more: boolean } {
  if (!s.startsWith("<")) {
    return { length: 0, more: false };
  }
  let index = 1;
  const space = (): void => {
    index = spacesAt(s, index);
  };
  const pipe = (): { ok: boolean; part: boolean } => {
    if (index < s.length && s[index] === "|") {
      index += 1;
      return { ok: true, part: false };
    }
    if (s.startsWith("｜", index)) {
      index += "｜".length;
      return { ok: true, part: false };
    }
    return { ok: false, part: index < s.length && "｜".startsWith(s.slice(index)) };
  };
  const run = (): boolean => {
    for (;;) {
      space();
      const read = pipe();
      if (!read.ok) {
        return read.part;
      }
    }
  };
  space();
  if (closing && index < s.length && s[index] === "/") {
    index += 1;
    space();
  }
  if (index === s.length) {
    return { length: 0, more: true };
  }
  const opened = pipe();
  if (!opened.ok) {
    return { length: 0, more: opened.part };
  }
  if (run() || index === s.length) {
    return { length: 0, more: true };
  }
  const rest = s.slice(index);
  if (!rest.startsWith("DSML")) {
    return { length: 0, more: "DSML".startsWith(rest) };
  }
  index += "DSML".length;
  if (run() || index === s.length) {
    return { length: 0, more: true };
  }
  return { length: index, more: false };
}

/** Where a call written into the text begins, and what of its end may be one's start. */
export function textCallAt(s: string): { at: number; tail: number } {
  let at = -1;
  for (const mark of TEXT_CALL_MARKS) {
    const found = s.indexOf(mark);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
    }
  }
  let tail = 0;
  let index = s.indexOf("<");
  while (index >= 0 && (at < 0 || index < at)) {
    const mark = dsmlMark(s.slice(index), true);
    if (mark.length > 0) {
      at = index;
      break;
    }
    if (mark.more && tail === 0) {
      tail = s.length - index;
    }
    const next = s.indexOf("<", index + 1);
    if (next < 0) {
      break;
    }
    index = next;
  }
  if (at >= 0) {
    return { at, tail: 0 };
  }
  for (const mark of TEXT_CALL_MARKS) {
    for (let size = Math.min(mark.length - 1, s.length); size > tail; size -= 1) {
      if (s.endsWith(mark.slice(0, size))) {
        tail = size;
        break;
      }
    }
  }
  return { at: -1, tail };
}

const DSML_TAG = "<\\s*/?\\s*[|｜][\\s|｜]*DSML[\\s|｜]*";
const INVOKE_PRE = "(?:[|｜][\\s|｜]*DSML[\\s|｜]*|[A-Za-z_][\\w-]*:)?";
const DSML_INVOKE = new RegExp(`<\\s*${INVOKE_PRE}invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>`);
const DSML_PARAM = new RegExp(
  `<\\s*${INVOKE_PRE}parameter\\s+name\\s*=\\s*"([^"]+)"((?:\\s+\\w+\\s*=\\s*"[^"]*")*)\\s*>(.*?)<\\s*/?\\s*${INVOKE_PRE}parameter\\s*>`,
  "s",
);
const DSML_CLOSE = new RegExp(`<\\s*/\\s*${INVOKE_PRE}invoke\\s*>`);
const DSML_STRING = /string\s*=\s*"true"/;
const TEXT_CALL_JUNK = new RegExp(
  `${DSML_TAG}[^<>]*>?|[}\\]"'>]*\\s*</tool_calls?>|<tool_calls?>|<\\s*/?\\s*(?:[A-Za-z_][\\w-]*:)?(?:invoke|parameter|function_calls|tool_calls?)\\b[^<>]*>`,
  "g",
);
const PARAM_HEAD = /^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*\}?\s*>?/;
const PARAM_OPEN = /^\s*<parameter(?:\s+name\s*=\s*"([^"]+)"|=([^\s>]+))\s*>/;
const GLM_PAIR = /^\s*<arg_key>(.*?)<\/arg_key>\s*<arg_value>(.*?)<\/arg_value>/s;
const GLM_NAME = /^\s*([^\s<>{}"]+)\s*/;

let textCallSequence = 0;

export function textCallID(): string {
  textCallSequence += 1;
  return `call_text_${textCallSequence}`;
}

function junkFree(text: string): string {
  return text.replace(TEXT_CALL_JUNK, "");
}

/** The end of s that is a mark's beginning cut short, "" when there is none. */
function cutMark(s: string): string {
  const marks = [
    "</tool_call>",
    "</parameter>",
    "</invoke>",
    "</function_calls>",
    "</minimax:tool_call>",
    ...TEXT_CALL_MARKS,
  ];
  for (const mark of marks) {
    for (let size = mark.length - 1; size >= 2; size -= 1) {
      if (s.endsWith(mark.slice(0, size))) {
        return mark.slice(0, size);
      }
    }
  }
  const open = s.lastIndexOf("<");
  if (open >= 0 && /[|｜ï]/.test(s.slice(open))) {
    if (dsmlMark(s.slice(open), true).more) {
      return s.slice(open);
    }
  }
  return "";
}

function withoutCut(s: string): string {
  const mark = cutMark(s);
  return mark === "" ? s : s.slice(0, s.length - mark.length);
}

/** Whether held text is the tags of calls and nothing else. */
export function tagsOnly(s: string): boolean {
  const parsed = parseTextCalls(s, null);
  return parsed.ok && parsed.calls.length === 0 && parsed.rest === "";
}

/** The text held or pending, back with what is only spaces after a native call. */
function spaceBack(
  native: boolean,
  holding: boolean,
  pending: string,
  held: string,
  text: string,
): { pending: string; held: string; text: string } {
  if (!native || text === "" || text.trim() !== "") {
    return { pending, held, text };
  }
  if (holding) {
    return { pending, held: text + held, text: "" };
  }
  return { pending: text + pending, held, text: "" };
}

/** What is held and pending once the reply ends or makes a call. */
function settled(
  native: boolean,
  holding: boolean,
  pending: string,
  held: string,
): { pending: string; held: string; holding: boolean } {
  let nextHeld = held;
  let nextHolding = holding;
  if (holding && tagsOnly(held)) {
    nextHeld = "";
    nextHolding = false;
  }
  if (native && (pending + nextHeld).trim() === "") {
    return { pending: "", held: "", holding: false };
  }
  return { pending, held: nextHeld, holding: nextHolding };
}

/** Escapes the raw newlines, carriage returns and tabs inside a JSON text's strings. */
function escapeRawControls(s: string): { text: string; back: (offset: number) => number } {
  let out = "";
  const grew: number[] = [];
  let inside = false;
  let escaped = false;
  for (let index = 0; index < s.length; index += 1) {
    const char = s[index] ?? "";
    if (escaped) {
      escaped = false;
    } else if (inside && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inside = !inside;
    } else if (inside && (char === "\n" || char === "\r" || char === "\t")) {
      if (char === "\n") {
        out += "\\n";
      } else if (char === "\r") {
        out += "\\r";
      } else {
        out += "\\t";
      }
      grew.push(out.length);
      continue;
    }
    out += char;
  }
  return {
    text: out,
    back: (offset) => {
      let next = offset;
      for (const size of grew) {
        if (size <= next) {
          next -= 1;
        }
      }
      return next;
    },
  };
}

/** The index just past the JSON object that starts at the beginning of s. */
function jsonObjectEnd(s: string): number {
  let depth = 0;
  let inside = false;
  let escaped = false;
  for (let index = 0; index < s.length; index += 1) {
    const char = s[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inside) {
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inside = false;
      }
      continue;
    }
    if (char === '"') {
      inside = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return -1;
}

/** A call's arguments as a JSON object: one given as a JSON string is read, none is {}. */
function callArgs(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "null") {
    return "{}";
  }
  let text = raw;
  if (typeof text === "string") {
    try {
      text = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof text === "string") {
      text = escapeRawControls(text.trim()).text;
    }
  }
  const record = asRecord(text);
  if (record === null) {
    return null;
  }
  return JSON.stringify(record);
}

function hermesCall(
  s: string,
  names: Set<string> | null,
): { call: WrittenCall; taken: number } | null {
  const lead = s.length - s.replace(/^[ \t\r\n]+/, "").length;
  const body = s.slice(lead);
  if (!body.startsWith("{")) {
    return null;
  }
  const fixed = escapeRawControls(body);
  const end = jsonObjectEnd(fixed.text);
  if (end < 0) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(fixed.text.slice(0, end));
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const name = typeof record.name === "string" ? record.name : "";
  if (names === null || !names.has(name)) {
    return null;
  }
  const args = callArgs(record.arguments ?? record.parameters ?? record.input);
  if (args === null) {
    return null;
  }
  const taken = lead + fixed.back(end);
  const after = s.slice(taken);
  const junk = after.length - after.replace(/^[ \t\r\n}\]"'>]+/, "").length;
  const next = after.slice(junk);
  if (next.startsWith("</tool_call>")) {
    return { call: { name, args }, taken: taken + junk + "</tool_call>".length };
  }
  if (
    s.slice(taken, taken + junk).trim() !== "" ||
    (junk === 0 && next !== "" && next[0] !== "<")
  ) {
    if (next.includes("</tool_call>")) {
      return null;
    }
  }
  return { call: { name, args }, taken };
}

function dsmlCall(
  s: string,
  name: string,
  open: number,
  names: Set<string> | null,
): { call: WrittenCall; taken: number } | null {
  if (names === null || !names.has(name)) {
    return null;
  }
  let end = s.length;
  const close = DSML_CLOSE.exec(s.slice(open));
  if (close !== null) {
    end = open + close.index + close[0].length;
  }
  const again = DSML_INVOKE.exec(s.slice(open));
  if (again !== null && open + again.index < end) {
    end = open + again.index;
  }
  const args: Record<string, unknown> = {};
  const body = s.slice(open, end);
  for (const match of body.matchAll(new RegExp(DSML_PARAM.source, "gs"))) {
    const key = match[1] ?? "";
    const attributes = match[2] ?? "";
    const value = match[3] ?? "";
    if (DSML_STRING.test(attributes)) {
      args[key] = value;
      continue;
    }
    args[key] = jsonOrText(value);
  }
  return { call: { name, args: JSON.stringify(args) }, taken: end };
}

function jsonOrText(value: string): unknown {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function paramCall(
  s: string,
  names: Set<string> | null,
): { call: WrittenCall; taken: number } | null {
  const head = PARAM_HEAD.exec(s);
  if (head === null) {
    return null;
  }
  const name = head[1] ?? "";
  if (names === null || !names.has(name)) {
    return null;
  }
  let index = head[0].length;
  const args: Record<string, unknown> = {};
  for (;;) {
    const open = PARAM_OPEN.exec(s.slice(index));
    if (open === null) {
      break;
    }
    const key = open[1] ?? open[2] ?? "";
    index += open[0].length;
    let end = s.length;
    let next = s.length;
    for (const stop of ["</parameter>", "<parameter", "</tool_call>", "<tool_call>"]) {
      const found = s.indexOf(stop, index);
      if (found >= 0 && found < end) {
        end = found;
        next = found + (stop === "</parameter>" ? stop.length : 0);
      }
    }
    const raw = s.slice(index, end).replace(/^[\r\n]+|[\r\n]+$/g, "");
    args[key] = jsonOrText(withoutCut(raw));
    index = next;
  }
  if (Object.keys(args).length === 0) {
    return null;
  }
  const after = s.slice(index);
  const lead = after.length - after.replace(/^[ \t\r\n]+/, "").length;
  if (after.slice(lead).startsWith("</tool_call>")) {
    index += lead + "</tool_call>".length;
  }
  return { call: { name, args: JSON.stringify(args) }, taken: index };
}

function glmCall(
  s: string,
  names: Set<string> | null,
): { call: WrittenCall; taken: number } | null {
  const head = GLM_NAME.exec(s);
  if (head === null) {
    return null;
  }
  const name = head[1] ?? "";
  if (names === null || !names.has(name)) {
    return null;
  }
  let index = head[0].length;
  const args: Record<string, unknown> = {};
  for (;;) {
    const pair = GLM_PAIR.exec(s.slice(index));
    if (pair === null) {
      break;
    }
    const key = (pair[1] ?? "").trim();
    args[key] = jsonOrText(pair[2] ?? "");
    index += pair[0].length;
  }
  const after = s.slice(index);
  const lead = after.length - after.replace(/^[ \t\r\n]+/, "").length;
  const rest = after.slice(lead);
  if (rest.startsWith("</tool_call>")) {
    index += lead + "</tool_call>".length;
  } else if (rest !== "" && !rest.startsWith("<tool_call>")) {
    return null;
  }
  return { call: { name, args: JSON.stringify(args) }, taken: index };
}

/**
 * The calls written in s, which begins with one. `ok` is false unless every
 * block is a call of one of names with readable arguments; text after a
 * call ends the calls and goes.
 */
export function parseTextCalls(s: string, names: Set<string> | null): CallText {
  let calls: WrittenCall[] = [];
  let left = "";
  let rest = s;
  const text = (value: string): boolean => {
    let textValue = value;
    if (calls.length > 0) {
      textValue = junkFree(textValue).trim();
      if (withoutCut(textValue).trim() !== "") {
        return false;
      }
    }
    left += textValue;
    return true;
  };
  while (rest !== "") {
    const plain = rest.indexOf("<tool_call>");
    const invoke = DSML_INVOKE.exec(rest);
    if (plain >= 0 && (invoke === null || plain < (invoke.index ?? 0))) {
      if (!text(rest.slice(0, plain))) {
        rest = "";
        continue;
      }
      const body = rest.slice(plain + "<tool_call>".length);
      const lead = body.length - body.replace(/^[ \t\r\n]+/, "").length;
      if (body.slice(lead) === "" || body.slice(lead).startsWith("<")) {
        rest = body;
        continue;
      }
      let read = paramCall(body, names) ?? hermesCall(body, names);
      if (read === null && !body.replace(/^[ \t\r\n]+/, "").startsWith("{")) {
        read = glmCall(body, names);
      }
      if (read === null) {
        return { calls: [], rest: "", ok: false };
      }
      calls.push(read.call);
      rest = rest.slice(plain + "<tool_call>".length + read.taken);
      continue;
    }
    if (invoke !== null) {
      const start = invoke.index ?? 0;
      if (!text(rest.slice(0, start))) {
        rest = "";
        continue;
      }
      const read = dsmlCall(rest.slice(start), invoke[1] ?? "", invoke[0].length, names);
      if (read === null) {
        return { calls: [], rest: "", ok: false };
      }
      calls.push(read.call);
      rest = rest.slice(start + read.taken);
      continue;
    }
    text(rest);
    rest = "";
  }
  let kept = withoutCut(junkFree(left).trim()).trim();
  kept = kept.trim();
  return { calls, rest: kept, ok: calls.length > 0 || kept === "" };
}

/** Reads the calls written into a whole Chat reply's message content. */
export function wholeChatTextCalls(
  content: unknown,
  toolCalls: unknown,
  names: Set<string> | null,
): { wrote: boolean; called: boolean; content?: string | null; calls?: WrittenCall[] } {
  if (names === null || typeof content !== "string") {
    return { wrote: false, called: false };
  }
  const made = asArray(toolCalls).length > 0;
  const at = textCallAt(content).at;
  if (at < 0) {
    return { wrote: false, called: false };
  }
  if (made) {
    if (!tagsOnly(content.slice(at))) {
      return { wrote: false, called: false };
    }
    const text = content.slice(0, at).replace(/[ \t\r\n]+$/, "");
    return { wrote: true, called: true, content: text === "" ? null : text };
  }
  const parsed = parseTextCalls(content.slice(at), names);
  if (!parsed.ok) {
    return { wrote: false, called: false };
  }
  const text = (content.slice(0, at) + parsed.rest).replace(/[ \t\r\n]+$/, "");
  return {
    wrote: true,
    called: parsed.calls.length > 0,
    content: text,
    calls: parsed.calls,
  };
}

// debt: 逐事件状态机与 myna 一一对应，分支多且嵌套深；改写成表驱动收益低
/* eslint-disable complexity, max-depth */
/** The text of a streamed Chat reply, with its written calls made real. */
export class ChatTextCalls implements StreamFilter {
  private readonly names: Set<string> | null;
  private buffer = "";
  private pending = "";
  private held = "";
  private holding = false;
  private native = false;
  private last: Record<string, unknown> | null = null;

  public constructor(names: Set<string> | null) {
    this.names = names;
  }

  public write(piece: string): string {
    this.buffer += piece;
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) {
      return "";
    }
    const ready = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    let out = "";
    for (const line of ready.split(/(?<=\n)/)) {
      out += this.line(line);
    }
    return out;
  }

  public flush(): string {
    let out = "";
    if (this.buffer !== "") {
      out = this.line(this.buffer);
      this.buffer = "";
    }
    return out + this.release();
  }

  private chunk(delta: Record<string, unknown>, finish: unknown): string {
    const chunk: Record<string, unknown> = { object: "chat.completion.chunk" };
    for (const key of ["id", "object", "created", "model"]) {
      if (this.last !== null && key in this.last) {
        chunk[key] = this.last[key];
      }
    }
    chunk.choices = [{ index: 0, delta, finish_reason: finish }];
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  private settle(): string {
    const next = settled(this.native, this.holding, this.pending, this.held);
    this.pending = next.pending;
    this.held = next.held;
    this.holding = next.holding;
    return this.release();
  }

  private release(): string {
    const text = this.pending + this.held;
    this.pending = "";
    this.held = "";
    this.holding = false;
    if (text === "") {
      return "";
    }
    return this.chunk({ content: text }, null);
  }

  private line(line: string): string {
    const body = line.replace(/[\r\n]+$/, "");
    if (!body.startsWith("data:")) {
      return line;
    }
    const data = body.slice("data:".length).trim();
    if (data === "[DONE]") {
      return this.release() + line;
    }
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return line;
    }
    const chunk = asRecord(event);
    if (chunk === null) {
      return line;
    }
    this.last = chunk;
    const choices = asArray(chunk.choices);
    if (choices.length !== 1) {
      return line;
    }
    const choice = asRecord(choices[0]);
    if (choice === null) {
      return line;
    }
    const delta = asRecord(choice.delta);
    let pre = "";
    let changed = false;
    const calls = delta === null ? [] : asArray(delta.tool_calls);
    if (calls.length > 0 && !this.native) {
      pre = this.settle();
      this.native = true;
    }
    const content = delta?.content;
    if (delta !== null && typeof content === "string" && content !== "") {
      let text = this.pending + content;
      this.pending = "";
      if (this.holding) {
        this.held += text;
        text = "";
      } else {
        const spot = textCallAt(text);
        if (spot.at >= 0) {
          this.holding = true;
          this.held = text.slice(spot.at);
          text = text.slice(0, spot.at);
        } else {
          this.pending = text.slice(text.length - spot.tail);
          text = text.slice(0, text.length - spot.tail);
        }
      }
      const kept = spaceBack(this.native, this.holding, this.pending, this.held, text);
      this.pending = kept.pending;
      this.held = kept.held;
      text = kept.text;
      if (text === "") {
        delete delta.content;
      } else {
        delta.content = text;
      }
      changed = true;
    }
    const finish = choice.finish_reason;
    if (typeof finish === "string" && finish !== "" && (this.holding || this.pending !== "")) {
      const parsed =
        this.holding && !this.native
          ? parseTextCalls(this.held, this.names)
          : { calls: [], rest: "", ok: false };
      if (this.holding && !this.native && parsed.ok) {
        this.holding = false;
        this.held = "";
        if (parsed.rest !== "") {
          pre += this.chunk({ content: parsed.rest }, null);
        }
        const toolCalls = parsed.calls.map((call, index) => ({
          index,
          id: textCallID(),
          type: "function",
          function: { name: call.name, arguments: call.args },
        }));
        pre += this.release();
        if (toolCalls.length > 0) {
          pre += this.chunk({ tool_calls: toolCalls }, null);
          choice.finish_reason = "tool_calls";
          changed = true;
        }
      } else {
        pre += this.settle();
      }
    }
    if (!changed) {
      return pre + line;
    }
    if (
      delta !== null &&
      Object.keys(delta).length === 0 &&
      choice.finish_reason == null &&
      chunk.usage == null
    ) {
      return pre;
    }
    return `${pre}data: ${JSON.stringify(chunk)}${line.slice(body.length)}`;
  }
}
/* eslint-enable complexity, max-depth */

/** Splits an SSE region into whole events, returning the tail still open. */
function tidyEvents(
  buffer: string,
  event: (block: string) => string,
): { out: string; rest: string } {
  let out = "";
  let at = 0;
  for (;;) {
    const end = eventEnd(buffer.slice(at));
    if (end < 0) {
      break;
    }
    out += event(buffer.slice(at, at + end));
    at += end;
  }
  return { out, rest: buffer.slice(at) };
}

export function eventEnd(text: string): number {
  for (let index = 0; index + 1 < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    if (text[index + 1] === "\n") {
      return index + 2;
    }
    if (text[index + 1] === "\r" && index + 2 < text.length && text[index + 2] === "\n") {
      return index + 3;
    }
  }
  return -1;
}

/** An event's data, its lines joined. */
export function eventData(event: string): string {
  const values: string[] = [];
  for (const line of event.split("\n")) {
    const body = line.replace(/\r+$/, "");
    if (!body.startsWith("data:")) {
      continue;
    }
    values.push(body.slice("data:".length).replace(/^ /, ""));
  }
  return values.join("\n");
}

export function withData(event: string, data: string): string {
  let out = "";
  let put = false;
  for (const line of event.split(/(?<=\n)/)) {
    const body = line.replace(/[\r\n]+$/, "");
    if (body.startsWith("data:")) {
      if (!put) {
        out += `data: ${data}${line.slice(body.length)}`;
        put = true;
      }
      continue;
    }
    out += line;
  }
  return out;
}

function messagesEvent(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}

// debt: 逐事件状态机与 myna 一一对应，分支多且嵌套深；改写成表驱动收益低
/* eslint-disable complexity, max-depth */
/**
 * A relayed Messages reply: text held from where a call begins, its block's
 * start and stop held with it, the calls made tool_use blocks at
 * message_delta.
 */
export class AnthropicTextCalls implements StreamFilter {
  private readonly names: Set<string> | null;
  private readonly sse: boolean;
  private buffer = "";

  private idx = 0;
  private text = false;
  private startHeld: string | null = null;
  private stopHeld: string | null = null;
  private pending = "";
  private held = "";
  private holding = false;
  private native = false;
  private top = 0;

  public constructor(names: Set<string> | null, sse: boolean) {
    this.names = names;
    this.sse = sse;
  }

  public write(piece: string): string {
    this.buffer += piece;
    if (!this.sse) {
      return "";
    }
    const split = tidyEvents(this.buffer, (block) => this.event(block));
    this.buffer = split.rest;
    return split.out;
  }

  public flush(): string {
    const pending = this.buffer;
    this.buffer = "";
    if (!this.sse) {
      return this.whole(pending);
    }
    let out = pending === "" ? "" : this.event(pending);
    return out + this.release();
  }

  private textDelta(text: string): string {
    return messagesEvent("content_block_delta", {
      type: "content_block_delta",
      index: this.idx,
      delta: { type: "text_delta", text },
    });
  }

  // debt: 事件类型分支多，与 myna 一一对应；再加事件类型时改表驱动
  // eslint-disable-next-line complexity
  private event(block: string): string {
    const data = eventData(block);
    if (data === "") {
      return block;
    }
    let event: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(data));
      if (parsed === null) {
        return block;
      }
      event = parsed;
    } catch {
      return block;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const index = typeof event.index === "number" ? event.index : 0;
    if (type === "content_block_start") {
      const pre = this.release();
      this.top = Math.max(this.top, index + 1);
      const contentBlock = asRecord(event.content_block);
      const blockType = typeof contentBlock?.type === "string" ? contentBlock.type : "";
      const text = typeof contentBlock?.text === "string" ? contentBlock.text : "";
      if (blockType === "tool_use" || blockType === "server_tool_use") {
        this.native = true;
      }
      if (blockType === "text" && text === "") {
        this.idx = index;
        this.text = true;
        this.startHeld = block;
        return pre;
      }
      this.text = false;
      return pre + block;
    }
    if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      const deltaType = typeof delta?.type === "string" ? delta.type : "";
      const deltaText = typeof delta?.text === "string" ? delta.text : "";
      if (!this.text || index !== this.idx || deltaType !== "text_delta") {
        return block;
      }
      let text = this.pending + deltaText;
      this.pending = "";
      if (this.holding) {
        this.held += text;
        return "";
      }
      const spot = textCallAt(text);
      if (spot.at >= 0) {
        this.holding = true;
        this.held = text.slice(spot.at);
        text = text.slice(0, spot.at);
      } else {
        this.pending = text.slice(text.length - spot.tail);
        text = text.slice(0, text.length - spot.tail);
      }
      const kept = spaceBack(this.native, this.holding, this.pending, this.held, text);
      this.pending = kept.pending;
      this.held = kept.held;
      text = kept.text;
      if (text === "") {
        return "";
      }
      const out = this.startHeld ?? "";
      this.startHeld = null;
      return out + this.textDelta(text);
    }
    if (type === "content_block_stop") {
      if (!this.text || index !== this.idx) {
        return block;
      }
      if (this.holding || this.pending !== "") {
        this.stopHeld = block;
        return "";
      }
      const out = this.startHeld ?? "";
      this.startHeld = null;
      this.text = false;
      return out + block;
    }
    if (type === "message_delta") {
      const pre: string[] = [];
      if (this.holding && !this.native && !hasReview(event.delta)) {
        const parsed = parseTextCalls(this.held, this.names);
        if (parsed.ok) {
          this.held = "";
          this.holding = false;
          const rest = this.pending + parsed.rest;
          this.pending = "";
          if (rest !== "") {
            if (this.startHeld !== null) {
              pre.push(this.startHeld);
              this.startHeld = null;
            }
            pre.push(this.textDelta(rest));
          }
          let next = this.top;
          if (this.startHeld !== null) {
            next = this.idx;
            this.startHeld = null;
            this.stopHeld = null;
          } else {
            if (this.stopHeld === null) {
              this.stopHeld = messagesEvent("content_block_stop", {
                type: "content_block_stop",
                index: this.idx,
              });
            }
            pre.push(this.stopHeld);
            this.stopHeld = null;
          }
          this.text = false;
          parsed.calls.forEach((call, position) => {
            const at = next + position;
            pre.push(
              messagesEvent("content_block_start", {
                type: "content_block_start",
                index: at,
                content_block: {
                  type: "tool_use",
                  id: textCallID(),
                  name: call.name,
                  input: {},
                },
              }),
              messagesEvent("content_block_delta", {
                type: "content_block_delta",
                index: at,
                delta: { type: "input_json_delta", partial_json: call.args },
              }),
              messagesEvent("content_block_stop", { type: "content_block_stop", index: at }),
            );
          });
          this.top = next + parsed.calls.length;
          if (parsed.calls.length > 0) {
            const delta = asRecord(event.delta);
            if (delta !== null) {
              delta.stop_reason = "tool_use";
              return pre.join("") + this.release() + messagesEvent(type, delta);
            }
          }
        }
      } else {
        const next = settled(this.native, this.holding, this.pending, this.held);
        this.pending = next.pending;
        this.held = next.held;
        this.holding = next.holding;
      }
      return pre.join("") + this.release() + block;
    }
    if (type === "message_stop" || type === "error") {
      return this.release() + block;
    }
    return block;
  }

  private release(): string {
    const text = this.pending + this.held;
    this.pending = "";
    this.held = "";
    this.holding = false;
    let out = "";
    if (text !== "" || this.stopHeld !== null) {
      out += this.startHeld ?? "";
      this.startHeld = null;
    }
    if (text !== "") {
      out += this.textDelta(text);
    }
    if (this.stopHeld !== null) {
      out += this.stopHeld;
      this.stopHeld = null;
      this.text = false;
    }
    return out;
  }

  private whole(body: string): string {
    if (!mayWriteCalls(body, this.names)) {
      return body;
    }
    let reply: Record<string, unknown>;
    try {
      const parsed = asRecord(JSON.parse(body));
      if (parsed === null) {
        return body;
      }
      reply = parsed;
    } catch {
      return body;
    }
    if ("safeguard_results" in reply) {
      return body;
    }
    const content = asArray(reply.content)
      .map((entry) => asRecord(entry))
      .filter(isRecord);
    if (content.length === 0) {
      return body;
    }
    for (const block of content) {
      if (block.type === "tool_use" || block.type === "server_tool_use") {
        return body;
      }
    }
    const last = content[content.length - 1];
    if (last === undefined || last.type !== "text" || typeof last.text !== "string") {
      return body;
    }
    const text = last.text;
    const at = textCallAt(text).at;
    if (at < 0) {
      return body;
    }
    const parsed = parseTextCalls(text.slice(at), this.names);
    if (!parsed.ok) {
      return body;
    }
    const kept = content.slice(0, -1);
    const leftover = (text.slice(0, at) + parsed.rest).replace(/[ \t\r\n]+$/, "");
    if (leftover !== "") {
      last.text = leftover;
      kept.push(last);
    }
    for (const call of parsed.calls) {
      kept.push({
        type: "tool_use",
        id: textCallID(),
        name: call.name,
        input: JSON.parse(call.args),
      });
    }
    reply.content = kept;
    if (parsed.calls.length > 0) {
      reply.stop_reason = "tool_use";
    }
    return JSON.stringify(reply);
  }
}
/* eslint-enable complexity, max-depth */

function isRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null;
}

function hasReview(delta: unknown): boolean {
  const record = asRecord(delta);
  return record !== null && "safeguard_results" in record;
}
function newID(): string {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

/** Rewrites one event's data, keeping its other lines. */
function rewriteData(event: string, data: string): string {
  return withData(event, data);
}

function patched(event: string, patch: Record<string, unknown>): string {
  return rewriteData(event, JSON.stringify(patch));
}

// debt: 逐事件状态机与 myna 一一对应，分支多且嵌套深；改写成表驱动收益低
/* eslint-disable complexity, max-depth */
/**
 * A relayed Responses reply: text held from where a call begins, the
 * message item's done events held with it, the calls made function_call
 * items after it in both the events and response.completed's output.
 */
export class ResponsesTextCalls implements StreamFilter {
  private readonly names: Set<string> | null;
  private readonly sse: boolean;
  private buffer = "";
  private seq = -1;
  private numbers = false;

  private pending = "";
  private held = "";
  private holding = false;
  private native = false;

  private itemID = "";
  private itemIdx = 0;
  private partIdx = 0;
  private top = 0;
  private textDone: string | null = null;
  private partDone: string | null = null;
  private itemDone: string | null = null;

  public constructor(names: Set<string> | null, sse: boolean) {
    this.names = names;
    this.sse = sse;
  }

  public write(piece: string): string {
    this.buffer += piece;
    if (!this.sse) {
      return "";
    }
    const split = tidyEvents(this.buffer, (block) => this.event(block));
    this.buffer = split.rest;
    return this.numbered(split.out);
  }

  public flush(): string {
    const pending = this.buffer;
    this.buffer = "";
    if (!this.sse) {
      return this.whole(pending);
    }
    let out = pending === "" ? "" : this.event(pending);
    out += this.release();
    return this.numbered(out);
  }

  /** Gives each event a sequence number past the last one sent. */
  private numbered(out: string): string {
    if (out === "") {
      return out;
    }
    let result = "";
    let rest = out;
    while (rest !== "") {
      let size = eventEnd(rest);
      if (size < 0) {
        size = rest.length;
      }
      const event = rest.slice(0, size);
      rest = rest.slice(size);
      const data = eventData(event);
      const match = /("sequence_number"\s*:\s*)(\d+)/.exec(data);
      if (match === null) {
        result += event;
        continue;
      }
      let want = Number.parseInt(match[2] ?? "0", 10);
      if (this.seq >= 0 && want <= this.seq) {
        want = this.seq + 1;
      }
      this.seq = want;
      if (Number.parseInt(match[2] ?? "0", 10) === want) {
        result += event;
        continue;
      }
      const rewritten = data.replace(
        /("sequence_number"\s*:\s*)(\d+)/,
        (_all, lead: string) => `${lead}${want}`,
      );
      result += rewriteData(event, rewritten);
    }
    return result;
  }

  private send(type: string, fields: Record<string, unknown>): string {
    const body = { ...fields };
    if (this.numbers) {
      body.sequence_number = this.seq + 1;
    }
    body.type = type;
    return messagesEvent(type, body);
  }

  private textDelta(text: string): string {
    if (text === "") {
      return "";
    }
    return this.send("response.output_text.delta", {
      item_id: this.itemID,
      output_index: this.itemIdx,
      content_index: this.partIdx,
      delta: text,
      logprobs: [],
    });
  }

  private release(): string {
    let out = this.textDelta(this.pending + this.held);
    this.pending = "";
    this.held = "";
    this.holding = false;
    out += this.textDone ?? "";
    out += this.partDone ?? "";
    out += this.itemDone ?? "";
    this.textDone = null;
    this.partDone = null;
    this.itemDone = null;
    return out;
  }

  private doneText(text: string): string {
    let out = "";
    for (const event of [this.textDone, this.partDone]) {
      if (event === null) {
        continue;
      }
      const parsed = asRecord(JSON.parse(eventData(event)));
      if (parsed === null) {
        out += event;
        continue;
      }
      const part = asRecord(parsed.part);
      if (part !== null) {
        part.text = text;
      } else {
        parsed.text = text;
      }
      out += patched(event, parsed);
    }
    return out;
  }

  private itemText(text: string): string {
    if (this.itemDone === null) {
      return "";
    }
    const parsed = asRecord(JSON.parse(eventData(this.itemDone)));
    const item = asRecord(parsed?.item);
    const content = asArray(item?.content);
    const part = asRecord(content[this.partIdx]);
    if (part === null || part.type !== "output_text") {
      return this.itemDone;
    }
    part.text = text;
    return patched(this.itemDone, parsed ?? {});
  }

  private event(block: string): string {
    const data = eventData(block);
    const parsed = safeRecord(data);
    if (parsed === null) {
      return block;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (!this.numbers && "sequence_number" in parsed) {
      this.numbers = true;
    }
    if (typeof parsed.output_index === "number") {
      this.top = Math.max(this.top, parsed.output_index + 1);
    }
    if (type === "response.output_item.added") {
      const itemType = asRecord(parsed.item)?.type;
      if (typeof itemType === "string" && itemType.endsWith("_call")) {
        this.native = true;
      }
      return block;
    }
    if (type === "response.output_text.delta") {
      this.itemID = typeof parsed.item_id === "string" ? parsed.item_id : "";
      this.itemIdx = typeof parsed.output_index === "number" ? parsed.output_index : 0;
      this.partIdx = typeof parsed.content_index === "number" ? parsed.content_index : 0;
      let text = this.pending + (typeof parsed.delta === "string" ? parsed.delta : "");
      this.pending = "";
      if (this.holding) {
        this.held += text;
        return "";
      }
      const spot = textCallAt(text);
      if (spot.at >= 0) {
        this.holding = true;
        this.held = text.slice(spot.at);
        text = text.slice(0, spot.at);
      } else {
        this.pending = text.slice(text.length - spot.tail);
        text = text.slice(0, text.length - spot.tail);
      }
      const kept = spaceBack(this.native, this.holding, this.pending, this.held, text);
      this.pending = kept.pending;
      this.held = kept.held;
      text = kept.text;
      if (text === "") {
        return "";
      }
      parsed.delta = text;
      return patched(block, parsed);
    }
    if (type === "response.output_text.done") {
      if (!this.holding) {
        const out = this.textDelta(this.pending);
        this.pending = "";
        return out + block;
      }
      if (this.textDone === null) {
        this.textDone = block;
        return "";
      }
      return block;
    }
    if (type === "response.content_part.done") {
      if (this.holding && this.partDone === null) {
        this.partDone = block;
        return "";
      }
      return block;
    }
    if (type === "response.output_item.done") {
      const item = asRecord(parsed.item);
      if (
        this.holding &&
        this.itemDone === null &&
        item?.type === "message" &&
        item.id === this.itemID
      ) {
        this.itemDone = block;
        return "";
      }
      return block;
    }
    if (type === "response.completed") {
      return this.completed(block, parsed);
    }
    if (type === "response.incomplete" || type === "response.failed" || type === "error") {
      return this.release() + block;
    }
    return block;
  }

  private completed(block: string, parsed: Record<string, unknown>): string {
    if (!this.holding) {
      return this.release() + block;
    }
    const prefix = (event: string | null): string => {
      if (event === null) {
        return "";
      }
      const data = safeRecord(eventData(event));
      let text = typeof data?.text === "string" ? data.text : "";
      const part = asRecord(data?.part);
      if (text === "" && typeof part?.text === "string") {
        text = part.text;
      }
      return text.endsWith(this.held) ? text.slice(0, text.length - this.held.length) : text;
    };
    if (this.native) {
      if (!tagsOnly(this.held)) {
        return this.release() + block;
      }
      const text = prefix(this.textDone).replace(/[ \t\r\n]+$/, "");
      let out = this.doneText(text);
      out += this.itemText(text);
      this.pending = "";
      this.held = "";
      this.holding = false;
      this.textDone = null;
      this.partDone = null;
      this.itemDone = null;
      return out + this.rewritten(block, parsed, text, []);
    }
    const written = parseTextCalls(this.held, this.names);
    if (!written.ok) {
      return this.release() + block;
    }
    const text = prefix(this.textDone) + written.rest;
    let out = this.doneText(text);
    const items: Array<Record<string, unknown>> = [];
    let next = this.top;
    if (this.itemDone === null) {
      next = this.itemIdx;
    } else {
      out += this.itemText(text);
    }
    this.pending = "";
    this.held = "";
    this.holding = false;
    this.textDone = null;
    this.partDone = null;
    this.itemDone = null;
    for (const call of written.calls) {
      const id = `fc_${newID()}`;
      const callID = `call_${newID()}`;
      const item = {
        type: "function_call",
        id,
        call_id: callID,
        name: call.name,
        arguments: call.args,
        status: "completed",
      };
      out += this.send("response.output_item.added", {
        output_index: next,
        item: {
          type: "function_call",
          id,
          call_id: callID,
          name: call.name,
          arguments: "",
          status: "in_progress",
        },
      });
      out += this.send("response.function_call_arguments.delta", {
        item_id: id,
        output_index: next,
        delta: call.args,
      });
      out += this.send("response.function_call_arguments.done", {
        item_id: id,
        output_index: next,
        call_id: callID,
        arguments: call.args,
      });
      out += this.send("response.output_item.done", { output_index: next, item });
      items.push(item);
      next += 1;
    }
    this.top = next;
    return out + this.rewritten(block, parsed, text, items);
  }

  private rewritten(
    block: string,
    parsed: Record<string, unknown>,
    text: string,
    items: Array<Record<string, unknown>>,
  ): string {
    if (items.length === 0 && this.itemDone === null) {
      return block;
    }
    const response = asRecord(parsed.response);
    if (response === null) {
      return block;
    }
    const output = asArray(response.output);
    let changed = items.length > 0;
    for (const entry of output) {
      const item = asRecord(entry);
      if (item === null || item.id !== this.itemID) {
        continue;
      }
      const content = asArray(item.content);
      const part = asRecord(content[this.partIdx]);
      if (part !== null && part.type === "output_text") {
        part.text = text;
        changed = true;
      }
      break;
    }
    if (!changed) {
      return block;
    }
    response.output = [...output, ...items];
    return patched(block, parsed);
  }

  private whole(body: string): string {
    if (!mayWriteCalls(body, this.names)) {
      return body;
    }
    const reply = safeRecord(body);
    if (reply === null) {
      return body;
    }
    const output = asArray(reply.output);
    if (output.length === 0) {
      return body;
    }
    let native = false;
    for (const entry of output) {
      const type = asRecord(entry)?.type;
      if (typeof type === "string" && type.endsWith("_call")) {
        native = true;
      }
    }
    let at = -1;
    let part: Record<string, unknown> | null = null;
    for (const entry of output) {
      const item = asRecord(entry);
      if (item === null || item.type !== "message") {
        continue;
      }
      for (const entryPart of asArray(item.content)) {
        const piece = asRecord(entryPart);
        if (piece === null || piece.type !== "output_text" || typeof piece.text !== "string") {
          continue;
        }
        const found = textCallAt(piece.text).at;
        if (found >= 0) {
          at = found;
          part = piece;
        }
      }
    }
    if (part === null || typeof part.text !== "string") {
      return body;
    }
    const text = part.text;
    if (native) {
      if (!tagsOnly(text.slice(at))) {
        return body;
      }
      part.text = text.slice(0, at).replace(/[ \t\r\n]+$/, "");
    } else {
      const written = parseTextCalls(text.slice(at), this.names);
      if (!written.ok) {
        return body;
      }
      part.text = text.slice(0, at) + written.rest;
      for (const call of written.calls) {
        output.push({
          type: "function_call",
          id: `fc_${newID()}`,
          call_id: `call_${newID()}`,
          name: call.name,
          arguments: call.args,
          status: "completed",
        });
      }
    }
    reply.output = output;
    return JSON.stringify(reply);
  }
}
/* eslint-enable complexity, max-depth */

function safeRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

interface GeminiHold {
  pending: string;
  held: string;
  holding: boolean;
  native: boolean;
}

// debt: 逐事件状态机与 myna 一一对应，分支多且嵌套深；改写成表驱动收益低
/* eslint-disable complexity, max-depth */
/** A relayed Gemini reply: text parts read as they come, calls made at finishReason. */
export class GeminiTextCalls implements StreamFilter {
  private readonly names: Set<string> | null;
  private readonly sse: boolean;
  private buffer = "";
  private readonly holds = new Map<number, GeminiHold>();

  public constructor(names: Set<string> | null, sse: boolean) {
    this.names = names;
    this.sse = sse;
  }

  public write(piece: string): string {
    this.buffer += piece;
    if (!this.sse) {
      return "";
    }
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) {
      return "";
    }
    const ready = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    let out = "";
    for (const line of ready.split(/(?<=\n)/)) {
      out += this.line(line);
    }
    return out;
  }

  public flush(): string {
    const pending = this.buffer;
    this.buffer = "";
    if (!this.sse) {
      return this.whole(pending);
    }
    return pending === "" ? "" : this.line(pending);
  }

  private hold(index: number): GeminiHold {
    let hold = this.holds.get(index);
    if (hold === undefined) {
      hold = { pending: "", held: "", holding: false, native: false };
      this.holds.set(index, hold);
    }
    return hold;
  }

  private line(line: string): string {
    const body = line.replace(/[\r\n]+$/, "");
    if (!body.startsWith("data:")) {
      return line;
    }
    const data = body.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") {
      return line;
    }
    const chunk = safeRecord(data);
    if (chunk === null) {
      return line;
    }
    if (!this.candidates(chunk)) {
      return line;
    }
    return `data: ${JSON.stringify(chunk)}${line.slice(body.length)}`;
  }

  private candidates(chunk: Record<string, unknown>): boolean {
    let changed = false;
    asArray(chunk.candidates).forEach((entry, index) => {
      const candidate = asRecord(entry);
      if (candidate === null) {
        return;
      }
      const hold = this.hold(index);
      const content = asRecord(candidate.content);
      const parts = asArray(content?.parts);
      const keep: unknown[] = [];
      for (const entryPart of parts) {
        const part = asRecord(entryPart);
        if (part === null) {
          keep.push(part);
          continue;
        }
        if (part.functionCall !== undefined && part.functionCall !== null) {
          hold.native = true;
          keep.push(part);
          continue;
        }
        if (typeof part.text !== "string") {
          keep.push(part);
          continue;
        }
        if (part.thought === true) {
          keep.push(part);
          continue;
        }
        const was = part.text;
        let text = hold.pending + was;
        hold.pending = "";
        if (hold.holding) {
          hold.held += text;
          changed = true;
          continue;
        }
        const spot = textCallAt(text);
        if (spot.at >= 0) {
          hold.holding = true;
          hold.held = text.slice(spot.at);
          text = text.slice(0, spot.at);
        } else {
          hold.pending = text.slice(text.length - spot.tail);
          text = text.slice(0, text.length - spot.tail);
        }
        if (text !== was) {
          changed = true;
        }
        if (text !== "") {
          part.text = text;
          keep.push(part);
        }
      }
      const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
      if (finish !== "") {
        let text = hold.pending;
        hold.pending = "";
        if (hold.holding) {
          hold.holding = false;
          if (!hold.native) {
            const written = parseTextCalls(hold.held, this.names);
            if (written.ok) {
              hold.held = "";
              text += written.rest;
              for (const call of written.calls) {
                keep.push({ functionCall: { name: call.name, args: JSON.parse(call.args) } });
              }
            } else {
              text += hold.held;
              hold.held = "";
            }
          } else if (tagsOnly(hold.held)) {
            hold.held = "";
          } else {
            text += hold.held;
            hold.held = "";
          }
          changed = true;
        }
        if (text !== "") {
          keep.push({ text });
          changed = true;
        }
      }
      if (changed && content !== null) {
        content.parts = keep;
      }
    });
    return changed;
  }

  private whole(body: string): string {
    if (!mayWriteCalls(body, this.names)) {
      return body;
    }
    const chunk = safeRecord(body);
    if (chunk === null) {
      return body;
    }
    let changed = false;
    for (const entry of asArray(chunk.candidates)) {
      const candidate = asRecord(entry);
      if (candidate === null) {
        continue;
      }
      const content = asRecord(candidate.content);
      const parts = asArray(content?.parts);
      let native = false;
      let part: Record<string, unknown> | null = null;
      for (const entryPart of parts) {
        const piece = asRecord(entryPart);
        if (piece === null) {
          continue;
        }
        if (piece.functionCall !== undefined && piece.functionCall !== null) {
          native = true;
          continue;
        }
        if (typeof piece.text === "string" && piece.thought !== true) {
          part = piece;
        }
      }
      if (part === null || native || typeof part.text !== "string") {
        continue;
      }
      const text = part.text;
      const at = textCallAt(text).at;
      if (at < 0) {
        continue;
      }
      const written = parseTextCalls(text.slice(at), this.names);
      if (!written.ok) {
        continue;
      }
      part.text = text.slice(0, at) + written.rest;
      for (const call of written.calls) {
        parts.push({ functionCall: { name: call.name, args: JSON.parse(call.args) } });
      }
      if (content !== null) {
        content.parts = parts;
      }
      changed = true;
    }
    return changed ? JSON.stringify(chunk) : body;
  }
}

type RelayProtocol = "anthropic" | "openai" | "openai-responses" | "gemini";

/** The filter that makes a relayed reply's written calls real, if it needs one. */
export function relayedTextCalls(
  protocol: RelayProtocol,
  names: Set<string> | null,
  sse: boolean,
): StreamFilter | null {
  if (names === null) {
    return null;
  }
  if (protocol === "openai") {
    return sse ? new ChatTextCalls(names) : null;
  }
  if (protocol === "anthropic") {
    return new AnthropicTextCalls(names, sse);
  }
  if (protocol === "openai-responses") {
    return new ResponsesTextCalls(names, sse);
  }
  if (protocol === "gemini") {
    return new GeminiTextCalls(names, sse);
  }
  return null;
}

/** A reply that came whole, with its written calls made real. */
export function wholeRelayedTextCalls(
  protocol: RelayProtocol,
  names: Set<string> | null,
  body: string,
): string | null {
  const filter = relayedTextCalls(protocol, names, false);
  if (filter === null) {
    return null;
  }
  filter.write(body);
  return filter.flush();
}

/** Two filters, the first's output the second's input. */
export function chainFilters(filters: StreamFilter[]): StreamFilter | null {
  if (filters.length === 0) {
    return null;
  }
  if (filters.length === 1) {
    return filters[0] ?? null;
  }
  return {
    write(piece: string): string {
      let out = piece;
      for (const filter of filters) {
        out = filter.write(out);
        if (out === "") {
          return "";
        }
      }
      return out;
    },
    flush(): string {
      let out = "";
      for (let index = 0; index < filters.length; index += 1) {
        const filter = filters[index];
        if (filter === undefined) {
          continue;
        }
        let piece = filter.flush();
        for (let next = index + 1; next < filters.length && piece !== ""; next += 1) {
          piece = filters[next]?.write(piece) ?? "";
        }
        out += piece;
      }
      return out;
    },
  };
}
/* eslint-enable complexity, max-depth */
