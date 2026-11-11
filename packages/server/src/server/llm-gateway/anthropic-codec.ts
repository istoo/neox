import { randomUUID } from "node:crypto";
import { anthropicFormat, formatInstruction, parseAnthropicFormat } from "./format.js";
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from "./codec.js";
import { signCallId, unsignCallId } from "./gemini-signature.js";
import { takeReasoning } from "./reasoning-carry.js";
import {
  cacheFields,
  emptyRequest,
  isRecord,
  normalizeStopReason,
  optionalArray,
  optionalRecord,
  readBoolean,
  readNumber,
  readString,
  type IrEvent,
  type IrImagePart,
  type IrMessage,
  type IrPart,
  type IrRequest,
  type IrResponse,
  type IrSearchPage,
  type IrStopReason,
  type IrTool,
  type IrToolChoice,
  type IrUsage,
} from "./ir.js";
import { formatSseEvent, SseParser, type SseEvent } from "./sse.js";
import {
  anthropicSearchBlocks,
  anthropicSearchResultBlock,
  searchToolId,
} from "./search-events.js";

const DEFAULT_MAX_TOKENS = 4096;

export const anthropicCodec: ProtocolCodec = {
  protocol: "anthropic",
  parseRequest: parseAnthropicRequest,
  buildRequestBody: buildAnthropicRequestBody,
  parseResponse: parseAnthropicResponse,
  buildResponseBody: buildAnthropicResponseBody,
  createStreamDecoder: () => new AnthropicStreamDecoder(),
  createStreamEncoder: (requestedModel) => new AnthropicStreamEncoder(requestedModel),
};

function parseAnthropicRequest(body: Record<string, unknown>): IrRequest {
  const request = emptyRequest();
  request.system = parseSystem(body.system);
  request.messages = parseMessages(optionalArray(body, "messages") ?? []);
  request.tools = parseTools(optionalArray(body, "tools") ?? []);
  request.toolChoice = parseToolChoice(body.tool_choice);
  request.maxTokens = readNumber(body, "max_tokens");
  request.temperature = readNumber(body, "temperature");
  request.topP = readNumber(body, "top_p");
  request.stop = (optionalArray(body, "stop_sequences") ?? []).filter(
    (value): value is string => typeof value === "string",
  );
  request.stream = readBoolean(body, "stream");
  request.format = parseAnthropicFormat(
    isRecord(body.output_config) ? body.output_config.format : undefined,
  );
  return request;
}

function parseSystem(value: unknown): string | null {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  const blocks = Array.isArray(value) ? value : [];
  const texts = blocks
    .filter(isRecord)
    .map((block) => readString(block, "text"))
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

function parseMessages(value: unknown[]): IrMessage[] {
  const messages: IrMessage[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const role = readString(entry, "role");
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    messages.push({ role, parts: parseContent(entry.content) });
  }
  return messages;
}

function parseContent(content: unknown): IrPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: IrPart[] = [];
  for (const block of content) {
    const part = parseBlock(block);
    if (part !== null) {
      parts.push(part);
    }
  }
  return parts;
}

function parseBlock(value: unknown): IrPart | null {
  if (!isRecord(value)) {
    return null;
  }
  switch (readString(value, "type")) {
    case "text": {
      const text = readString(value, "text");
      return text === null ? null : { type: "text", text };
    }
    case "redacted_thinking": {
      const data = readString(value, "data");
      return data === null ? null : { type: "thinking", text: "", redacted: data };
    }
    case "thinking": {
      const text = readString(value, "thinking");
      if (text === null) {
        return null;
      }
      const signature = readString(value, "signature");
      return signature === null
        ? { type: "thinking", text }
        : { type: "thinking", text, signature };
    }
    case "image": {
      return parseImageBlock(value);
    }
    case "tool_use": {
      const raw = readString(value, "id");
      const name = readString(value, "name");
      if (raw === null || name === null) {
        return null;
      }
      // A call Gemini signed carries its signature in the id (myna's
      // gemini_signature.go).
      const unsigned = unsignCallId(raw);
      const { id, items } = takeReasoning(unsigned.id);
      return {
        type: "tool_call",
        id,
        name,
        arguments: JSON.stringify(value.input ?? {}),
        ...(unsigned.signature === null ? {} : { signature: unsigned.signature }),
        ...(items.length === 0 ? {} : { reasoning: items }),
      };
    }
    case "tool_result":
      return parseToolResultBlock(value);
    default:
      return null;
  }
}

function parseToolResultBlock(value: Record<string, unknown>): IrPart | null {
  const toolCallId = readString(value, "tool_use_id");
  if (toolCallId === null) {
    return null;
  }
  const blocks = Array.isArray(value.content) ? value.content.filter(isRecord) : [];
  const images = blocks
    .map((block) => (readString(block, "type") === "image" ? parseImageBlock(block) : null))
    .filter((image): image is IrImagePart => image !== null);
  // Claude Code's ToolSearch answers with tool_reference blocks naming the
  // deferred tools it loaded (myna's toolRefs).
  const loads = blocks
    .filter((block) => readString(block, "type") === "tool_reference")
    .map((block) => readString(block, "tool_name"))
    .filter((name): name is string => name !== null && name.length > 0);
  return {
    type: "tool_result",
    toolCallId,
    content: stringifyToolResult(value.content),
    isError: readBoolean(value, "is_error"),
    ...(images.length === 0 ? {} : { images }),
    ...(loads.length === 0 ? {} : { loads }),
  };
}

function parseImageBlock(value: Record<string, unknown>): IrImagePart | null {
  const source = optionalRecord(value, "source");
  if (source === null) {
    return null;
  }
  const mediaType = readString(source, "media_type") ?? "image/*";
  if (readString(source, "type") === "url") {
    const url = readString(source, "url");
    return url === null ? null : { type: "image", mediaType, data: "", url };
  }
  const data = readString(source, "data");
  if (data === null) {
    return null;
  }
  return { type: "image", mediaType, data };
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .map((block) => readString(block, "text"))
      .filter((text): text is string => text !== null)
      .join("\n");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function parseTools(value: unknown[]): IrTool[] {
  const tools: IrTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const name = readString(entry, "name");
    const inputSchema = optionalRecord(entry, "input_schema");
    if (name === null || inputSchema === null) {
      continue;
    }
    // only keeps Anthropic's deferred loading on; never to be called
    // (myna's anthropic.go:257)
    if (name === "DeferredToolPlaceholder") {
      continue;
    }
    tools.push({
      name,
      description: readString(entry, "description"),
      inputSchema,
      ...(readBoolean(entry, "defer_loading") ? { deferred: true } : {}),
    });
  }
  return tools;
}

function parseToolChoice(value: unknown): IrToolChoice {
  if (!isRecord(value)) {
    return null;
  }
  switch (readString(value, "type")) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool": {
      const name = readString(value, "name");
      return name === null ? null : { name };
    }
    default:
      return null;
  }
}

function buildAnthropicRequestBody(request: IrRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map(buildAnthropicMessage),
  };
  let system = request.system;
  if (request.format !== null) {
    const asked = anthropicFormat(request.format);
    if (asked === null) {
      // Messages takes a schema only; any JSON object is told in words.
      const line = formatInstruction(request.format);
      system = system === null || system.length === 0 ? line : `${system}\n\n${line}`;
    } else {
      body.output_config = { format: asked };
    }
  }
  if (system !== null) {
    body.system = system;
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? undefined,
      input_schema: tool.inputSchema,
    }));
    if (request.toolChoice !== null) {
      body.tool_choice = buildAnthropicToolChoice(request.toolChoice);
    }
  }
  if (request.temperature !== null) {
    body.temperature = request.temperature;
  }
  if (request.topP !== null) {
    body.top_p = request.topP;
  }
  if (request.stop.length > 0) {
    body.stop_sequences = request.stop;
  }
  if (request.stream) {
    body.stream = true;
  }
  return body;
}

function buildAnthropicMessage(message: IrMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.parts.flatMap((part) => buildAnthropicBlock(part)),
  };
}

function anthropicImageSource(image: IrImagePart): Record<string, unknown> {
  return image.url === undefined
    ? { type: "base64", media_type: image.mediaType, data: image.data }
    : { type: "url", url: image.url };
}

function buildAnthropicBlock(part: IrPart, signed = false): Record<string, unknown>[] {
  switch (part.type) {
    case "text":
      return [
        {
          type: "text",
          text: part.text,
          ...(part.citations === undefined || part.citations.length === 0
            ? {}
            : { citations: part.citations }),
        },
      ];
    case "image":
      return [{ type: "image", source: anthropicImageSource(part) }];
    case "tool_call":
      return [
        {
          type: "tool_use",
          // A reply's id carries Gemini's signature to the client; a
          // request to another upstream gets the id the call had.
          id: signed ? signCallId(part.id, part.signature) : part.id,
          name: part.name,
          input: parseArguments(part.arguments),
        },
      ];
    case "search":
      // The search the gateway ran, as Anthropic's own web search tells it.
      return anthropicSearchBlocks(searchToolId(), part.query, part.pages);
    case "reasoning_item":
      return [];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: takeReasoning(unsignCallId(part.toolCallId).id).id,
          content:
            part.images === undefined || part.images.length === 0
              ? part.content
              : [
                  ...(part.content.length === 0 ? [] : [{ type: "text", text: part.content }]),
                  ...part.images.map((image) => ({
                    type: "image",
                    source: anthropicImageSource(image),
                  })),
                ],
          is_error: part.isError,
        },
      ];
    case "thinking":
      // A redacted block goes back whole; an unsigned thinking block is no
      // history to Anthropic, a signed one replays its signature
      // (myna's thinking_signature.go).
      if (part.redacted !== undefined) {
        return [{ type: "redacted_thinking", data: part.redacted }];
      }
      return part.signature === undefined || part.signature.length === 0
        ? []
        : [{ type: "thinking", thinking: part.text, signature: part.signature }];
  }
}

function parseArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText);
  } catch {
    return {};
  }
}

function buildAnthropicToolChoice(choice: Exclude<IrToolChoice, null>): Record<string, unknown> {
  if (choice === "auto") {
    return { type: "auto" };
  }
  if (choice === "none") {
    return { type: "none" };
  }
  if (choice === "required") {
    return { type: "any" };
  }
  return { type: "tool", name: choice.name };
}

function parseAnthropicResponse(body: Record<string, unknown>): IrResponse {
  const parts = parseContent(optionalArray(body, "content") ?? []);
  const sawToolCall = parts.some((part) => part.type === "tool_call");
  const usageRecord = optionalRecord(body, "usage");
  const speed = readString(body, "speed");
  return {
    id: readString(body, "id"),
    parts,
    stopReason: normalizeStopReason(readString(body, "stop_reason"), sawToolCall),
    usage: readUsage(usageRecord),
    ...(speed === null || speed.length === 0 ? {} : { tierServed: speed }),
  };
}

function readUsage(value: Record<string, unknown> | null): IrUsage {
  if (value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const cacheWrite = readNumber(value, "cache_creation_input_tokens") ?? 0;
  // The 1-hour writes are billed apart; a reply that doesn't split them kept
  // them all for five minutes.
  const creation = optionalRecord(value, "cache_creation");
  const oneHour = creation === null ? 0 : (readNumber(creation, "ephemeral_1h_input_tokens") ?? 0);
  const credits = readNumber(value, "credit") ?? 0;
  return {
    inputTokens: readNumber(value, "input_tokens") ?? 0,
    outputTokens: readNumber(value, "output_tokens") ?? 0,
    // Anthropic reports cache traffic beside `input_tokens`, which excludes it.
    ...cacheFields(readNumber(value, "cache_read_input_tokens") ?? 0, cacheWrite, undefined),
    ...(oneHour > 0 ? { cacheWrite1hTokens: Math.min(oneHour, cacheWrite) } : {}),
    ...(credits > 0 ? { credits } : {}),
  };
}

function buildAnthropicResponseBody(
  response: IrResponse,
  requestedModel: string,
): Record<string, unknown> {
  return {
    id: response.id ?? `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: response.parts.flatMap((part) => buildAnthropicBlock(part, true)),
    stop_reason: anthropicStopReason(response.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
    },
  };
}

function anthropicStopReason(reason: IrStopReason): string {
  if (reason === "stop") {
    return "stop_sequence";
  }
  return reason;
}

class AnthropicStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser();
  private readonly toolCallIds = new Map<number, string>();

  public push(chunk: string): IrEvent[] {
    return this.parser.push(chunk).flatMap((event) => this.decode(event));
  }

  public flush(): IrEvent[] {
    return this.parser.flush().flatMap((event) => this.decode(event));
  }

  private decode(event: SseEvent): IrEvent[] {
    const payload = parseJson(event.data);
    if (payload === null) {
      return [];
    }
    switch (event.event) {
      case "message_start":
        return this.decodeMessageStart(payload);
      case "content_block_start":
        return this.decodeBlockStart(payload);
      case "content_block_delta":
        return this.decodeBlockDelta(payload);
      case "message_delta":
        return this.decodeMessageDelta(payload);
      default:
        return [];
    }
  }

  private decodeMessageStart(payload: Record<string, unknown>): IrEvent[] {
    const message = optionalRecord(payload, "message");
    const events: IrEvent[] = [
      { type: "start", id: message === null ? null : readString(message, "id") },
    ];
    const usage = readUsage(message === null ? null : optionalRecord(message, "usage"));
    if (usage.inputTokens > 0) {
      events.push({ type: "usage", usage });
    }
    return events;
  }

  private decodeBlockStart(payload: Record<string, unknown>): IrEvent[] {
    const index = readNumber(payload, "index") ?? 0;
    const block = optionalRecord(payload, "content_block");
    if (block !== null && readString(block, "type") === "redacted_thinking") {
      const data = readString(block, "data");
      return data === null ? [] : [{ type: "redacted_thinking", data }];
    }
    if (block === null || readString(block, "type") !== "tool_use") {
      return [];
    }
    const id = readString(block, "id");
    const name = readString(block, "name");
    if (id === null || name === null) {
      return [];
    }
    const unsigned = unsignCallId(id);
    this.toolCallIds.set(index, unsigned.id);
    return [
      {
        type: "tool_call_start",
        id: unsigned.id,
        name,
        ...(unsigned.signature === null ? {} : { signature: unsigned.signature }),
      },
    ];
  }

  private decodeBlockDelta(payload: Record<string, unknown>): IrEvent[] {
    const index = readNumber(payload, "index") ?? 0;
    const delta = optionalRecord(payload, "delta");
    if (delta === null) {
      return [];
    }
    switch (readString(delta, "type")) {
      case "text_delta": {
        const text = readString(delta, "text");
        return text === null ? [] : [{ type: "text_delta", text }];
      }
      case "thinking_delta": {
        const text = readString(delta, "thinking");
        return text === null ? [] : [{ type: "thinking_delta", text }];
      }
      case "signature_delta": {
        const signature = readString(delta, "signature");
        return signature === null ? [] : [{ type: "signature_delta", signature }];
      }
      case "input_json_delta": {
        const args = readString(delta, "partial_json");
        const id = this.toolCallIds.get(index);
        return args === null || id === undefined ? [] : [{ type: "tool_args_delta", id, args }];
      }
      default:
        return [];
    }
  }

  private decodeMessageDelta(payload: Record<string, unknown>): IrEvent[] {
    const delta = optionalRecord(payload, "delta");
    const events: IrEvent[] = [];
    if (delta !== null) {
      const reason = readString(delta, "stop_reason");
      if (reason !== null) {
        events.push({ type: "stop", reason: normalizeStopReason(reason, false) });
      }
    }
    const usage = readUsage(optionalRecord(payload, "usage"));
    if (usage.outputTokens > 0) {
      events.push({ type: "usage", usage });
    }
    return events;
  }
}

class AnthropicStreamEncoder implements StreamEncoder {
  private readonly messageId = `msg_${randomUUID()}`;
  private blockIndex = -1;
  private openKind: "text" | "thinking" | "tool" | null = null;
  private openToolId: string | null = null;
  private stopReason: IrStopReason | null = null;
  private finished = false;
  private outputTokens = 0;
  private readonly requestedModel: string;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
  }

  public replyId(): string {
    return this.messageId;
  }

  public start(): string {
    return formatSseEvent("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  public push(event: IrEvent): string {
    switch (event.type) {
      case "text_delta":
        return (
          this.openBlock("text") +
          (event.citations ?? [])
            .map((citation) => this.delta({ type: "citations_delta", citation }))
            .join("") +
          this.delta({ type: "text_delta", text: event.text })
        );
      case "thinking_delta":
        return (
          this.openBlock("thinking") + this.delta({ type: "thinking_delta", thinking: event.text })
        );
      case "redacted_thinking":
        return this.redactedBlock(event.data);
      case "signature_delta":
        return (
          this.openBlock("thinking") +
          this.delta({ type: "signature_delta", signature: event.signature })
        );
      case "tool_call_start":
        return this.openTool(signCallId(event.id, event.signature), event.name);
      case "search":
        return this.searchBlocks(event.query, event.pages);
      case "tool_args_delta":
        return this.delta({ type: "input_json_delta", partial_json: event.args });
      case "usage":
        this.outputTokens = event.usage.outputTokens;
        return "";
      case "stop":
        // message_delta carries the final output_tokens alongside the stop;
        // the closing frames are written from `end()` so they carry it.
        this.stopReason = event.reason;
        return "";
      case "reasoning_item":
      case "start":
        return "";
    }
  }

  public end(): string {
    return this.finished ? "" : this.finish(this.stopReason ?? "end_turn");
  }

  private openBlock(kind: "text" | "thinking"): string {
    if (this.openKind === kind) {
      return "";
    }
    const closed = this.closeBlock();
    this.blockIndex += 1;
    this.openKind = kind;
    const contentBlock =
      kind === "text"
        ? { type: "text", text: "" }
        : { type: "thinking", thinking: "", signature: "" };
    return (
      closed +
      formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: contentBlock,
      })
    );
  }

  /** A redacted thinking block, as Anthropic streams it. */
  private redactedBlock(data: string): string {
    const closed = this.closeBlock();
    this.blockIndex += 1;
    return (
      closed +
      formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "redacted_thinking", data },
      }) +
      formatSseEvent("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      })
    );
  }

  /** A search's call and result, as two of Anthropic's own blocks. */
  private searchBlocks(query: string, pages: readonly IrSearchPage[]): string {
    const closed = this.closeBlock();
    const id = searchToolId();
    this.blockIndex += 1;
    let out = closed;
    out += formatSseEvent("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: { type: "server_tool_use", id, name: "web_search", input: {} },
    });
    out += this.delta({ type: "input_json_delta", partial_json: JSON.stringify({ query }) });
    out += formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex,
    });
    this.blockIndex += 1;
    out += formatSseEvent("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: anthropicSearchResultBlock(id, pages),
    });
    out += formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex,
    });
    return out;
  }

  private openTool(id: string, name: string): string {
    if (this.openKind === "tool" && this.openToolId === id) {
      return "";
    }
    const closed = this.closeBlock();
    this.blockIndex += 1;
    this.openKind = "tool";
    this.openToolId = id;
    return (
      closed +
      formatSseEvent("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "tool_use", id, name, input: {} },
      })
    );
  }

  private closeBlock(): string {
    if (this.openKind === null) {
      return "";
    }
    const block = formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex,
    });
    this.openKind = null;
    return block;
  }

  private delta(delta: Record<string, unknown>): string {
    return formatSseEvent("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta,
    });
  }

  private finish(reason: IrStopReason): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    this.stopReason = reason;
    const closed = this.closeBlock();
    const messageDelta = formatSseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: anthropicStopReason(reason), stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    const stop = formatSseEvent("message_stop", { type: "message_stop" });
    return closed + messageDelta + stop;
  }
}

function parseJson(data: string): Record<string, unknown> | null {
  if (data === "[DONE]") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
