import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { createLineStream } from "./compressed.js";
import type { ExternalSessionTokens } from "./types.js";

/**
 * One recorded step of an agent's conversation, as myna's sessions.TraceSpan:
 * a turn's root, a model response, or a tool call. Timestamps come from the
 * transcript's own lines. A model response's request start is never recorded,
 * so it starts at the previous event and says so.
 */
export interface SessionTraceSpan {
  id: string;
  parentId?: string;
  traceId: string;
  name: string;
  kind: "span" | "generation" | "tool";
  startMs: number;
  endMs: number;
  model?: string;
  tokens?: ExternalSessionTokens;
  input?: string;
  output?: string;
  error?: boolean;
  inferred?: boolean;
}

/** Formats whose transcripts carry per-line timestamps and tool calls. */
export const TRACE_AGENTS = new Set(["claude", "codex", "pi"]);

const LINE_MAX = 2_000_000;
const NO_TOKENS: ExternalSessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function hashOf(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

interface Turn {
  id: string;
  start: number;
  last: number;
  failed: boolean;
  input: string[];
  output: string[];
  spans: SessionTraceSpan[];
  generations: Map<string, SessionTraceSpan>;
  tools: Map<string, SessionTraceSpan>;
}

/** Collects a transcript's turns in order, closing each at the next prompt. */
class TraceTurns {
  readonly spans: SessionTraceSpan[] = [];
  private current: Turn | null = null;
  private index = 0;
  /** The last cumulative Codex usage read, whose delta a turn's response used. */
  private codexTotals: ExternalSessionTokens | null = null;

  constructor(
    private readonly agent: string,
    private readonly session: string,
    private readonly bodies: boolean,
  ) {}

  spanId(turn: Turn, id: string): string {
    return hashOf([this.agent, this.session, turn.id, id]).slice(0, 16);
  }

  traceId(turn: Turn): string {
    return hashOf([this.agent, this.session, turn.id]).slice(0, 32);
  }

  currentTurn(): Turn | null {
    return this.current;
  }

  begin(at: number): Turn {
    this.finish(at);
    const turn = this.create(at);
    return turn;
  }

  ensure(at: number): Turn {
    return this.current ?? this.create(at);
  }

  note(at: number): Turn {
    const turn = this.ensure(at);
    turn.last = Math.max(turn.last, at);
    return turn;
  }

  addGeneration(
    turn: Turn,
    key: string,
    at: number,
    model?: string,
    startMs?: number,
  ): SessionTraceSpan {
    const existing = turn.generations.get(key);
    if (existing !== undefined) {
      existing.endMs = Math.max(existing.endMs, at);
      turn.last = Math.max(turn.last, at);
      return existing;
    }
    const span: SessionTraceSpan = {
      id: this.spanId(turn, key),
      traceId: this.traceId(turn),
      parentId: this.spanId(turn, "root"),
      name: model === undefined ? "model response" : `model ${model}`,
      kind: "generation",
      startMs: startMs ?? turn.last,
      endMs: at,
      ...(model === undefined ? {} : { model }),
      inferred: true,
    };
    turn.generations.set(key, span);
    turn.spans.push(span);
    turn.last = Math.max(turn.last, at);
    return span;
  }

  addTool(turn: Turn, id: string, name: string, at: number, input?: unknown): SessionTraceSpan {
    const span: SessionTraceSpan = {
      id: this.spanId(turn, `tool-${id}`),
      traceId: this.traceId(turn),
      parentId: this.spanId(turn, "root"),
      name,
      kind: "tool",
      startMs: at,
      endMs: at,
    };
    if (input !== undefined) {
      span.input = jsonText(input);
    }
    turn.tools.set(id, span);
    turn.spans.push(span);
    turn.last = Math.max(turn.last, at);
    return span;
  }

  closeTool(id: string, at: number, error: boolean, output?: string): void {
    const turn = this.current;
    const tool = turn?.tools.get(id);
    if (turn === null || tool === undefined) {
      return;
    }
    tool.endMs = Math.max(tool.startMs, at);
    tool.error = error;
    if (output !== undefined && this.bodies) {
      tool.output = output;
    }
    turn.last = Math.max(turn.last, at);
    if (error) {
      turn.failed = true;
    }
  }

  bodyIn(text: string): void {
    if (this.bodies && this.current !== null) {
      this.current.input.push(text);
    }
  }

  bodyOut(text: string): void {
    if (this.bodies && this.current !== null && text.length > 0) {
      this.current.output.push(text);
    }
  }

  /** Codex reports cumulative totals; the turn's response gets the delta. */
  codexUsage(total: ExternalSessionTokens): ExternalSessionTokens {
    const previous = this.codexTotals ?? NO_TOKENS;
    this.codexTotals = total;
    return {
      input: Math.max(0, total.input - previous.input),
      output: Math.max(0, total.output - previous.output),
      cacheRead: Math.max(0, total.cacheRead - previous.cacheRead),
      cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite),
    };
  }

  finish(at: number): void {
    const turn = this.current;
    if (turn === null) {
      return;
    }
    this.current = null;
    const end = Math.max(turn.start, at, turn.last);
    const root: SessionTraceSpan = {
      id: this.spanId(turn, "root"),
      traceId: this.traceId(turn),
      name: `${this.agent} interaction`,
      kind: "span",
      startMs: turn.start,
      endMs: end,
      tokens: totalTokens(turn),
      error: turn.failed,
    };
    if (this.bodies) {
      if (turn.input.length > 0) {
        root.input = turn.input.join("\n\n");
      }
      if (turn.output.length > 0) {
        root.output = turn.output.join("\n\n");
      }
    }
    this.spans.push(root, ...turn.spans);
  }

  /** Ends the open turn at its own last line. */
  close(): void {
    if (this.current !== null) {
      this.finish(this.current.last);
    }
  }

  private create(at: number): Turn {
    const turn: Turn = {
      id: `turn-${this.index}`,
      start: at,
      last: at,
      failed: false,
      input: [],
      output: [],
      spans: [],
      generations: new Map(),
      tools: new Map(),
    };
    this.index += 1;
    this.current = turn;
    return turn;
  }
}

function totalTokens(turn: Turn): ExternalSessionTokens {
  const total = { ...NO_TOKENS };
  for (const span of turn.spans) {
    if (span.kind !== "generation" || span.tokens === undefined) {
      continue;
    }
    total.input += span.tokens.input;
    total.output += span.tokens.output;
    total.cacheRead += span.tokens.cacheRead;
    total.cacheWrite += span.tokens.cacheWrite;
  }
  return total;
}

/**
 * A session's turns and their steps, read from its own transcript. Agents
 * whose store keeps no per-line time (OpenCode's database, Antigravity's
 * steps) return an empty list and the caller falls back to a session span.
 */
export async function readSessionTraceSpans(input: {
  agent: string;
  session: string;
  path: string;
  bodies?: boolean;
}): Promise<SessionTraceSpan[]> {
  if (!TRACE_AGENTS.has(input.agent)) {
    return [];
  }
  const turns = new TraceTurns(input.agent, input.session, input.bodies === true);
  const stream = createLineStream(input.path);
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.length === 0 || line.length > LINE_MAX) {
        continue;
      }
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          continue;
        }
        event = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (input.agent === "claude") {
        readClaudeLine(turns, event);
      } else if (input.agent === "codex") {
        readCodexLine(turns, event);
      } else {
        readPiLine(turns, event);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  turns.close();
  return turns.spans;
}

function timeOf(value: unknown): number {
  if (typeof value !== "string") {
    return Number.NaN;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOfContent(content: unknown, kinds: readonly string[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const out: string[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block === null) {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : "";
    if (type.length > 0 && !kinds.includes(type)) {
      continue;
    }
    if (typeof block.text === "string") {
      out.push(block.text);
    } else if (typeof block.thinking === "string") {
      out.push(block.thinking);
    }
  }
  return out.join("\n");
}

function jsonText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function numberOr(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isInjected(text: string): boolean {
  return text.trimStart().startsWith("<");
}

function readClaudeLine(turns: TraceTurns, event: Record<string, unknown>): void {
  const at = timeOf(event.timestamp);
  if (!Number.isFinite(at)) {
    return;
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (type === "system" && event.subtype === "turn_duration") {
    turns.note(at);
    turns.finish(at);
    return;
  }
  if (event.isMeta === true) {
    return;
  }
  const message = asRecord(event.message);
  if (message === null) {
    return;
  }
  if (type === "user") {
    readClaudeUser(turns, message, at);
    return;
  }
  if (type === "assistant") {
    readClaudeAssistant(turns, message, at);
  }
}

function readClaudeUser(turns: TraceTurns, message: Record<string, unknown>, at: number): void {
  const content = message.content;
  let result = false;
  if (Array.isArray(content)) {
    for (const value of content) {
      const block = asRecord(value);
      if (block === null || block.type !== "tool_result") {
        continue;
      }
      result = true;
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      turns.closeTool(id, at, block.is_error === true, textOfContent(block.content, ["text"]));
      turns.note(at);
    }
  }
  if (result) {
    return;
  }
  const text = textOfContent(content, ["text"]);
  if (text.length === 0 || isInjected(text)) {
    return;
  }
  turns.begin(at);
  turns.bodyIn(text);
}

function readClaudeAssistant(
  turns: TraceTurns,
  message: Record<string, unknown>,
  at: number,
): void {
  const id = typeof message.id === "string" ? message.id : "";
  const model = typeof message.model === "string" ? message.model : "";
  if (id.length === 0 || model.length === 0 || model === "<synthetic>") {
    return;
  }
  const turn = turns.ensure(at);
  const span = turns.addGeneration(turn, `message-${id}`, at, model, turn.last);
  const usage = asRecord(message.usage);
  if (usage !== null) {
    span.tokens = {
      input: numberOr(usage.input_tokens),
      output: numberOr(usage.output_tokens),
      cacheRead: numberOr(usage.cache_read_input_tokens),
      cacheWrite: numberOr(usage.cache_creation_input_tokens),
    };
  }
  turns.bodyOut(textOfContent(message.content, ["text"]));
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const value of content) {
    const block = asRecord(value);
    if (block === null || block.type !== "tool_use" || typeof block.id !== "string") {
      continue;
    }
    if (turn.tools.has(block.id)) {
      continue;
    }
    turns.addTool(
      turn,
      block.id,
      typeof block.name === "string" ? block.name : "tool",
      at,
      block.input,
    );
  }
}

function readCodexLine(turns: TraceTurns, event: Record<string, unknown>): void {
  const at = timeOf(event.timestamp);
  if (!Number.isFinite(at)) {
    return;
  }
  const type = typeof event.type === "string" ? event.type : "";
  const payload = asRecord(event.payload);
  if (payload === null) {
    return;
  }
  if (type === "response_item") {
    readCodexItem(turns, payload, at);
    return;
  }
  if (type === "event_msg" && payload.type === "token_count") {
    readCodexTokens(turns, asRecord(payload.info), at);
  }
}

function readCodexItem(turns: TraceTurns, payload: Record<string, unknown>, at: number): void {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message" && payload.role === "user") {
    const text = textOfContent(payload.content, ["input_text", "text"]);
    if (text.length === 0 || isInjected(text)) {
      return;
    }
    turns.begin(at);
    turns.bodyIn(text);
    return;
  }
  if (type === "message" && payload.role === "assistant") {
    const turn = turns.ensure(at);
    turns.addGeneration(turn, `message-${at}`, at, undefined, turn.last);
    turns.bodyOut(textOfContent(payload.content, ["output_text", "text"]));
    return;
  }
  if (type === "function_call" || type === "custom_tool_call") {
    const turn = turns.note(at);
    const callId = typeof payload.call_id === "string" ? payload.call_id : `call-${at}`;
    turns.addTool(
      turn,
      callId,
      typeof payload.name === "string" ? payload.name : "tool",
      at,
      payload.arguments,
    );
    return;
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : "";
    turns.closeTool(callId, at, false, textOfContent(payload.output, ["text"]));
    turns.note(at);
  }
}

function readCodexTokens(
  turns: TraceTurns,
  info: Record<string, unknown> | null,
  at: number,
): void {
  if (info === null) {
    return;
  }
  const total = asRecord(info.total_token_usage);
  if (total === null) {
    return;
  }
  const turn = turns.note(at);
  const usage = turns.codexUsage({
    input: Math.max(0, numberOr(total.input_tokens) - numberOr(total.cached_input_tokens)),
    output: numberOr(total.output_tokens),
    cacheRead: numberOr(total.cached_input_tokens),
    cacheWrite: 0,
  });
  const spans = turn.spans.filter((span) => span.kind === "generation");
  const last = spans[spans.length - 1];
  if (last === undefined) {
    const span = turns.addGeneration(turn, `usage-${at}`, at);
    span.tokens = usage;
    return;
  }
  last.tokens = usage;
  last.endMs = Math.max(last.endMs, at);
}

function readPiLine(turns: TraceTurns, event: Record<string, unknown>): void {
  const at = timeOf(event.timestamp);
  if (!Number.isFinite(at) || event.type !== "message") {
    return;
  }
  const message = asRecord(event.message);
  if (message === null) {
    return;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role === "user") {
    const text = textOfContent(message.content, ["text"]);
    if (text.length === 0 || isInjected(text)) {
      return;
    }
    turns.begin(at);
    turns.bodyIn(text);
    return;
  }
  if (role === "toolResult") {
    const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
    turns.closeTool(id, at, message.isError === true, textOfContent(message.content, ["text"]));
    turns.note(at);
    return;
  }
  if (role !== "assistant") {
    return;
  }
  const turn = turns.ensure(at);
  const model = typeof message.model === "string" ? message.model : undefined;
  const span = turns.addGeneration(turn, `message-${at}`, at, model, turn.last);
  const usage = asRecord(message.usage);
  if (usage !== null) {
    span.tokens = {
      input: numberOr(usage.input),
      output: numberOr(usage.output),
      cacheRead: numberOr(usage.cacheRead),
      cacheWrite: numberOr(usage.cacheWrite),
    };
  }
  turns.bodyOut(textOfContent(message.content, ["text"]));
  const content = message.content;
  if (!Array.isArray(content)) {
    return;
  }
  for (const value of content) {
    const block = asRecord(value);
    if (block === null || block.type !== "toolCall" || typeof block.id !== "string") {
      continue;
    }
    turns.addTool(
      turn,
      block.id,
      typeof block.name === "string" ? block.name : "tool",
      at,
      block.arguments,
    );
  }
}
