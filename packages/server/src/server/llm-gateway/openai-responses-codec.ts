import { randomUUID } from "node:crypto";
import { parseOpenAiFormat, responsesFormat } from "./format.js";
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from "./codec.js";
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
  type IrTool,
  type IrToolChoice,
  type IrUsage,
} from "./ir.js";
import { formatSseEvent, SseParser, type SseEvent } from "./sse.js";
import {
  isClaudeSeal,
  reasoningItem,
  sealThinking,
  thinkingOfReasoningItem,
} from "./claude-seal.js";
import { searchItem } from "./search-events.js";
import { signCallId, unsignCallId } from "./gemini-signature.js";
import { takeReasoning } from "./reasoning-carry.js";

const DEFAULT_MAX_TOKENS = 4096;

export const openAiResponsesCodec: ProtocolCodec = {
  protocol: "openai-responses",
  parseRequest: parseResponsesRequest,
  buildRequestBody: buildResponsesRequestBody,
  parseResponse: parseResponsesResponse,
  buildResponseBody: buildResponsesResponseBody,
  createStreamDecoder: () => new ResponsesStreamDecoder(),
  createStreamEncoder: (requestedModel) => new ResponsesStreamEncoder(requestedModel),
};

function parseResponsesRequest(body: Record<string, unknown>): IrRequest {
  const request = emptyRequest();
  request.system = readString(body, "instructions");
  request.messages = parseResponsesInput(body.input);
  request.tools = parseResponsesTools(optionalArray(body, "tools") ?? []);
  request.toolChoice = parseResponsesToolChoice(body.tool_choice);
  request.maxTokens = readNumber(body, "max_output_tokens");
  request.temperature = readNumber(body, "temperature");
  request.topP = readNumber(body, "top_p");
  request.stream = readBoolean(body, "stream");
  request.format = parseOpenAiFormat(isRecord(body.text) ? body.text.format : undefined);
  return request;
}

function parseResponsesInput(value: unknown): IrMessage[] {
  if (typeof value === "string") {
    return [{ role: "user", parts: [{ type: "text", text: value }] }];
  }
  const messages: IrMessage[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!isRecord(item)) {
      continue;
    }
    const type = readString(item, "type");

    if (type === "reasoning") {
      const part = reasoningPart(item);
      messages.push({ role: "assistant", parts: [part] });
      continue;
    }
    if (type === "function_call") {
      const parsed = parseFunctionCallItem(item);
      if (parsed !== null) {
        messages.push({ role: "assistant", parts: [parsed] });
      }
      continue;
    }
    if (type === "function_call_output") {
      const callId = readString(item, "call_id");
      if (callId !== null) {
        const output = item.output;
        const parsed = parseResponsesContent(output);
        const images = parsed.filter((part): part is IrImagePart => part.type === "image");
        const text = parsed
          .map((part) => (part.type === "text" ? part.text : ""))
          .filter((entry) => entry.length > 0)
          .join("\n");
        const content = toolOutputText(output, parsed.length > 0, text);
        appendToolResult(messages, {
          type: "tool_result",
          toolCallId: callId,
          content,
          isError: false,
          ...(images.length === 0 ? {} : { images }),
        });
      }
      continue;
    }

    const role = readString(item, "role");
    if (role !== "assistant" && role !== "user") {
      continue;
    }
    const messageRole = role;
    messages.push({
      role: messageRole,
      parts: parseResponsesContent(item.content),
    });
  }
  return messages;
}

/** A function_call_output's text: its string, its parts, or its JSON. */
function toolOutputText(output: unknown, hasParts: boolean, text: string): string {
  if (typeof output === "string") {
    return output;
  }
  return hasParts ? text : JSON.stringify(output ?? "");
}

function parseResponsesContent(content: unknown): IrPart[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  const parts: IrPart[] = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!isRecord(block)) {
      continue;
    }
    const type = readString(block, "type");
    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = readString(block, "text");
      if (text !== null) {
        parts.push({ type: "text", text });
      }
      continue;
    }
    if (type === "input_image") {
      const url = readString(block, "image_url");
      if (url !== null) {
        const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
        parts.push(
          match !== null
            ? { type: "image", mediaType: match[1], data: match[2] }
            : { type: "image", mediaType: "image/*", data: "", url },
        );
      }
    }
  }
  return parts;
}

/** A reasoning item: Claude's block read out, any other kept whole. */
function reasoningPart(item: Record<string, unknown>): IrPart {
  // An item written with its text in content parts is another vendor's
  // shape, which OpenAI refuses back; it goes as one this gateway makes,
  // its text a summary and nothing sealed (myna's reasoning_content.go).
  const made = reasoningWithText(item);
  if (made !== null) {
    return { type: "reasoning_item", item: made };
  }
  const thinking = thinkingOfReasoningItem(item);
  if (thinking !== null) {
    return thinking;
  }
  return { type: "reasoning_item", item };
}

function reasoningWithText(item: Record<string, unknown>): Record<string, unknown> | null {
  if (item.type !== "reasoning" || !Array.isArray(item.content) || item.content.length === 0) {
    return null;
  }
  const textOf = (value: unknown, kind: string | null): string => {
    let text = "";
    for (const part of Array.isArray(value) ? value : []) {
      if (
        isRecord(part) &&
        (kind === null || part.type === kind) &&
        typeof part.text === "string"
      ) {
        text += part.text;
      }
    }
    return text;
  };
  const said = textOf(item.content, "reasoning_text") || textOf(item.summary, null);
  return {
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : `rs_${randomUUID()}`,
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text: said }],
  };
}

function parseFunctionCallItem(item: Record<string, unknown>): IrPart | null {
  const name = readString(item, "name");
  if (name === null) {
    return null;
  }
  const raw = readString(item, "call_id") ?? readString(item, "id") ?? `call_${randomUUID()}`;
  // A call's id carries Gemini's signature and, for a client that keeps
  // none, the reasoning items before it (myna's gemini_signature.go and
  // reasoning_carry.go).
  const unsigned = unsignCallId(raw);
  const { id, items } = takeReasoning(unsigned.id);
  return {
    type: "tool_call",
    id,
    name,
    arguments: readString(item, "arguments") ?? "{}",
    ...(unsigned.signature === null ? {} : { signature: unsigned.signature }),
    ...(items.length === 0 ? {} : { reasoning: items }),
  };
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

function parseResponsesTools(value: unknown[]): IrTool[] {
  const tools: IrTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || readString(entry, "type") !== "function") {
      continue;
    }
    const name = readString(entry, "name");
    const parameters = optionalRecord(entry, "parameters");
    if (name === null || parameters === null) {
      continue;
    }
    tools.push({ name, description: readString(entry, "description"), inputSchema: parameters });
  }
  return tools;
}

function parseResponsesToolChoice(value: unknown): IrToolChoice {
  if (typeof value === "string") {
    if (value === "auto" || value === "none" || value === "required") {
      return value;
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const name = readString(value, "name");
  return name === null ? null : { name };
}

/** The input item a part stands for, when it is one of its own. */
function responsesInputItem(part: IrPart): Record<string, unknown> | null {
  if (part.type === "thinking") {
    // Claude's signed thinking goes in the item's encrypted_content so a
    // Responses client carries it back on the next turn of a tool loop.
    return part.signature === undefined || part.signature.length === 0
      ? null
      : reasoningItem(part.text, part.signature, `rs_${randomUUID()}`);
  }
  if (part.type === "tool_call") {
    return { type: "function_call", call_id: part.id, name: part.name, arguments: part.arguments };
  }
  if (part.type !== "tool_result") {
    return null;
  }
  return {
    type: "function_call_output",
    call_id: takeReasoning(unsignCallId(part.toolCallId).id).id,
    output: responsesToolOutput(part),
  };
}

function responsesToolOutput(part: Extract<IrPart, { type: "tool_result" }>): unknown {
  if (part.images === undefined || part.images.length === 0) {
    return part.content;
  }
  return [
    ...(part.content.length === 0 ? [] : [{ type: "input_text", text: part.content }]),
    ...part.images.map((image) => ({
      type: "input_image",
      image_url: responsesImageUrl(image),
    })),
  ];
}

function responsesToolItem(tool: IrTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? undefined,
    parameters: tool.inputSchema,
  };
}

/**
 * The deferred tools a Responses upstream is offered where a result loaded
 * them, by name; empty when it doesn't load tools in place (myna's
 * Request.LoadedInPlace).
 */
function deferredTools(request: IrRequest): Map<string, IrTool> {
  const deferred = new Map<string, IrTool>();
  if (request.loadedInPlace !== true) {
    return deferred;
  }
  for (const tool of request.tools) {
    if (tool.deferred === true) {
      deferred.set(tool.name, tool);
    }
  }
  return deferred;
}

/** The tools this result loaded that weren't offered yet. */
function noteLoadedTools(
  part: Extract<IrPart, { type: "tool_result" }>,
  deferred: ReadonlyMap<string, IrTool>,
  placed: Set<string>,
  loaded: IrTool[],
): void {
  for (const name of part.loads ?? []) {
    const tool = deferred.get(name);
    if (tool !== undefined && !placed.has(name)) {
      placed.add(name);
      loaded.push(tool);
    }
  }
}

/** One part as the input items it stands for, in place. */
function appendPart(
  part: IrPart,
  input: Record<string, unknown>[],
  deferred: ReadonlyMap<string, IrTool>,
  placed: Set<string>,
  loaded: IrTool[],
  flushLoaded: () => void,
): void {
  // an additional_tools item closes the run of results before anything else
  if (part.type !== "tool_result") {
    flushLoaded();
  }
  if (part.type === "reasoning_item") {
    input.push({ ...part.item });
    return;
  }
  if (part.type === "tool_call") {
    for (const reasoning of part.reasoning ?? []) {
      input.push({ ...reasoning });
    }
  }
  const item = responsesInputItem(part);
  if (item !== null) {
    input.push(item);
  }
  if (part.type === "tool_result") {
    noteLoadedTools(part, deferred, placed, loaded);
  }
}

/** A message's content as the items a client reads: the assistant's own
 * text is output_text. */
function responsesMessageBlocks(
  role: "user" | "assistant",
  content: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    blocks.push(role === "assistant" ? { ...part, type: "output_text" } : part);
  }
  return blocks;
}

/** The request's own fields, without the conversation and the model. */
function responsesBodyFields(
  request: IrRequest,
  placed: ReadonlySet<string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (request.format !== null) {
    body.text = { format: responsesFormat(request.format) };
  }
  if (request.system !== null) {
    body.instructions = request.system;
  }
  if (request.tools.length > 0) {
    // a tool offered where it was loaded is not offered again up top
    const offered = request.tools
      .filter((tool) => !placed.has(tool.name))
      .map((tool) => responsesToolItem(tool));
    if (offered.length > 0) {
      body.tools = offered;
    }
    if (request.toolChoice !== null) {
      body.tool_choice =
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : { type: "function", name: request.toolChoice.name };
    }
  }
  if (request.temperature !== null) {
    body.temperature = request.temperature;
  }
  if (request.topP !== null) {
    body.top_p = request.topP;
  }
  if (request.stream) {
    body.stream = true;
  }
  return body;
}

function buildResponsesRequestBody(request: IrRequest, model: string): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  const deferred = deferredTools(request);
  const placed = new Set<string>();
  const loaded: IrTool[] = [];
  const flushLoaded = (): void => {
    if (loaded.length === 0) {
      return;
    }
    const tools = loaded.splice(0);
    input.push({
      type: "additional_tools",
      role: "developer",
      tools: tools.map(responsesToolItem),
    });
  };
  for (const message of request.messages) {
    for (const part of message.parts) {
      appendPart(part, input, deferred, placed, loaded, flushLoaded);
    }
    const content = message.parts.flatMap((part) => buildResponsesContent(part));
    if (content.length > 0) {
      flushLoaded();
      const blocks = responsesMessageBlocks(message.role, content);
      input.push({ type: "message", role: message.role, content: blocks });
    }
  }
  flushLoaded();
  return {
    model,
    input,
    max_output_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...responsesBodyFields(request, placed),
  };
}

function responsesImageUrl(image: IrImagePart): string {
  return image.url ?? `data:${image.mediaType};base64,${image.data}`;
}

function buildResponsesContent(part: IrPart): Record<string, unknown>[] {
  switch (part.type) {
    case "search":
    case "reasoning_item":
      return [];
    case "text":
      return [{ type: "input_text", text: part.text }];
    case "image":
      return [{ type: "input_image", image_url: responsesImageUrl(part) }];
    case "thinking":
    case "tool_call":
    case "tool_result":
      return [];
  }
}

function parseResponsesResponse(body: Record<string, unknown>): IrResponse {
  const parts: IrPart[] = [];
  for (const item of optionalArray(body, "output") ?? []) {
    if (!isRecord(item)) {
      continue;
    }
    const type = readString(item, "type");
    if (type === "function_call") {
      const call = parseFunctionCallItem(item);
      if (call !== null) {
        parts.push(call);
      }
      continue;
    }
    if (type === "reasoning") {
      parts.push(reasoningPart(item));
      continue;
    }
    if (type === "message") {
      for (const part of parseResponsesContent(item.content)) {
        parts.push(part);
      }
    }
  }
  const usageRecord = optionalRecord(body, "usage");
  const tier = readString(body, "service_tier");
  return {
    id: readString(body, "id"),
    parts,
    stopReason: normalizeStopReason(
      readString(body, "status") === "incomplete" ? "length" : null,
      parts.some((part) => part.type === "tool_call"),
    ),
    usage: readResponsesUsage(usageRecord),
    ...(tier === null || tier.length === 0 ? {} : { tierServed: tier }),
  };
}

function readResponsesUsage(value: Record<string, unknown> | null): IrUsage {
  if (value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const inputDetails = optionalRecord(value, "input_tokens_details");
  const outputDetails = optionalRecord(value, "output_tokens_details");
  const credits = readNumber(value, "credit") ?? 0;
  return {
    inputTokens: readNumber(value, "input_tokens") ?? 0,
    outputTokens: readNumber(value, "output_tokens") ?? 0,
    ...cacheFields(
      inputDetails === null ? 0 : (readNumber(inputDetails, "cached_tokens") ?? 0),
      0,
      outputDetails === null ? 0 : (readNumber(outputDetails, "reasoning_tokens") ?? 0),
    ),
    ...(credits > 0 ? { credits } : {}),
  };
}

function buildResponsesResponseBody(
  response: IrResponse,
  requestedModel: string,
): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  for (const part of response.parts) {
    if (part.type === "search") {
      output.push(searchItem(part.query, `ws_${randomUUID()}`, part.pages));
    }
  }
  for (const part of response.parts) {
    if (part.type === "reasoning_item") {
      output.push({ ...part.item });
    }
    if (part.type === "thinking" && part.signature !== undefined && part.signature.length > 0) {
      output.push(reasoningItem(part.text, part.signature, `rs_${randomUUID()}`));
    }
  }
  const text = response.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (text.length > 0 || !response.parts.some((part) => part.type === "tool_call")) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const part of response.parts) {
    if (part.type !== "tool_call") {
      continue;
    }
    output.push({
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: signCallId(part.id, part.signature),
      name: part.name,
      arguments: part.arguments,
      status: "completed",
    });
  }
  return {
    id: response.id ?? `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: {
      input_tokens: response.usage.inputTokens,
      output_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    },
  };
}

class ResponsesStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser();
  private readonly toolCalls = new Map<string, { id: string; name: string }>();

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
      case "response.output_item.added":
        return this.decodeItemAdded(payload);
      case "response.output_text.delta":
        return this.decodeTextDelta(payload);
      case "response.function_call_arguments.delta":
        return this.decodeArgumentsDelta(payload);
      case "response.output_item.done":
        return this.decodeReasoningItem(payload);
      case "response.completed":
        return this.decodeCompleted(payload, false);
      case "response.incomplete":
        return this.decodeCompleted(payload, true);
      default:
        return [];
    }
  }

  private decodeItemAdded(payload: Record<string, unknown>): IrEvent[] {
    const item = optionalRecord(payload, "item");
    if (item === null || readString(item, "type") !== "function_call") {
      return [];
    }
    const name = readString(item, "name");
    const raw = readString(item, "call_id") ?? readString(item, "id");
    if (name === null || raw === null) {
      return [];
    }
    const { id: callId, signature } = unsignCallId(raw);
    this.toolCalls.set(readString(item, "id") ?? raw, { id: callId, name });
    return [
      {
        type: "tool_call_start",
        id: callId,
        name,
        ...(signature === null ? {} : { signature }),
      },
    ];
  }

  private decodeReasoningItem(payload: Record<string, unknown>): IrEvent[] {
    const item = optionalRecord(payload, "item");
    if (item === null || readString(item, "type") !== "reasoning") {
      return [];
    }
    if (isClaudeSeal(item.encrypted_content)) {
      return [];
    }
    return [{ type: "reasoning_item", item }];
  }

  private decodeTextDelta(payload: Record<string, unknown>): IrEvent[] {
    const delta = readString(payload, "delta");
    return delta === null || delta.length === 0 ? [] : [{ type: "text_delta", text: delta }];
  }

  private decodeArgumentsDelta(payload: Record<string, unknown>): IrEvent[] {
    const itemId = readString(payload, "item_id");
    const delta = readString(payload, "delta");
    const call = itemId === null ? undefined : this.toolCalls.get(itemId);
    if (call === undefined || delta === null) {
      return [];
    }
    return [{ type: "tool_args_delta", id: call.id, args: delta }];
  }

  private decodeCompleted(payload: Record<string, unknown>, incomplete: boolean): IrEvent[] {
    const response = optionalRecord(payload, "response");
    const usage = readResponsesUsage(response === null ? null : optionalRecord(response, "usage"));
    const events: IrEvent[] = [];
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      events.push({ type: "usage", usage });
    }
    events.push({ type: "stop", reason: incomplete ? "max_tokens" : "end_turn" });
    return events;
  }
}

class ResponsesStreamEncoder implements StreamEncoder {
  private readonly requestedModel: string;
  private readonly responseId = `resp_${randomUUID()}`;
  private outputIndex = 0;
  private textItemId: string | null = null;
  private text = "";
  private contentPartOpen = false;
  private sequence = 0;
  private readonly toolItems = new Map<string, { itemId: string; callId: string }>();
  private usage: IrUsage = { inputTokens: 0, outputTokens: 0 };
  private finished = false;
  private reasoning: { id: string; index: number; text: string; signature: string } | null = null;
  private reasoningDone: Record<string, unknown> | null = null;
  private readonly searchDone: Record<string, unknown>[] = [];
  private readonly reasoningItems: Record<string, unknown>[] = [];
  private textIndex = 0;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
  }

  public replyId(): string {
    return this.responseId;
  }

  public start(): string {
    return this.event("response.created", {
      type: "response.created",
      response: {
        id: this.responseId,
        object: "response",
        status: "in_progress",
        model: this.requestedModel,
        output: [],
      },
    });
  }

  public push(event: IrEvent): string {
    switch (event.type) {
      case "text_delta":
        return this.closeReasoning() + this.textDelta(event.text);
      case "tool_call_start":
        return this.closeReasoning() + this.toolStart(event.id, event.name, event.signature);
      case "tool_args_delta": {
        const call = this.toolItems.get(event.id);
        return call === undefined
          ? ""
          : this.event("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              item_id: call.itemId,
              output_index: this.outputIndex,
              delta: event.args,
            });
      }
      case "usage":
        this.usage = event.usage;
        return "";
      case "stop":
        // The final usage rides with (or after) the stop; `response.completed`
        // is written from `end()` so its usage is the upstream's final count.
        return "";
      case "search":
        return this.closeReasoning() + this.searchCall(event.query, event.pages);
      case "reasoning_item":
        return this.closeReasoning() + this.passReasoning(event.item);
      case "thinking_delta":
        return this.thinkingDelta(event.text);
      case "redacted_thinking":
        return "";
      case "signature_delta":
        return this.signatureDelta(event.signature);
      case "start":
        return "";
    }
  }

  public end(): string {
    return this.closeReasoning() + (this.finished ? "" : this.finish());
  }

  /** A reasoning item another Responses client keeps as it came. */
  private passReasoning(item: Record<string, unknown>): string {
    const index = this.outputIndex;
    this.outputIndex += 1;
    this.textIndex = this.outputIndex;
    this.reasoningItems.push(item);
    return (
      this.event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item,
      }) +
      this.event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item,
      })
    );
  }

  /** A search the gateway ran, as a web_search_call item. */
  private searchCall(
    query: string,
    pages: ReadonlyArray<{ title: string; url: string; age?: string }>,
  ): string {
    const item = searchItem(query, `ws_${randomUUID()}`, pages);
    const index = this.outputIndex;
    this.outputIndex += 1;
    this.textIndex = this.outputIndex;
    this.searchDone.push(item);
    return (
      this.event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: index,
        item,
      }) +
      this.event("response.web_search_call.completed", {
        type: "response.web_search_call.completed",
        output_index: index,
        item_id: item.id,
      }) +
      this.event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: index,
        item,
      })
    );
  }

  private thinkingDelta(text: string): string {
    if (text.length === 0) {
      return "";
    }
    const opened = this.openReasoning();
    if (this.reasoning === null) {
      return opened;
    }
    this.reasoning.text += text;
    return (
      opened +
      this.event("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: this.reasoning.id,
        output_index: this.reasoning.index,
        summary_index: 0,
        delta: text,
      })
    );
  }

  private signatureDelta(signature: string): string {
    if (signature.length === 0) {
      return "";
    }
    const opened = this.openReasoning();
    if (this.reasoning !== null) {
      this.reasoning.signature += signature;
    }
    return opened;
  }

  private openReasoning(): string {
    if (this.reasoning !== null) {
      return "";
    }
    const reasoning = {
      id: `rs_${randomUUID()}`,
      index: this.outputIndex,
      text: "",
      signature: "",
    };
    this.reasoning = reasoning;
    this.outputIndex += 1;
    this.textIndex = this.outputIndex;
    return this.event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: reasoning.index,
      item: { id: reasoning.id, type: "reasoning", status: "in_progress", summary: [] },
    });
  }

  /** The reasoning item as a client carries it back, its block sealed inside. */
  private closeReasoning(): string {
    const reasoning = this.reasoning;
    if (reasoning === null) {
      return "";
    }
    this.reasoning = null;
    const summary =
      reasoning.text.length > 0 ? [{ type: "summary_text", text: reasoning.text }] : [];
    let events = "";
    if (reasoning.text.length > 0) {
      events += this.event("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        text: reasoning.text,
      });
      events += this.event("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        part: { type: "summary_text", text: reasoning.text },
      });
    }
    const item: Record<string, unknown> = {
      id: reasoning.id,
      type: "reasoning",
      status: "completed",
      summary,
    };
    if (reasoning.signature.length > 0) {
      item.encrypted_content = sealThinking(reasoning.text, reasoning.signature);
    }
    this.reasoningDone = item;
    return (
      events +
      this.event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: reasoning.index,
        item,
      })
    );
  }

  private textDelta(text: string): string {
    if (text.length === 0) {
      return "";
    }
    this.text += text;
    let output = "";
    if (this.textItemId === null) {
      this.textItemId = `msg_${randomUUID()}`;
      output += this.event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.textIndex,
        item: {
          id: this.textItemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      });
    }
    if (!this.contentPartOpen) {
      this.contentPartOpen = true;
      output += this.event("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    return (
      output +
      this.event("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        delta: text,
        logprobs: [],
      })
    );
  }

  private toolStart(callId: string, name: string, signature?: string): string {
    this.outputIndex += 1;
    const itemId = `fc_${randomUUID()}`;
    const signed = signCallId(callId, signature);
    this.toolItems.set(callId, { itemId, callId: signed });
    return this.event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.outputIndex,
      item: {
        id: itemId,
        type: "function_call",
        call_id: signed,
        name,
        arguments: "",
        status: "in_progress",
      },
    });
  }

  private finish(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    const output: Record<string, unknown>[] = [...this.searchDone, ...this.reasoningItems];
    let events = "";
    if (this.reasoningDone !== null) {
      output.push(this.reasoningDone);
    }
    if (this.textItemId !== null) {
      const item = {
        id: this.textItemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      events += this.event("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        text: this.text,
        logprobs: [],
      });
      events += this.event("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      events += this.event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.textIndex,
        item,
      });
      output.push(item);
    }
    for (const call of this.toolItems.values()) {
      const item = {
        id: call.itemId,
        type: "function_call",
        call_id: call.callId,
        status: "completed",
      };
      events += this.event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.outputIndex,
        item,
      });
      output.push(item);
    }
    events += this.event("response.completed", {
      type: "response.completed",
      response: {
        id: this.responseId,
        object: "response",
        status: "completed",
        model: this.requestedModel,
        output,
        usage: {
          input_tokens: this.usage.inputTokens,
          output_tokens: this.usage.outputTokens,
          total_tokens: this.usage.inputTokens + this.usage.outputTokens,
        },
      },
    });
    return events;
  }

  private event(name: string, payload: Record<string, unknown>): string {
    const event = { ...payload, sequence_number: this.sequence };
    this.sequence += 1;
    return formatSseEvent(name, event);
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
