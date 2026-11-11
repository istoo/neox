/**
 * A try's stream let through on its reasoning, or on what only frames a
 * reply, while another candidate stands behind it: the vendor's safety
 * filter may still refuse before a word of the answer, and the refusal
 * then goes to the next candidate, whose stream follows in the same
 * response (myna's refusal_handover.go). Once an answer's text or a call
 * begins, a refusal is the agent's, as before.
 */

import { eventData, eventEnd, type StreamFilter, withData } from "./text-calls.js";

/** How a vendor says its safety filter stopped the reply. */
const FILTER_REASONS: Record<string, string> = {
  refusal: "refusal",
  content_filter: "content_filter",
  content_policy_violation: "content_filter",
  content_policy_rejected: "content_policy_rejected",
  sensitive: "sensitive",
  data_inspection_failed: "data_inspection_failed",
  DataInspectionFailed: "data_inspection_failed",
  SAFETY: "safety",
  PROHIBITED_CONTENT: "safety",
  BLOCKLIST: "safety",
  SPII: "safety",
  IMAGE_SAFETY: "safety",
};

const POLICY_CODE = /^[a-z]+_policy$/;
const SENSITIVE_CODE = /SensitiveContentDetected$/;
const FLAGGED_WORDS = /flagged|usage polic/i;
const HIGH_RISK = "The request was rejected because it was considered high risk";

/** What a refusal with nothing said is answered as. */
export const REFUSED_STATUS = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function refusedNote(reason: string): string {
  return `safety filter: ${reason}`;
}

/** A refusal's note with Anthropic's category and explanation, when given. */
export function refusedDetail(reason: string, details: unknown): string {
  const note = refusedNote(reason);
  const detail = asRecord(details);
  if (detail === null) {
    return note;
  }
  const said: string[] = [];
  if (typeof detail.category === "string" && detail.category.trim() !== "") {
    said.push(`category ${detail.category.trim()}`);
  }
  if (typeof detail.explanation === "string" && detail.explanation.trim() !== "") {
    let text = detail.explanation.split(/\s+/u).filter(Boolean).join(" ");
    if ([...text].length > 200) {
      text = `${[...text].slice(0, 200).join("")}…`;
    }
    said.push(text);
  }
  return said.length === 0 ? note : `${note} (${said.join(": ")})`;
}

/** An error's code, or its type when it has none. */
function errorCodeOf(error: Record<string, unknown>): string {
  if (typeof error.code === "string" && error.code !== "") {
    return error.code;
  }
  return typeof error.type === "string" ? error.type : "";
}

/**
 * Whether an error object is the vendor's safety filter refusing the
 * request: a filter code, a usage-policy code, or a flagged prompt.
 */
export function policyRefusal(raw: unknown): string | null {
  const body = asRecord(raw);
  if (body === null) {
    return null;
  }
  const inner = asRecord(body.error);
  const source = inner ?? body;
  const code = errorCodeOf(source);
  const message = typeof source.message === "string" ? source.message.trim() : "";
  const note = (reason: string): string =>
    message === ""
      ? refusedNote(reason)
      : `${refusedNote(reason)} — ${[...message].slice(0, 1000).join("")}${
          [...message].length > 1000 ? "…" : ""
        }`;
  if (FILTER_REASONS[code] !== undefined) {
    return note(FILTER_REASONS[code] as string);
  }
  if (POLICY_CODE.test(code) || SENSITIVE_CODE.test(code)) {
    return note(code);
  }
  if (code === "1301" && message.includes("敏感")) {
    return note("sensitive");
  }
  if (code === "invalid_prompt" && FLAGGED_WORDS.test(message)) {
    return note(code);
  }
  if (message === HIGH_RISK) {
    return note("high risk");
  }
  return null;
}

/** Whether a request refused this many times is asked of another left. */
export function refusalAsksAgain(refusals: number, retries: number | undefined): boolean {
  return retries === undefined || retries < 0 || refusals <= retries;
}

export type StreamKind = "lead" | "thinking" | "buffering" | "refusal" | "refusal_error" | "answer";

export interface StreamVerdict {
  kind: StreamKind;
  status: number;
  message: string;
}

const LEAD: StreamVerdict = { kind: "lead", status: 0, message: "" };
const THINKING: StreamVerdict = { kind: "thinking", status: 0, message: "" };
const ANSWER: StreamVerdict = { kind: "answer", status: 0, message: "" };
const BUFFERING: StreamVerdict = { kind: "buffering", status: 0, message: "" };

function refusal(reason: string): StreamVerdict {
  return { kind: "refusal", status: REFUSED_STATUS, message: refusedNote(reason) };
}

function refusalError(note: string): StreamVerdict {
  return { kind: "refusal_error", status: REFUSED_STATUS, message: note };
}

/** Whether a stream part is reasoning, said or not. */
function thoughtPart(part: Record<string, unknown> | null): boolean {
  const type = part?.type;
  return (
    type === "thinking" ||
    type === "redacted_thinking" ||
    type === "summary_text" ||
    type === "reasoning_text" ||
    type === "reasoning"
  );
}

/** Whether a stream part says something the agent would show or act on. */
function saidPart(part: Record<string, unknown> | null): boolean {
  if (part === null) {
    return false;
  }
  const type = typeof part.type === "string" ? part.type : "";
  if (
    type === "text" ||
    type === "output_text" ||
    type === "summary_text" ||
    type === "reasoning_text"
  ) {
    return part.text !== undefined && part.text !== "";
  }
  if (type === "thinking") {
    return part.thinking !== undefined && part.thinking !== "";
  }
  if (type === "redacted_thinking") {
    return false;
  }
  if (type === "message" || type === "reasoning") {
    const contents = [...(asArray(part.content) ?? []), ...(asArray(part.summary) ?? [])];
    return contents.some((entry) => {
      const item = asRecord(entry);
      return (item?.text ?? "") !== "" || (item?.refusal ?? "") !== "";
    });
  }
  return type.includes("call") || type.includes("tool") || type.startsWith("mcp_");
}

function anthropicDeltaThinks(delta: unknown): boolean {
  const record = asRecord(delta);
  return record?.type === "thinking_delta" && (record.thinking ?? "") !== "";
}

function anthropicDeltaSays(delta: unknown): boolean {
  const record = asRecord(delta);
  if (record === null) {
    return true;
  }
  if (record.type === "signature_delta") {
    return false;
  }
  if (record.type === "text_delta") {
    return (record.text ?? "") !== "";
  }
  if (record.type === "thinking_delta") {
    return (record.thinking ?? "") !== "";
  }
  return true;
}

function chatVerdict(choices: unknown[]): StreamVerdict {
  let thinks = false;
  for (const entry of choices) {
    const choice = asRecord(entry);
    if (choice === null) {
      continue;
    }
    const delta = asRecord(choice.delta) ?? {};
    for (const [key, value] of Object.entries(delta)) {
      if (key === "role" || value === null || value === "" || value === undefined) {
        continue;
      }
      if (key !== "reasoning_content" && key !== "reasoning") {
        return ANSWER;
      }
      thinks = true;
    }
    const finish = choice.finish_reason;
    if (thinks && (finish === null || finish === undefined)) {
      continue;
    }
    if (finish !== null && finish !== undefined) {
      const reason = String(finish);
      const filter = FILTER_REASONS[reason];
      return filter === undefined ? ANSWER : refusal(filter);
    }
  }
  return thinks ? THINKING : LEAD;
}

/** What one Gemini candidate's parts say: thinking, an answer, or nothing. */
function geminiParts(parts: unknown[]): StreamVerdict {
  let thinks = false;
  for (const entry of parts) {
    const part = asRecord(entry);
    if (part === null) {
      return ANSWER;
    }
    if (part.thought === true && (part.text ?? "") !== "") {
      thinks = true;
      continue;
    }
    if ((part.text ?? "") !== "" || !("text" in part)) {
      return ANSWER;
    }
  }
  return thinks ? THINKING : LEAD;
}

function geminiVerdict(chunk: Record<string, unknown>): StreamVerdict | null {
  const block = chunk.promptFeedback;
  const blockRecord = asRecord(block);
  const blockReason = typeof blockRecord?.blockReason === "string" ? blockRecord.blockReason : "";
  if (blockReason !== "") {
    const filter = FILTER_REASONS[blockReason];
    return filter === undefined ? LEAD : refusal(filter);
  }
  const candidates = asArray(chunk.candidates);
  if (candidates === null) {
    return null;
  }
  let thinks = false;
  for (const entry of candidates) {
    const candidate = asRecord(entry);
    if (candidate === null) {
      continue;
    }
    const said = geminiParts(asArray(asRecord(candidate.content)?.parts) ?? []);
    if (said === ANSWER) {
      return ANSWER;
    }
    thinks = thinks || said === THINKING;
    const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "";
    if (FILTER_REASONS[finish] !== undefined) {
      return refusal(FILTER_REASONS[finish] as string);
    }
    if (finish !== "") {
      return ANSWER;
    }
  }
  return thinks ? THINKING : LEAD;
}

/** What one server-sent event of a reply is, in any protocol. */
// debt: 与 myna streamEvent 的分支一一对应；拆开会让协议分支更难核对
// eslint-disable-next-line complexity
export function streamEvent(event: string): StreamVerdict {
  let name = "";
  for (const line of event.split("\n")) {
    const body = line.replace(/\r+$/u, "");
    if (body.startsWith("event:")) {
      name = body.slice("event:".length).trim();
    }
  }
  const data = eventData(event);
  if (name === "" && data === "") {
    return LEAD;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return ANSWER;
  }
  const chunk = asRecord(parsed);
  if (chunk === null) {
    return ANSWER;
  }
  const type = typeof chunk.type === "string" && chunk.type !== "" ? chunk.type : name;
  if (type === "error" || type === "response.failed") {
    const response = asRecord(chunk.response);
    const raw = response?.error ?? chunk.error ?? chunk;
    const note = policyRefusal(raw) ?? policyRefusal(chunk);
    return note === null ? ANSWER : refusalError(note);
  }
  if (chunk.error !== undefined && chunk.error !== null) {
    const note = policyRefusal(chunk.error);
    return note === null ? ANSWER : refusalError(note);
  }
  if (type === "content_block_start" && thoughtPart(asRecord(chunk.content_block))) {
    return THINKING;
  }
  if (type === "content_block_delta" && anthropicDeltaThinks(chunk.delta)) {
    return THINKING;
  }
  if (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    thoughtPart(asRecord(chunk.item))
  ) {
    return THINKING;
  }
  if (
    (type === "response.reasoning_summary_part.added" ||
      type === "response.reasoning_summary_part.done") &&
    thoughtPart(asRecord(chunk.part))
  ) {
    return THINKING;
  }
  if (
    type === "response.reasoning_summary_text.delta" ||
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning_summary_text.done" ||
    type === "response.reasoning_text.done"
  ) {
    return THINKING;
  }
  if (type === "content_block_start" && !saidPart(asRecord(chunk.content_block))) {
    return LEAD;
  }
  if (type === "content_block_stop") {
    return LEAD;
  }
  if (type === "content_block_delta" && !anthropicDeltaSays(chunk.delta)) {
    return LEAD;
  }
  if (
    (type === "response.output_item.added" || type === "response.output_item.done") &&
    !saidPart(asRecord(chunk.item))
  ) {
    return LEAD;
  }
  if (
    (type === "response.content_part.added" || type === "response.content_part.done") &&
    !saidPart(asRecord(chunk.part))
  ) {
    return LEAD;
  }
  if (
    (type === "response.output_text.delta" ||
      type === "response.reasoning_summary_text.delta" ||
      type === "response.reasoning_text.delta") &&
    (chunk.delta === "" || chunk.delta === undefined)
  ) {
    return LEAD;
  }
  if (type === "message_delta") {
    const delta = asRecord(chunk.delta);
    const stop = typeof delta?.stop_reason === "string" ? delta.stop_reason : "";
    if (stop === "refusal") {
      return {
        kind: "refusal",
        status: REFUSED_STATUS,
        message: refusedDetail(stop, delta?.stop_details),
      };
    }
  }
  if (type === "response.incomplete") {
    const incomplete = asRecord(asRecord(chunk.response)?.incomplete_details);
    const reason = typeof incomplete?.reason === "string" ? incomplete.reason : "";
    if (FILTER_REASONS[reason] !== undefined) {
      return refusal(FILTER_REASONS[reason] as string);
    }
  }
  if (asArray(chunk.candidates) !== null || chunk.promptFeedback !== undefined) {
    const gemini = geminiVerdict(chunk);
    if (gemini !== null) {
      return gemini;
    }
  }
  if (type === "ping" || type === "message_start" || type === "response.created") {
    return LEAD;
  }
  if (type === "response.in_progress" || type === "response.queued") {
    return LEAD;
  }
  if (type === "response.metadata") {
    return data.includes('"safety_buffering"') ? BUFFERING : LEAD;
  }
  if (type.startsWith("codex.")) {
    return LEAD;
  }
  const choices = asArray(chunk.choices);
  if (type === "" && choices !== null) {
    return chatVerdict(choices);
  }
  return replyEvent(type) ? ANSWER : LEAD;
}

function replyEvent(type: string): boolean {
  switch (type) {
    case "content_block_start":
    case "content_block_delta":
    case "message_delta":
    case "message_stop":
    case "response.completed":
    case "response.incomplete":
    case "response.done":
      return true;
    default:
      return type.startsWith("response.");
  }
}

/** Whether a refusal after this try's reasoning may go to the next. */
export function handsOver(input: {
  streams: boolean;
  last: boolean;
  wantWhole: boolean;
  from: string;
  refusals: number;
  retries: number | undefined;
}): boolean {
  if (!input.streams || input.last || input.wantWhole) {
    return false;
  }
  if (input.from !== "openai" && input.from !== "anthropic" && input.from !== "openai-responses") {
    return false;
  }
  return refusalAsksAgain(input.refusals + 1, input.retries);
}

export interface HandOver {
  status: number;
  message: string;
}

/**
 * Where the next try's stream goes once a try's refusal was handed over:
 * Anthropic's content blocks and Responses' output items and sequence
 * numbers continue where the handed-over try left them.
 */
export class RefusalHandover {
  private readonly protocol: string;
  private readonly open = new Set<number>();
  private blocks = 0;
  private items = 0;
  private sequence = -1;
  public spoke = false;
  public handed = false;
  public handOver: HandOver | null = null;

  public constructor(protocol: string, options: { canHandOver: boolean }) {
    this.protocol = protocol;
    this.canHandOver = options.canHandOver;
  }

  private readonly canHandOver: boolean;

  public get allowed(): boolean {
    return this.canHandOver;
  }

  /** Feeds an event before the answer begins; what to send, or hand over. */
  public feed(event: string): string {
    if (!this.canHandOver || this.handed || this.spoke) {
      return event;
    }
    const verdict = streamEvent(event);
    if (verdict.kind === "refusal" || verdict.kind === "refusal_error") {
      this.handed = true;
      this.handOver = { status: verdict.status, message: verdict.message };
      return this.closeOpen();
    }
    if (verdict.kind === "thinking" || verdict.kind === "lead" || verdict.kind === "buffering") {
      this.track(event);
      return event;
    }
    this.spoke = true;
    return event;
  }

  /** Stops the content blocks still open when the try is handed over. */
  private closeOpen(): string {
    if (this.protocol !== "anthropic") {
      return "";
    }
    let out = "";
    for (const index of [...this.open].sort((a, b) => a - b)) {
      out += `event: content_block_stop\ndata: {"type":"content_block_stop","index":${index}}\n\n`;
    }
    this.open.clear();
    return out;
  }

  /** Notes where an event that went through leaves the stream. */
  private track(event: string): void {
    const data = eventData(event);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const record = asRecord(parsed);
    if (record === null) {
      return;
    }
    if (this.protocol === "anthropic") {
      const index = record.index;
      if (typeof index !== "number") {
        return;
      }
      if (record.type === "content_block_start") {
        this.blocks = Math.max(this.blocks, index + 1);
        this.open.add(index);
      } else if (record.type === "content_block_stop") {
        this.open.delete(index);
      }
      return;
    }
    if (this.protocol === "openai-responses") {
      if (typeof record.output_index === "number") {
        this.items = Math.max(this.items, record.output_index + 1);
      }
      if (typeof record.sequence_number === "number") {
        this.sequence = record.sequence_number;
      }
    }
  }

  /** The next try's event as it goes on in the same reply; null to drop. */
  public splice(event: string): string | null {
    if (this.protocol === "openai") {
      return event;
    }
    const data = eventData(event);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return event;
    }
    const record = asRecord(parsed);
    if (record === null) {
      return event;
    }
    const type = typeof record.type === "string" ? record.type : "";
    if (this.protocol === "anthropic") {
      if (type === "message_start") {
        return null;
      }
      if (typeof record.index === "number") {
        record.index += this.blocks;
      }
    } else {
      if (
        type === "response.created" ||
        type === "response.in_progress" ||
        type === "response.queued"
      ) {
        return null;
      }
      if (typeof record.output_index === "number") {
        record.output_index += this.items;
      }
      if (typeof record.sequence_number === "number") {
        record.sequence_number = this.sequence + 1;
        this.sequence += 1;
      }
    }
    return withData(event, JSON.stringify(record));
  }
}

/** Passes a leading try's frames through, and hands over its refusal. */
export class HandoverFilter implements StreamFilter {
  private buffer = "";
  public readonly handover: RefusalHandover;

  public constructor(handover: RefusalHandover) {
    this.handover = handover;
  }

  public get handedOver(): boolean {
    return this.handover.handed;
  }

  public write(piece: string): string {
    this.buffer += piece;
    let out = "";
    for (;;) {
      if (this.handover.handed) {
        this.buffer = "";
        return out;
      }
      const text = this.buffer;
      if (text.startsWith(":")) {
        const end = text.indexOf("\n");
        if (end < 0) {
          break;
        }
        out += this.handover.feed(text.slice(0, end + 1));
        this.buffer = text.slice(end + 1);
        continue;
      }
      const end = eventEnd(text);
      if (end < 0) {
        break;
      }
      out += this.handover.feed(text.slice(0, end));
      this.buffer = text.slice(end);
    }
    return out;
  }

  public flush(): string {
    if (this.handover.handed) {
      this.buffer = "";
      return "";
    }
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? "" : this.handover.feed(rest);
  }
}

/** A next try's stream, rewritten to go on in the same reply. */
export class SpliceFilter implements StreamFilter {
  private buffer = "";
  private readonly handover: RefusalHandover;

  public constructor(handover: RefusalHandover) {
    this.handover = handover;
  }

  public write(piece: string): string {
    this.buffer += piece;
    let out = "";
    for (;;) {
      const end = eventEnd(this.buffer);
      if (end < 0) {
        break;
      }
      out += this.handover.splice(this.buffer.slice(0, end)) ?? "";
      this.buffer = this.buffer.slice(end);
    }
    return out;
  }

  public flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? "" : (this.handover.splice(rest) ?? "");
  }
}
