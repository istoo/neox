import { createInterface } from "node:readline";
import { createLineStream } from "./compressed.js";
import type { ExternalSessionModel, ExternalSessionTokens, SessionParse } from "./types.js";

export interface SessionPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export type SessionPricer = (model: string) => SessionPrice | null;

interface ModelTally {
  model: string;
  effort: string;
  tokens: ExternalSessionTokens;
}

interface Accumulator {
  title: string;
  cwd: string;
  startMs: number;
  lastMs: number;
  messages: number;
  models: Map<string, ModelTally>;
  seen: Set<string>;
  codexTokens: ExternalSessionTokens | null;
  codexModel: string;
  codexEffort: string;
  codexProvider: string;
  piModel: string;
  piEffort: string;
  agyPrompts: number;
  agyReplies: number;
  agySteps: Map<number, ExternalSessionTokens>;
  agySeen: Set<number>;
}

const MESSAGE_LINE_MAX = 2_000_000;
const SEEN_MAX = 50_000;

export async function readSessionFile(input: {
  agent: string;
  path: string;
  pricer?: SessionPricer;
  meta?: { title?: string; cwd?: string };
}): Promise<SessionParse> {
  const acc = emptyAccumulator();
  if (input.agent === "agy" && input.path.endsWith(".db")) {
    // Listed from its summary row alone: Antigravity's steps are protobuf here.
    return finishAgy(acc, input.pricer, input.meta);
  }
  const stream = createLineStream(input.path);
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.length === 0 || line.length > MESSAGE_LINE_MAX) {
        continue;
      }
      const event = parseObject(line);
      if (event === null) {
        continue;
      }
      if (input.agent === "claude") {
        readClaudeLine(acc, event);
      } else if (input.agent === "codex") {
        readCodexLine(acc, event);
      } else if (input.agent === "pi") {
        readPiLine(acc, event);
      } else if (input.agent === "agy") {
        readAgyLine(acc, event);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (input.agent === "agy") {
    return finishAgy(acc, input.pricer, input.meta);
  }
  return finish(acc, input.pricer);
}

function emptyAccumulator(): Accumulator {
  return {
    title: "",
    cwd: "",
    startMs: Number.NaN,
    lastMs: Number.NaN,
    messages: 0,
    models: new Map(),
    seen: new Set(),
    codexTokens: null,
    codexModel: "",
    codexEffort: "",
    codexProvider: "",
    piModel: "",
    piEffort: "",
    agyPrompts: 0,
    agyReplies: 0,
    agySteps: new Map(),
    agySeen: new Set(),
  };
}

function readClaudeLine(acc: Accumulator, event: Record<string, unknown>): void {
  recordTime(acc, event.timestamp);
  if (typeof event.cwd === "string" && event.cwd.length > 0) {
    acc.cwd = event.cwd;
  }
  if (event.type === "summary" && typeof event.summary === "string" && acc.title.length === 0) {
    acc.title = cleanTitle(event.summary);
    return;
  }
  if (event.isSidechain === true || event.isMeta === true) {
    return;
  }
  const message = asRecord(event.message);
  if (message === null) {
    return;
  }
  if (event.type === "user") {
    readClaudeUser(acc, message);
    return;
  }
  if (event.type === "assistant") {
    readClaudeAssistant(acc, message);
  }
}

function readClaudeUser(acc: Accumulator, message: Record<string, unknown>): void {
  const text = claudeText(message.content);
  if (text.length === 0 || isInjectedContext(text)) {
    return;
  }
  acc.messages += 1;
  if (acc.title.length === 0) {
    acc.title = cleanTitle(text);
  }
}

function readClaudeAssistant(acc: Accumulator, message: Record<string, unknown>): void {
  const id = typeof message.id === "string" ? message.id : "";
  if (id.length > 0 && acc.seen.has(id)) {
    return;
  }
  if (id.length > 0 && acc.seen.size < SEEN_MAX) {
    acc.seen.add(id);
  }
  acc.messages += 1;
  const model = typeof message.model === "string" ? message.model : "";
  const usage = asRecord(message.usage);
  if (usage === null || model.length === 0) {
    return;
  }
  addModelTokens(acc, model, "", {
    input: toNumber(usage.input_tokens),
    output: toNumber(usage.output_tokens),
    cacheRead: toNumber(usage.cache_read_input_tokens),
    cacheWrite: toNumber(usage.cache_creation_input_tokens),
  });
}

function readCodexLine(acc: Accumulator, event: Record<string, unknown>): void {
  recordTime(acc, event.timestamp);
  const payload = asRecord(event.payload);
  if (payload === null) {
    return;
  }
  if (event.type === "session_meta") {
    if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
      acc.cwd = payload.cwd;
    }
    if (acc.codexProvider.length === 0) {
      // Codex's own default when a rollout names none.
      acc.codexProvider =
        typeof payload.model_provider === "string" && payload.model_provider.length > 0
          ? payload.model_provider
          : "openai";
    }
    recordTime(acc, payload.timestamp);
    return;
  }
  if (event.type === "turn_context") {
    if (typeof payload.cwd === "string" && payload.cwd.length > 0) {
      acc.cwd = payload.cwd;
    }
    if (typeof payload.model === "string") {
      acc.codexModel = payload.model;
    }
    const effort = payload.effort ?? payload.reasoning_effort;
    if (typeof effort === "string") {
      acc.codexEffort = effort;
    }
    return;
  }
  if (event.type === "response_item" && payload.type === "message") {
    readCodexMessage(acc, payload);
    return;
  }
  if (event.type === "event_msg" && payload.type === "token_count") {
    readCodexTokens(acc, asRecord(payload.info));
  }
}

function readCodexMessage(acc: Accumulator, payload: Record<string, unknown>): void {
  const role = payload.role;
  if (role !== "user" && role !== "assistant") {
    return;
  }
  const text = partsText(payload.content, ["input_text", "output_text", "text"]);
  if (text.length === 0 || isInjectedContext(text)) {
    return;
  }
  acc.messages += 1;
  if (role === "user" && acc.title.length === 0) {
    acc.title = cleanTitle(text);
  }
}

function readCodexTokens(acc: Accumulator, info: Record<string, unknown> | null): void {
  if (info === null) {
    return;
  }
  const total = asRecord(info.total_token_usage);
  if (total === null) {
    return;
  }
  const input = toNumber(total.input_tokens);
  const cached = toNumber(total.cached_input_tokens);
  acc.codexTokens = {
    input: Math.max(0, input - cached),
    output: toNumber(total.output_tokens),
    cacheRead: cached,
    cacheWrite: 0,
  };
}

function readPiLine(acc: Accumulator, event: Record<string, unknown>): void {
  recordTime(acc, event.timestamp);
  if (event.type === "session") {
    if (typeof event.cwd === "string" && event.cwd.length > 0) {
      acc.cwd = event.cwd;
    }
    return;
  }
  if (event.type === "model_change") {
    if (typeof event.modelId === "string") {
      acc.piModel = event.modelId;
    }
    return;
  }
  if (event.type === "thinking_level_change") {
    if (typeof event.thinkingLevel === "string") {
      acc.piEffort = event.thinkingLevel;
    }
    return;
  }
  if (event.type !== "message") {
    return;
  }
  const message = asRecord(event.message);
  if (message === null) {
    return;
  }
  const role = message.role;
  if (role !== "user" && role !== "assistant") {
    return;
  }
  const text = partsText(message.content, ["text"]);
  if (text.length > 0 && !isInjectedContext(text)) {
    acc.messages += 1;
    if (role === "user" && acc.title.length === 0) {
      acc.title = cleanTitle(text);
    }
  }
  if (role !== "assistant") {
    return;
  }
  const model = typeof message.model === "string" ? message.model : acc.piModel;
  const usage = asRecord(message.usage);
  if (usage === null || model.length === 0) {
    return;
  }
  addModelTokens(acc, model, acc.piEffort, {
    input: toNumber(usage.input),
    output: toNumber(usage.output),
    cacheRead: toNumber(usage.cacheRead),
    cacheWrite: toNumber(usage.cacheWrite),
  });
}

const AGY_MODEL = "agy";

/** What Antigravity's steps come to, with its summary row filling title and folder. */
function finishAgy(
  acc: Accumulator,
  pricer: SessionPricer | undefined,
  meta: { title?: string; cwd?: string } | undefined,
): SessionParse {
  for (const tokens of acc.agySteps.values()) {
    addModelTokens(acc, AGY_MODEL, "", tokens);
  }
  acc.messages = acc.agyPrompts + acc.agyReplies;
  if (meta?.title !== undefined && meta.title.length > 0) {
    acc.title = cleanTitle(meta.title);
  }
  if (meta?.cwd !== undefined && meta.cwd.length > 0) {
    acc.cwd = meta.cwd;
  }
  return finish(acc, pricer);
}

function readAgyLine(acc: Accumulator, event: Record<string, unknown>): void {
  const step = typeof event.step_index === "number" ? event.step_index : null;
  if (step === null) {
    return;
  }
  recordTime(acc, event.created_at);
  const source = typeof event.source === "string" ? event.source : "";
  const type = typeof event.type === "string" ? event.type : "";
  if (source === "MODEL" && type === "PLANNER_RESPONSE") {
    if (typeof event.input_tokens === "number" && typeof event.output_tokens === "number") {
      acc.agySteps.set(step, {
        input: event.input_tokens,
        output: event.output_tokens,
        cacheRead: toNumber(event.cache_read_tokens),
        cacheWrite: 0,
      });
    }
  }
  if (acc.agySeen.has(step)) {
    return;
  }
  acc.agySeen.add(step);
  if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
    acc.agyPrompts += 1;
    if (acc.title.length === 0) {
      acc.title = cleanTitle(agyRequest(typeof event.content === "string" ? event.content : ""));
    }
    return;
  }
  if (source !== "MODEL" || type !== "PLANNER_RESPONSE") {
    return;
  }
  const toolCalls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
  const content = typeof event.content === "string" ? event.content : "";
  if (toolCalls.length === 0 && content.length > 0) {
    acc.agyReplies += 1;
  }
}

/** What the user typed, out of the <USER_REQUEST> Antigravity wraps it in. */
export function agyRequest(content: string): string {
  const open = content.indexOf("<USER_REQUEST>");
  if (open < 0) {
    return content.trim();
  }
  const rest = content.slice(open + "<USER_REQUEST>".length);
  const close = rest.indexOf("</USER_REQUEST>");
  return (close < 0 ? rest : rest.slice(0, close)).trim();
}

function finish(acc: Accumulator, pricer?: SessionPricer): SessionParse {
  if (acc.codexTokens !== null && acc.codexModel.length > 0) {
    addModelTokens(acc, acc.codexModel, acc.codexEffort, acc.codexTokens);
  }
  const models: ExternalSessionModel[] = [];
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let priced = false;
  for (const tally of acc.models.values()) {
    const price = pricer?.(tally.model) ?? null;
    const modelCost =
      price === null
        ? 0
        : (tally.tokens.input / 1_000_000) * price.inputPerMTok +
          (tally.tokens.output / 1_000_000) * price.outputPerMTok;
    if (price !== null) {
      priced = true;
    }
    cost += modelCost;
    total.input += tally.tokens.input;
    total.output += tally.tokens.output;
    total.cacheRead += tally.tokens.cacheRead;
    total.cacheWrite += tally.tokens.cacheWrite;
    models.push({
      model: tally.model,
      ...(tally.effort.length > 0 ? { effort: tally.effort } : {}),
      tokens: tally.tokens,
      cost: modelCost,
      priced: price !== null,
    });
  }
  models.sort((a, b) => modelTokenCount(b.tokens) - modelTokenCount(a.tokens));
  return {
    title: acc.title,
    cwd: acc.cwd,
    start: toIso(acc.startMs),
    last: toIso(acc.lastMs),
    messages: acc.messages,
    tokens: total,
    models,
    cost,
    priced,
    provider: acc.codexProvider,
  };
}

function addModelTokens(
  acc: Accumulator,
  model: string,
  effort: string,
  tokens: ExternalSessionTokens,
): void {
  const key = `${model}\u0000${effort}`;
  const tally = acc.models.get(key) ?? {
    model,
    effort,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  tally.tokens.input += tokens.input;
  tally.tokens.output += tokens.output;
  tally.tokens.cacheRead += tokens.cacheRead;
  tally.tokens.cacheWrite += tokens.cacheWrite;
  acc.models.set(key, tally);
}

function recordTime(acc: Accumulator, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) {
    return;
  }
  acc.startMs = Number.isNaN(acc.startMs) ? at : Math.min(acc.startMs, at);
  acc.lastMs = Number.isNaN(acc.lastMs) ? at : Math.max(acc.lastMs, at);
}

function toIso(at: number): string {
  return Number.isNaN(at) ? "" : new Date(at).toISOString();
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelTokenCount(tokens: ExternalSessionTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

function parseObject(line: string): Record<string, unknown> | null {
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

function claudeText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return partsText(content, ["text"]);
}

function partsText(content: unknown, kinds: readonly string[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const out: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record === null) {
      continue;
    }
    if (typeof record.type === "string" && !kinds.includes(record.type)) {
      continue;
    }
    if (typeof record.text === "string") {
      out.push(record.text);
    }
  }
  return out.join("\n");
}

/**
 * Text the harness adds (environment notes, command output wrappers, system
 * reminders) is not what the reader asked; it never becomes the title.
 */
function isInjectedContext(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith("<environment_context>") ||
    head.startsWith("<local-command-caveat>") ||
    head.startsWith("<local-command-stdout>") ||
    head.startsWith("<user_info>") ||
    head.startsWith("<system-reminder>")
  );
}

export function cleanTitle(text: string): string {
  const cleaned = text
    .replace(/<[^>\n]{0,120}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length > 160 ? `${cleaned.slice(0, 159).trimEnd()}…` : cleaned;
}
