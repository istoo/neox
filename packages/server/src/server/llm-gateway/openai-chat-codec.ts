import { randomUUID } from "node:crypto";
import { chatFormat, parseOpenAiFormat } from "./format.js";
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
  type IrStopReason,
  type IrTool,
  type IrToolChoice,
  type IrUsage,
} from "./ir.js";
import { SseParser, type SseEvent } from "./sse.js";

const DATA_URL_PATTERN = /^data:([^;]+);base64,(.*)$/s;

export const openAiChatCodec: ProtocolCodec = {
  protocol: "openai",
  parseRequest: parseOpenAiRequest,
  buildRequestBody: buildOpenAiRequestBody,
  parseResponse: parseOpenAiResponse,
  buildResponseBody: buildOpenAiResponseBody,
  createStreamDecoder: () => new OpenAiStreamDecoder(),
  createStreamEncoder: (requestedModel) => new OpenAiStreamEncoder(requestedModel),
};

interface ParsedMessages {
  system: string | null;
  messages: IrMessage[];
}

function parseOpenAiRequest(body: Record<string, unknown>): IrRequest {
  const request = emptyRequest();
  const parsed = parseOpenAiMessages(optionalArray(body, "messages") ?? []);
  request.system = parsed.system;
  request.messages = parsed.messages;
  request.tools = parseOpenAiTools(optionalArray(body, "tools") ?? []);
  request.toolChoice = parseOpenAiToolChoice(body.tool_choice);
  request.format = parseOpenAiFormat(body.response_format);
  request.maxTokens = readNumber(body, "max_tokens") ?? readNumber(body, "max_completion_tokens");
  request.temperature = readNumber(body, "temperature");
  request.topP = readNumber(body, "top_p");
  request.stop = parseStop(body.stop);
  request.stream = readBoolean(body, "stream");
  return request;
}

function parseStop(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseOpenAiMessages(value: unknown[]): ParsedMessages {
  const systemParts: string[] = [];
  const messages: IrMessage[] = [];

  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const role = readString(entry, "role");
    if (role === "system" || role === "developer") {
      const text = contentToText(entry.content);
      if (text !== null) {
        systemParts.push(text);
      }
      continue;
    }
    if (role === "tool") {
      const toolCallId = readString(entry, "tool_call_id");
      if (toolCallId !== null) {
        const images = parseContentImages(entry.content);
        appendToolResult(messages, {
          type: "tool_result",
          toolCallId,
          content: contentToText(entry.content) ?? "",
          isError: false,
          ...(images.length === 0 ? {} : { images }),
        });
      }
      continue;
    }
    if (role === "assistant") {
      const parts: IrPart[] = [];
      const text = contentToText(entry.content);
      if (text !== null && text.length > 0) {
        parts.push({ type: "text", text });
      }
      for (const call of optionalArray(entry, "tool_calls") ?? []) {
        const part = parseToolCall(call);
        if (part !== null) {
          parts.push(part);
        }
      }
      messages.push({ role: "assistant", parts });
      continue;
    }
    if (role === "user") {
      messages.push({ role: "user", parts: parseUserContent(entry.content) });
    }
  }

  return { system: systemParts.length > 0 ? systemParts.join("\n") : null, messages };
}

function parseUserContent(content: unknown): IrPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: IrPart[] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    const type = readString(block, "type");
    if (type === "text") {
      const text = readString(block, "text");
      if (text !== null) {
        parts.push({ type: "text", text });
      }
      continue;
    }
    if (type === "image_url") {
      const image = openAiImage(readImageUrl(block));
      if (image !== null) {
        parts.push(image);
      }
    }
  }
  return parts;
}

/** The URL of a Chat image block: a string or the `url` of its object. */
function readImageUrl(block: Record<string, unknown>): string | null {
  const value = block.image_url;
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) ? readString(value, "url") : null;
}

/** A Chat image as an IR image: inline bytes, or the URL it lives at. */
function openAiImage(url: string | null): IrImagePart | null {
  if (url === null || url.length === 0) {
    return null;
  }
  const match = DATA_URL_PATTERN.exec(url);
  if (match !== null) {
    return { type: "image", mediaType: match[1], data: match[2] };
  }
  return { type: "image", mediaType: "image/*", data: "", url };
}

/** The images among a tool message's content parts. */
function parseContentImages(content: unknown): IrImagePart[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const images: IrImagePart[] = [];
  for (const block of content) {
    if (!isRecord(block) || readString(block, "type") !== "image_url") {
      continue;
    }
    const image = openAiImage(readImageUrl(block));
    if (image !== null) {
      images.push(image);
    }
  }
  return images;
}

function parseToolCall(value: unknown): IrPart | null {
  if (!isRecord(value)) {
    return null;
  }
  const fn = optionalRecord(value, "function");
  const name = fn === null ? null : readString(fn, "name");
  if (name === null) {
    return null;
  }
  // A call Gemini signed carries its signature in the id the client was
  // given (myna's gemini_signature.go).
  const raw = readString(value, "id") ?? `call_${randomUUID()}`;
  const unsigned = unsignCallId(raw);
  const { id, items } = takeReasoning(unsigned.id);
  return {
    type: "tool_call",
    id,
    name,
    arguments: (fn === null ? null : readString(fn, "arguments")) ?? "{}",
    ...(unsigned.signature === null ? {} : { signature: unsigned.signature }),
    ...(items.length === 0 ? {} : { reasoning: items }),
  };
}

function contentToText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const texts = value
    .filter(isRecord)
    .filter((block) => readString(block, "type") === "text")
    .map((block) => readString(block, "text"))
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

function appendToolResult(
  messages: IrMessage[],
  part: Extract<IrPart, { type: "tool_result" }>,
): void {
  const last = messages.at(-1);
  if (
    last !== undefined &&
    last.role === "user" &&
    last.parts.every((entry) => entry.type === "tool_result")
  ) {
    last.parts.push(part);
    return;
  }
  messages.push({ role: "user", parts: [part] });
}

function parseOpenAiTools(value: unknown[]): IrTool[] {
  const tools: IrTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const fn = optionalRecord(entry, "function");
    if (fn === null) {
      continue;
    }
    const name = readString(fn, "name");
    const parameters = optionalRecord(fn, "parameters");
    if (name === null || parameters === null) {
      continue;
    }
    tools.push({ name, description: readString(fn, "description"), inputSchema: parameters });
  }
  return tools;
}

function parseOpenAiToolChoice(value: unknown): IrToolChoice {
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return value;
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const fn = optionalRecord(value, "function");
  const name = fn === null ? null : readString(fn, "name");
  return name === null ? null : { name };
}

function buildOpenAiRequestBody(request: IrRequest, model: string): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  if (request.system !== null) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.messages) {
    messages.push(...buildOpenAiMessages(message));
  }

  const body: Record<string, unknown> = { model, messages };
  if (request.format !== null) {
    body.response_format = chatFormat(request.format);
  }
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? undefined,
        parameters: tool.inputSchema,
      },
    }));
    if (request.toolChoice !== null) {
      body.tool_choice = buildOpenAiToolChoice(request.toolChoice);
    }
  }
  if (request.maxTokens !== null) {
    body.max_tokens = request.maxTokens;
  }
  if (request.temperature !== null) {
    body.temperature = request.temperature;
  }
  if (request.topP !== null) {
    body.top_p = request.topP;
  }
  if (request.stop.length > 0) {
    body.stop = request.stop;
  }
  if (request.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  return body;
}

function buildOpenAiMessages(message: IrMessage): Record<string, unknown>[] {
  if (message.role === "assistant") {
    return [buildOpenAiAssistantMessage(message)];
  }

  const toolResults = message.parts.filter(
    (part): part is Extract<IrPart, { type: "tool_result" }> => part.type === "tool_result",
  );
  const own = message.parts.filter((part) => part.type !== "tool_result");
  const messages: Record<string, unknown>[] = toolResults.map((part) => ({
    role: "tool",
    tool_call_id: takeReasoning(unsignCallId(part.toolCallId).id).id,
    content: part.content,
  }));
  // A tool message holds text only, so its images go in a user message
  // after the results, marked with the result they came from, as myna
  // sends them.
  const fromTools: IrPart[] = [];
  for (const part of toolResults) {
    if (part.images === undefined || part.images.length === 0) {
      continue;
    }
    fromTools.push({ type: "text", text: `[From the result of ${part.toolCallId}:]` });
    fromTools.push(...part.images);
  }
  const contentParts = [...fromTools, ...own];
  if (contentParts.length > 0) {
    messages.push({ role: "user", content: buildOpenAiUserContent(contentParts) });
  }
  return messages;
}

function buildOpenAiAssistantMessage(message: IrMessage): Record<string, unknown> {
  const text = message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  const toolCalls = message.parts.filter(
    (part): part is Extract<IrPart, { type: "tool_call" }> => part.type === "tool_call",
  );
  const result: Record<string, unknown> = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  };
  if (toolCalls.length > 0) {
    result.tool_calls = toolCalls.map((part) => ({
      id: signCallId(part.id, part.signature),
      type: "function",
      function: { name: part.name, arguments: part.arguments },
    }));
  }
  return result;
}

function buildOpenAiUserContent(parts: IrPart[]): string | Record<string, unknown>[] {
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
  }
  const content: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      content.push({
        type: "image_url",
        image_url: { url: part.url ?? `data:${part.mediaType};base64,${part.data}` },
      });
    }
  }
  return content;
}

function buildOpenAiToolChoice(choice: Exclude<IrToolChoice, null>): unknown {
  if (typeof choice === "string") {
    return choice;
  }
  return { type: "function", function: { name: choice.name } };
}

function parseOpenAiResponse(body: Record<string, unknown>): IrResponse {
  const choice = firstChoice(body);
  const message = choice === null ? null : optionalRecord(choice, "message");
  const parts: IrPart[] = [];
  const reasoning = message === null ? null : readString(message, "reasoning_content");
  if (reasoning !== null && reasoning.length > 0) {
    parts.push({ type: "thinking", text: reasoning });
  }
  const text = message === null ? null : contentToText(message.content);
  if (text !== null && text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const call of message === null ? [] : (optionalArray(message, "tool_calls") ?? [])) {
    const part = parseToolCall(call);
    if (part !== null) {
      parts.push(part);
    }
  }
  const finishReason = choice === null ? null : readString(choice, "finish_reason");
  const tier = readString(body, "service_tier");
  return {
    id: readString(body, "id"),
    parts,
    stopReason: normalizeStopReason(
      finishReason,
      parts.some((part) => part.type === "tool_call"),
    ),
    usage: readOpenAiUsage(optionalRecord(body, "usage")),
    ...(tier === null || tier.length === 0 ? {} : { tierServed: tier }),
  };
}

function firstChoice(body: Record<string, unknown>): Record<string, unknown> | null {
  const choices = optionalArray(body, "choices");
  if (choices === null || choices.length === 0) {
    return null;
  }
  const first = choices[0];
  return isRecord(first) ? first : null;
}

function readOpenAiUsage(value: Record<string, unknown> | null): IrUsage {
  if (value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  // The OpenAI shape counts cache reads in `prompt_tokens`, and reasoning in
  // `completion_tokens`; they are read apart so the usage report can say how
  // much of the prompt came from the cache.
  const promptDetails = optionalRecord(value, "prompt_tokens_details");
  const completionDetails = optionalRecord(value, "completion_tokens_details");
  const credits = readNumber(value, "credit") ?? 0;
  return {
    inputTokens: readNumber(value, "prompt_tokens") ?? 0,
    outputTokens: readNumber(value, "completion_tokens") ?? 0,
    ...cacheFields(
      promptDetails === null ? 0 : (readNumber(promptDetails, "cached_tokens") ?? 0),
      0,
      completionDetails === null ? 0 : (readNumber(completionDetails, "reasoning_tokens") ?? 0),
    ),
    ...(credits > 0 ? { credits } : {}),
  };
}

function buildOpenAiResponseBody(
  response: IrResponse,
  requestedModel: string,
): Record<string, unknown> {
  const text = response.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  const toolCalls = response.parts.filter(
    (part): part is Extract<IrPart, { type: "tool_call" }> => part.type === "tool_call",
  );
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text.length > 0 ? text : null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((part) => ({
      id: signCallId(part.id, part.signature),
      type: "function",
      function: { name: part.name, arguments: part.arguments },
    }));
  }
  return {
    id: response.id ?? `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, message, finish_reason: openAiFinishReason(response.stopReason) }],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

function openAiFinishReason(reason: IrStopReason): string {
  if (reason === "tool_use") {
    return "tool_calls";
  }
  if (reason === "max_tokens") {
    return "length";
  }
  return "stop";
}

class OpenAiStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser();
  private readonly toolCallIdByIndex = new Map<number, string>();

  public push(chunk: string): IrEvent[] {
    return this.parser.push(chunk).flatMap((event) => this.decode(event));
  }

  public flush(): IrEvent[] {
    return this.parser.flush().flatMap((event) => this.decode(event));
  }

  private decode(event: SseEvent): IrEvent[] {
    if (event.data === "[DONE]") {
      return [];
    }
    const payload = parseJson(event.data);
    if (payload === null) {
      return [];
    }
    const events: IrEvent[] = [];
    const choice = firstChoice(payload);
    if (choice !== null) {
      events.push(...this.decodeChoice(choice));
    }
    const usage = readOpenAiUsage(optionalRecord(payload, "usage"));
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      events.push({ type: "usage", usage });
    }
    return events;
  }

  private decodeChoice(choice: Record<string, unknown>): IrEvent[] {
    const events: IrEvent[] = [];
    const delta = optionalRecord(choice, "delta");
    if (delta !== null) {
      const reasoning = readString(delta, "reasoning_content");
      if (reasoning !== null && reasoning.length > 0) {
        events.push({ type: "thinking_delta", text: reasoning });
      }
      const text = readString(delta, "content");
      if (text !== null && text.length > 0) {
        events.push({ type: "text_delta", text });
      }
      for (const call of optionalArray(delta, "tool_calls") ?? []) {
        events.push(...this.decodeToolCall(call));
      }
    }
    const finishReason = readString(choice, "finish_reason");
    if (finishReason !== null) {
      events.push({ type: "stop", reason: normalizeStopReason(finishReason, false) });
    }
    return events;
  }

  private decodeToolCall(value: unknown): IrEvent[] {
    if (!isRecord(value)) {
      return [];
    }
    const index = readNumber(value, "index") ?? 0;
    const fn = optionalRecord(value, "function");
    const name = fn === null ? null : readString(fn, "name");
    const announcedId = readString(value, "id");
    const events: IrEvent[] = [];

    let callId = this.toolCallIdByIndex.get(index) ?? null;
    let signature: string | null = null;
    if (callId === null && announcedId !== null && name !== null) {
      const unsigned = unsignCallId(announcedId);
      callId = unsigned.id;
      signature = unsigned.signature;
      this.toolCallIdByIndex.set(index, callId);
      events.push({
        type: "tool_call_start",
        id: callId,
        name,
        ...(signature === null ? {} : { signature }),
      });
    }
    const args = fn === null ? null : readString(fn, "arguments");
    if (args !== null && args.length > 0 && callId !== null) {
      events.push({ type: "tool_args_delta", id: callId, args });
    }
    return events;
  }
}

class OpenAiStreamEncoder implements StreamEncoder {
  private readonly requestedModel: string;
  private readonly id = `chatcmpl-${randomUUID()}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly toolIndexByCallId = new Map<string, number>();
  private finished = false;
  private stopReason: IrStopReason | null = null;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
  }

  public start(): string {
    return this.chunk({ role: "assistant", content: "" });
  }

  public replyId(): string {
    return this.id;
  }

  public push(event: IrEvent): string {
    switch (event.type) {
      case "text_delta":
        return this.chunk({ content: event.text });
      case "tool_call_start":
        return this.startToolCall(signCallId(event.id, event.signature), event.name);
      case "tool_args_delta": {
        const index = this.toolIndexByCallId.get(event.id);
        return index === undefined
          ? ""
          : this.chunk({ tool_calls: [{ index, function: { arguments: event.args } }] });
      }
      case "stop":
        // The upstream's final usage rides on the same reply after the stop
        // (Anthropic's message_delta, OpenAI's include_usage chunk). The
        // finish chunk waits for `end()` so it lands before `[DONE]`.
        this.stopReason = event.reason;
        return "";
      case "usage":
        return this.chunk({}, null, event.usage);
      case "thinking_delta":
      case "signature_delta":
      case "redacted_thinking":
      case "search":
      case "reasoning_item":
      case "start":
        return "";
    }
  }

  public end(): string {
    if (this.finished) {
      return "";
    }
    return this.finish(this.stopReason ?? "end_turn") + "data: [DONE]\n\n";
  }

  private startToolCall(id: string, name: string): string {
    const index = this.toolIndexByCallId.size;
    this.toolIndexByCallId.set(id, index);
    return this.chunk({
      role: "assistant",
      tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }],
    });
  }

  private finish(reason: IrStopReason): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    return this.chunk({}, openAiFinishReason(reason));
  }

  private chunk(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage: IrUsage | null = null,
  ): string {
    const payload: Record<string, unknown> = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage !== null) {
      payload.usage = {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      };
    }
    return `data: ${JSON.stringify(payload)}\n\n`;
  }
}

function parseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
