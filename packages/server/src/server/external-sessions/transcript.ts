import { createInterface } from "node:readline";
import { createLineStream } from "./compressed.js";
import { agyRequest } from "./read-session.js";

export interface TranscriptPart {
  role: string;
  kind: string;
  name?: string;
  text: string;
  model?: string;
  cut?: number;
}

export interface Transcript {
  parts: TranscriptPart[];
  cut: boolean;
  source: string;
}

const PART_MAX = 8_000;
const TRANSCRIPT_MAX = 400_000;
const LINE_MAX = 2_000_000;

/** Reads a session's conversation from its own file, in the agent's order. */
export async function readTranscript(input: { agent: string; path: string }): Promise<Transcript> {
  const collector = new PartCollector("file");
  if (input.agent === "claude") {
    await readClaude(input.path, collector);
  } else if (input.agent === "codex") {
    await readCodex(input.path, collector);
  } else if (input.agent === "pi") {
    await readPi(input.path, collector);
  } else if (input.agent === "agy") {
    await readAgy(input.path, collector);
  }
  return collector.finish();
}

export class PartCollector {
  readonly parts: TranscriptPart[] = [];
  private chars = 0;
  cut = false;

  constructor(readonly source: string) {}

  add(part: TranscriptPart): void {
    if (this.chars >= TRANSCRIPT_MAX) {
      this.cut = true;
      return;
    }
    const text = part.text.trim();
    if (text.length === 0) {
      return;
    }
    const keep = Math.min(text.length, PART_MAX, TRANSCRIPT_MAX - this.chars);
    const cut = text.length - keep;
    this.chars += keep;
    if (cut > 0) {
      this.cut = true;
    }
    this.parts.push({
      role: part.role,
      kind: part.kind,
      text: text.slice(0, keep),
      ...(part.name === undefined ? {} : { name: part.name }),
      ...(part.model === undefined ? {} : { model: part.model }),
      ...(cut > 0 ? { cut } : {}),
    });
  }

  finish(): Transcript {
    return { parts: this.parts, cut: this.cut, source: this.source };
  }
}

async function forEachLine(
  file: string,
  each: (event: Record<string, unknown>) => void,
): Promise<void> {
  const stream = createLineStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.length === 0 || line.length > LINE_MAX || !line.startsWith("{")) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = asRecord(parsed);
      if (event !== null) {
        each(event);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function readClaude(file: string, out: PartCollector): Promise<void> {
  await forEachLine(file, (event) => {
    if (event.isSidechain === true || event.isMeta === true) {
      return;
    }
    const message = asRecord(event.message);
    if (message === null) {
      return;
    }
    if (event.type === "user") {
      for (const part of claudeContentParts(message.content, "user", undefined)) {
        out.add(part);
      }
      return;
    }
    if (event.type !== "assistant") {
      return;
    }
    const model = typeof message.model === "string" ? message.model : undefined;
    for (const part of claudeContentParts(message.content, "assistant", model)) {
      out.add(part);
    }
  });
}

function claudeContentParts(
  content: unknown,
  role: string,
  model: string | undefined,
): TranscriptPart[] {
  if (typeof content === "string") {
    return [textPart(role, content, model)];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const out: TranscriptPart[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block === null) {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      out.push(textPart(role, block.text, model));
    } else if (type === "thinking" && typeof block.thinking === "string") {
      out.push(withModel({ role, kind: "thinking", text: block.thinking }, model));
    } else if (type === "tool_use" && typeof block.name === "string") {
      out.push(
        withModel(
          { role, kind: "tool_use", name: block.name, text: prettyJson(block.input) },
          model,
        ),
      );
    } else if (type === "tool_result") {
      out.push({
        role: "tool",
        kind: "tool_result",
        text: resultText(block.content),
        ...(typeof block.tool_use_id === "string" ? { name: block.tool_use_id } : {}),
      });
    } else if (type === "image") {
      out.push({ role, kind: "image", text: "[image]" });
    }
  }
  return out;
}

async function readCodex(file: string, out: PartCollector): Promise<void> {
  let model: string | undefined;
  await forEachLine(file, (event) => {
    const payload = asRecord(event.payload);
    if (payload === null) {
      return;
    }
    if (event.type === "turn_context") {
      model = typeof payload.model === "string" ? payload.model : model;
      return;
    }
    if (event.type !== "response_item") {
      return;
    }
    const type = typeof payload.type === "string" ? payload.type : "";
    if (type === "message") {
      if (payload.role !== "user" && payload.role !== "assistant") {
        return;
      }
      const role = payload.role;
      out.add(
        textPart(
          role,
          contentText(payload.content, ["input_text", "output_text", "text"]),
          role === "assistant" ? model : undefined,
        ),
      );
      return;
    }
    if (type === "reasoning") {
      out.add({
        role: "assistant",
        kind: "thinking",
        text: summaryText(payload.summary),
        ...(model === undefined ? {} : { model }),
      });
      return;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args = typeof payload.arguments === "string" ? payload.arguments : payload.input;
      out.add({
        role: "assistant",
        kind: "tool_use",
        name,
        text: prettyJson(args),
        ...(model === undefined ? {} : { model }),
      });
      return;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      out.add({ role: "tool", kind: "tool_result", text: resultText(payload.output) });
    }
  });
}

interface AgyStep {
  event: Record<string, unknown>;
  order: number;
}

/** Antigravity's steps: one line each, a step written again read last where first. */
async function readAgy(file: string, out: PartCollector): Promise<void> {
  const steps = new Map<number, AgyStep>();
  await forEachLine(file, (event) => {
    if (typeof event.step_index !== "number") {
      return;
    }
    const source = typeof event.source === "string" ? event.source : "";
    const type = typeof event.type === "string" ? event.type : "";
    if (source !== "MODEL" && !(source === "USER_EXPLICIT" && type === "USER_INPUT")) {
      return;
    }
    const existing = steps.get(event.step_index);
    if (existing === undefined) {
      steps.set(event.step_index, { event, order: steps.size });
    } else {
      existing.event = event;
    }
  });
  const ordered = [...steps.values()].sort((a, b) => a.order - b.order);
  for (const step of ordered) {
    for (const part of agyParts(step.event)) {
      out.add(part);
    }
  }
}

function agyParts(event: Record<string, unknown>): TranscriptPart[] {
  const source = typeof event.source === "string" ? event.source : "";
  const type = typeof event.type === "string" ? event.type : "";
  const content = typeof event.content === "string" ? event.content : "";
  const out: TranscriptPart[] = [];
  if (source === "USER_EXPLICIT" && type === "USER_INPUT") {
    const asked = agyRequest(content);
    if (asked.length > 0) {
      out.push(textPart("user", asked));
    }
    return out;
  }
  if (type === "PLANNER_RESPONSE") {
    const thinking = typeof event.thinking === "string" ? event.thinking : "";
    if (thinking.length > 0) {
      out.push({ role: "assistant", kind: "thinking", text: thinking });
    }
    if (content.length > 0) {
      out.push(textPart("assistant", content));
    }
    const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    for (const value of calls) {
      const call = asRecord(value);
      if (call === null || typeof call.name !== "string") {
        continue;
      }
      out.push({
        role: "assistant",
        kind: "tool_use",
        name: call.name,
        text: prettyJson(call.args),
      });
    }
    return out;
  }
  // A tool's result, after the times Antigravity heads it with.
  let text = content;
  for (const header of ["Created At:", "Completed At:"]) {
    if (text.startsWith(header)) {
      const newline = text.indexOf("\n");
      text = newline < 0 ? "" : text.slice(newline + 1);
    }
  }
  if (text.trim().length > 0) {
    out.push({ role: "tool", kind: "tool_result", text });
  }
  return out;
}

interface PiEntry {
  id: string;
  type: string;
  parentId: string;
  message: Record<string, unknown> | null;
}

async function readPi(file: string, out: PartCollector): Promise<void> {
  const byId = new Map<string, PiEntry>();
  let last = "";
  await forEachLine(file, (event) => {
    const id = typeof event.id === "string" ? event.id : "";
    const type = typeof event.type === "string" ? event.type : "";
    if (id.length === 0 || type === "session" || type === "title") {
      return;
    }
    const entry: PiEntry = {
      id,
      type,
      parentId: typeof event.parentId === "string" ? event.parentId : "",
      message: asRecord(event.message),
    };
    byId.set(id, entry);
    last = id;
  });
  const branch: PiEntry[] = [];
  for (let id = last, step = 0; id.length > 0 && step <= byId.size; step += 1) {
    const entry = byId.get(id);
    if (entry === undefined) {
      break;
    }
    branch.push(entry);
    id = entry.parentId;
  }
  for (const entry of branch.toReversed()) {
    const message = entry.message;
    if (message === null) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "toolResult") {
      out.add({
        role: "tool",
        kind: "tool_result",
        text: resultText(message.content),
        ...(typeof message.toolName === "string" ? { name: message.toolName } : {}),
      });
      continue;
    }
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const model = stringOf(message.model);
    if (typeof message.content === "string") {
      out.add(textPart(role, message.content, model));
      continue;
    }
    for (const part of piContentParts(message.content, role, model)) {
      out.add(part);
    }
  }
}

function piContentParts(
  content: unknown,
  role: string,
  model: string | undefined,
): TranscriptPart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const out: TranscriptPart[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block === null) {
      continue;
    }
    const type = typeof block.type === "string" ? block.type : "";
    if (type === "text" && typeof block.text === "string") {
      out.push(textPart(role, block.text, model));
    } else if (type === "thinking" && typeof block.thinking === "string") {
      out.push(withModel({ role, kind: "thinking", text: block.thinking }, model));
    } else if (type === "toolCall" && typeof block.name === "string") {
      out.push(
        withModel(
          { role, kind: "tool_use", name: block.name, text: prettyJson(block.arguments) },
          model,
        ),
      );
    } else if (type === "image") {
      out.push({ role, kind: "image", text: "[image]" });
    }
  }
  return out;
}

function textPart(role: string, text: string, model?: string): TranscriptPart {
  const trimmed = text.trimStart();
  const kind = trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md") ? "context" : "text";
  return withModel({ role, kind, text }, model);
}

function withModel(part: TranscriptPart, model: string | undefined): TranscriptPart {
  return model === undefined ? part : { ...part, model };
}

function contentText(content: unknown, kinds: readonly string[]): string {
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
    } else if (type === "thinking" && typeof block.thinking === "string") {
      out.push(block.thinking);
    } else if (type === "toolCall" && typeof block.name === "string") {
      out.push(prettyJson(block.arguments));
    }
  }
  return out.join("\n");
}

function summaryText(summary: unknown): string {
  if (!Array.isArray(summary)) {
    return "";
  }
  return summary
    .map((value) => {
      const item = asRecord(value);
      return item !== null && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function resultText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  if (Array.isArray(output)) {
    return contentText(output, ["text", "input_text", "output_text"]);
  }
  if (isRecord(output)) {
    if (typeof output.text === "string") {
      return output.text;
    }
    if (typeof output.content === "string") {
      return output.content;
    }
    if (typeof output.output === "string") {
      return output.output;
    }
  }
  return output === undefined || output === null ? "" : prettyJson(output);
}

function prettyJson(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return indentJson(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A JSON string's text, indented as myna shows a tool's arguments. */
function indentJson(text: string): string {
  if (text.length > 4_000 || (!text.startsWith("{") && !text.startsWith("["))) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
