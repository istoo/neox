import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Response } from "express";
import { withoutBillingHeader } from "../claude-compat.js";
import type { IrFormat } from "../format.js";
import type { IrRequest } from "../ir.js";
import { codecFor } from "../protocols.js";
import {
  type ClientCacheMarks,
  droppedMarksHeader,
  readClientCacheMarks,
  wantsClientCacheMarks,
} from "./cache.js";
import { claudeRunEnv } from "./cli.js";
import { ClaudeBridge, type ClaudeTurnHandle } from "./bridge.js";
import { noteClaudeRun } from "./mode.js";
import {
  type ClaudePromptMessage,
  type ClaudePromptPart,
  type ClaudeTurnRequest,
} from "./prompt.js";
import { relayClaudeEvents } from "./relay.js";
import { ClaudeRoomFullError } from "./room.js";
import { claudeAnswer } from "./schema.js";
import { claudeSessionDirs } from "./sessions.js";
import { filterTextCalls } from "./text-calls.js";
import type { ClaudeMessageUsage, ClaudeStreamEvent } from "./stream.js";
import { bridgeTools, mcpConfigJson, type ClaudeToolSpec } from "./tools.js";
import { ensureClaudeWorkDir } from "./workdir.js";

/** Puts masking's stand-ins back as the reply streams. */
export interface ClaudeTextRestorer {
  push(text: string): string;
  flush(): string;
}

export interface ClaudeRuntime {
  bridge: ClaudeBridge;
  /** The absolute path of mcp-helper.mjs. */
  helperPath: string;
  /** Where the helper calls back, without a trailing slash. */
  callbackBaseUrl: string;
  /** What the machine's account directories are under. */
  claudeConfigDir: (accountConfigDir?: string) => string;
  workDir?: string;
  /** Whether Claude Code runs as `claude -p`; off is its interactive mode, as myna defaults. */
  printMode?: () => boolean;
}

export interface ClaudeServeInput {
  runtime: ClaudeRuntime;
  res: Response;
  /** The request body in Anthropic's shape. */
  body: unknown;
  model: string;
  /** Whom the run serves, for the conversation key and the run list. */
  owner: string;
  /** A saved account's config directory; absent is the machine's sign-in. */
  configDir?: string;
  /** Give the caller's instructions as Claude Code's system prompt file. */
  leanPrompt?: boolean;
  /** Claude Code's own web search answers the caller's tool. */
  webSearch?: boolean;
  /** Puts back what masking replaced, on the reply's words. */
  restorer?: ClaudeTextRestorer;
  /** The client's headers, for its own cache marks. */
  headers?: Record<string, unknown>;
  /** Answers as `claude -p`; the caller's setting, else the runtime's. */
  printMode?: boolean;
}

/**
 * Answers one Anthropic request through a real Claude Code, as myna's
 * subscription bridge does: the caller's tools are the bridge's MCP helper's,
 * and the reply is relayed as Anthropic SSE or one message.
 */
export async function serveClaudeSubscription(input: ClaudeServeInput): Promise<void> {
  let request = claudeTurnRequest(input.body);
  const cacheMarks = cacheMarksOf(input);
  const ir = irOf(input.body);
  const irMessages = ir?.messages;
  const jsonSchema = claudeJsonSchema(ir?.format ?? null);
  const streaming = isRecord(input.body) && input.body.stream === true;
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-run-"));
  try {
    const token = randomBytes(18).toString("hex");
    const toolsFile = path.join(dir, "tools.json");
    const callbackFile = path.join(dir, "callback");
    const listedFile = path.join(dir, "listed");
    const printMode = input.printMode ?? input.runtime.printMode?.() ?? false;
    // The provider editor's "last request" (myna's noteClaudeRun).
    noteClaudeRun(printMode ? "off" : "");
    const tools = bridgeTools(request.tools ?? []);
    const answer = claudeAnswerFor(tools, printMode, ir);
    await writeFile(toolsFile, JSON.stringify(answer === null ? tools : [...tools, answer.spec]), {
      mode: 0o600,
    });
    await writeFile(callbackFile, `${input.runtime.callbackBaseUrl}/_neolix/claude-mcp/${token}`, {
      mode: 0o600,
    });
    const lean = await prepareSystemPrompt(dir, request, input.leanPrompt === true);
    request = lean.request;
    const systemPromptFile = lean.file;
    const mcpConfig = mcpConfigJson(process.execPath, [
      input.runtime.helperPath,
      callbackFile,
      toolsFile,
      listedFile,
    ]);
    const cwd = input.runtime.workDir ?? (await ensureClaudeWorkDir());
    if (input.runtime.workDir !== undefined) {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
    }
    const configDir = input.runtime.claudeConfigDir(input.configDir);
    const sessionDirs = await claudeSessionDirs(configDir, cwd);
    const handle = await input.runtime.bridge.startTurn({
      owner: input.owner,
      model: input.model,
      request,
      cwd,
      env: claudeRunEnv({ env: process.env, configDir: input.configDir }),
      mcpConfig,
      sessionDirs,
      runToken: token,
      webSearch: input.webSearch === true,
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
      ...(irMessages === undefined ? {} : { irMessages }),
      ...(cacheMarks === undefined ? {} : { cacheMarks }),
      ...(systemPromptFile === undefined ? {} : { systemPromptFile }),
      ...(printMode ? {} : { tui: { listedFile } }),
      ...(answer === null ? {} : { answer }),
    });
    if (streaming) {
      await writeStream(input.res, handle, input.model, input.restorer, answer !== null);
    } else {
      await writeMessage(input.res, handle, input.model, input.restorer, answer !== null);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The answer tool a request with a JSON schema is answered through in the
 * interactive mode, or null: `-p` takes the schema itself.
 */
function claudeAnswerFor(
  tools: readonly ClaudeToolSpec[],
  printMode: boolean,
  ir: IrRequest | undefined,
): ReturnType<typeof claudeAnswer> | null {
  if (printMode || ir?.format?.type !== "json_schema") {
    return null;
  }
  return claudeAnswer(tools, ir.format.schema);
}

/** The caller's instructions as a file, when they are long enough to be one. */
async function prepareSystemPrompt(
  dir: string,
  request: ClaudeTurnRequest,
  lean: boolean,
): Promise<{ request: ClaudeTurnRequest; file?: string }> {
  const system = lean ? (request.system ?? "") : "";
  if (system === "") {
    return { request };
  }
  const file = path.join(dir, "system.md");
  await writeFile(file, withoutBillingHeader(system), { mode: 0o600 });
  return { request: { ...request, system: undefined }, file };
}

/** The caller's marks, when it opted in, and the header that says how many were dropped. */
function cacheMarksOf(input: ClaudeServeInput): ClientCacheMarks | undefined {
  if (input.headers === undefined || !wantsClientCacheMarks(input.headers)) {
    return undefined;
  }
  const marks = readClientCacheMarks(isRecord(input.body) ? input.body : {});
  for (const [name, value] of Object.entries(droppedMarksHeader(marks))) {
    input.res.setHeader(name, value);
  }
  return marks;
}

/** The JSON schema a caller asked its answer to fit, as `--json-schema` takes it. */
export function claudeJsonSchema(format: IrFormat | null): string | undefined {
  if (format === null || format.type !== "json_schema" || !isRecord(format.schema)) {
    return undefined;
  }
  return JSON.stringify(format.schema);
}

/** The request as the codec reads it, when it can. */
function irOf(body: unknown): IrRequest | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  try {
    return codecFor("anthropic").parseRequest(body);
  } catch {
    return undefined;
  }
}

/** A 503 for no room, as myna answers it so routing can try another account. */
export function claudeServeError(error: unknown): { status: number; message: string } {
  if (error instanceof ClaudeRoomFullError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof Error && error.message.startsWith("the JSON schema")) {
    return { status: 400, message: error.message };
  }
  return { status: 502, message: error instanceof Error ? error.message : String(error) };
}

async function writeStream(
  res: Response,
  handle: ClaudeTurnHandle,
  model: string,
  restore: ClaudeTextRestorer | undefined,
  answerExpected: boolean,
): Promise<void> {
  res.status(200);
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();
  for await (const frame of relayClaudeEvents(
    filterTextCalls(answerEvents(handle, restore, answerExpected)),
    {
      model,
      messageId: `msg_${randomUUID().replaceAll("-", "")}`,
    },
  )) {
    res.write(frame);
  }
  res.end();
}

async function writeMessage(
  res: Response,
  handle: ClaudeTurnHandle,
  model: string,
  restore: ClaudeTextRestorer | undefined,
  answerExpected: boolean,
): Promise<void> {
  const text: string[] = [];
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  const usage = emptyUsage();
  let stop = "end_turn";
  let error: string | null = null;
  for await (const event of filterTextCalls(answerEvents(handle, restore, answerExpected))) {
    collect(
      event,
      text,
      calls,
      usage,
      (reason) => {
        stop = reason;
      },
      (message) => {
        error = message;
      },
    );
  }
  if (error !== null) {
    res.status(502).json({ error: { type: "api_error", message: error } });
    return;
  }
  res.json({
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(text.length === 0 ? [] : [{ type: "text", text: text.join("") }]),
      ...calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseJson(call.arguments),
      })),
    ],
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_input_tokens: usage.cacheCreationInputTokens,
      cache_read_input_tokens: usage.cacheReadInputTokens,
    },
  });
}

/**
 * A turn's events, or, when its answer tool was in play, the answer it
 * gave: the client asked for a JSON schema, and the interactive mode's
 * words are not that answer.
 */
async function* answerEvents(
  handle: ClaudeTurnHandle,
  restore: ClaudeTextRestorer | undefined,
  answerExpected: boolean,
): AsyncGenerator<ClaudeStreamEvent> {
  if (!answerExpected) {
    yield* restoredEvents(handle.events, restore);
    return;
  }
  const buffered: ClaudeStreamEvent[] = [];
  for await (const event of restoredEvents(handle.events, restore)) {
    buffered.push(event);
  }
  const answer = handle.takeAnswer();
  if (answer === null) {
    yield* buffered;
    return;
  }
  const restored = restore === undefined ? answer : `${restore.push(answer)}${restore.flush()}`;
  yield { kind: "text", text: restored };
  yield { kind: "stop", stop: "end_turn" };
}

/** Puts back the values masking replaced, before the client sees the words. */
async function* restoredEvents(
  events: AsyncIterable<ClaudeStreamEvent>,
  restorer: ClaudeTextRestorer | undefined,
): AsyncGenerator<ClaudeStreamEvent> {
  for await (const event of events) {
    if (restorer !== undefined && event.kind === "text") {
      const text = restorer.push(event.text);
      if (text !== "") {
        yield { kind: "text", text };
      }
    } else {
      yield event;
    }
  }
  const tail = restorer?.flush() ?? "";
  if (tail !== "") {
    yield { kind: "text", text: tail };
  }
}

function collect(
  event: ClaudeStreamEvent,
  text: string[],
  calls: Array<{ id: string; name: string; arguments: string }>,
  usage: ClaudeMessageUsage,
  setStop: (stop: string) => void,
  setError: (message: string) => void,
): void {
  switch (event.kind) {
    case "text":
      text.push(event.text);
      return;
    case "toolCall":
      calls.push({ id: event.id, name: event.name, arguments: event.arguments });
      return;
    case "usage":
      usage.inputTokens += event.usage.inputTokens;
      usage.outputTokens += event.usage.outputTokens;
      usage.cacheCreationInputTokens += event.usage.cacheCreationInputTokens;
      usage.cacheReadInputTokens += event.usage.cacheReadInputTokens;
      return;
    case "stop":
      setStop(event.stop);
      return;
    case "error":
      setError(event.message);
  }
}

/** The account's config directory: its own, else the machine's sign-in. */
export function defaultClaudeConfigDir(accountConfigDir?: string): string {
  if (accountConfigDir !== undefined && accountConfigDir !== "") {
    return accountConfigDir;
  }
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * An Anthropic request body as the bridge's turn: the caller's system
 * instructions, its messages (text, its tool calls and their results), and
 * its tools. Images are left out until the vision item lands.
 */
export function claudeTurnRequest(body: unknown): ClaudeTurnRequest {
  if (!isRecord(body)) {
    return { messages: [] };
  }
  const system = systemText(body.system);
  const messages: ClaudePromptMessage[] = [];
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
        continue;
      }
      messages.push({ role: message.role, parts: contentParts(message.content) });
    }
  }
  const tools = toolSpecs(body.tools);
  return {
    ...(system === "" ? {} : { system }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
  };
}

function systemText(system: unknown): string {
  if (typeof system === "string") {
    return system;
  }
  if (!Array.isArray(system)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function contentParts(content: unknown): ClaudePromptPart[] {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: ClaudePromptPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ kind: "text", text: block.text });
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      parts.push({
        kind: "toolCall",
        id: block.id,
        name: typeof block.name === "string" ? block.name : "",
        arguments: JSON.stringify(block.input ?? {}),
      });
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      parts.push({
        kind: "toolResult",
        callId: block.tool_use_id,
        text: toolResultText(block.content),
        isError: block.is_error === true,
      });
    } else if (block.type === "image") {
      parts.push({ kind: "text", text: "[image]" });
    }
  }
  return parts;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function toolSpecs(tools: unknown): ClaudeToolSpec[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: ClaudeToolSpec[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string") {
      continue;
    }
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.input_schema ?? { type: "object", properties: {} },
    });
  }
  return out;
}

function emptyUsage(): ClaudeMessageUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
