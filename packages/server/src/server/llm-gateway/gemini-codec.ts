import { randomUUID } from "node:crypto";
import { geminiFormat, parseGeminiFormat } from "./format.js";
import type { ProtocolCodec, StreamDecoder, StreamEncoder } from "./codec.js";
import { SKIP_SIGNATURE } from "./gemini-signature.js";
import {
  cacheFields,
  emptyRequest,
  isRecord,
  normalizeStopReason,
  optionalArray,
  optionalRecord,
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
import { GeminiGrounding } from "./search-events.js";
import { SseParser, type SseEvent } from "./sse.js";

const DEFAULT_MAX_TOKENS = 4096;

export const geminiCodec: ProtocolCodec = {
  protocol: "gemini",
  parseRequest: parseGeminiRequest,
  buildRequestBody: buildGeminiRequestBody,
  parseResponse: parseGeminiResponse,
  buildResponseBody: buildGeminiResponseBody,
  createStreamDecoder: () => new GeminiStreamDecoder(),
  createStreamEncoder: (requestedModel) => new GeminiStreamEncoder(requestedModel),
};

function parseGeminiRequest(body: Record<string, unknown>): IrRequest {
  const request = emptyRequest();
  request.system = readGeminiSystem(body.systemInstruction);
  request.messages = parseGeminiContents(optionalArray(body, "contents") ?? []);
  request.tools = parseGeminiTools(optionalArray(body, "tools") ?? []);
  request.toolChoice = parseGeminiToolChoice(body.toolConfig);
  const generation = optionalRecord(body, "generationConfig");
  request.format = parseGeminiFormat(generation);
  if (generation !== null) {
    request.maxTokens = readNumber(generation, "maxOutputTokens");
    request.temperature = readNumber(generation, "temperature");
    request.topP = readNumber(generation, "topP");
    request.stop = (optionalArray(generation, "stopSequences") ?? []).filter(
      (value): value is string => typeof value === "string",
    );
  }
  return request;
}

function readGeminiSystem(value: unknown): string | null {
  const instruction = isRecord(value) ? value : null;
  if (instruction === null) {
    return null;
  }
  const texts = (optionalArray(instruction, "parts") ?? [])
    .filter(isRecord)
    .map((part) => readString(part, "text"))
    .filter((text): text is string => text !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

function parseGeminiContents(contents: unknown[]): IrMessage[] {
  const messages: IrMessage[] = [];
  for (const entry of contents) {
    if (!isRecord(entry)) {
      continue;
    }
    const role = readString(entry, "role") === "model" ? "assistant" : "user";
    const parts = parseGeminiParts(optionalArray(entry, "parts") ?? []);
    messages.push({ role, parts });
  }
  return messages;
}

function parseGeminiParts(parts: unknown[]): IrPart[] {
  const result: IrPart[] = [];
  let toolCallIndex = 0;
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    const text = readString(part, "text");
    if (text !== null) {
      // Gemini marks reasoning parts with `thought`; they are not replies.
      result.push(part.thought === true ? { type: "thinking", text } : { type: "text", text });
      continue;
    }
    const inlineData = optionalRecord(part, "inlineData");
    if (inlineData !== null) {
      const mimeType = readString(inlineData, "mimeType");
      const data = readString(inlineData, "data");
      if (mimeType !== null && data !== null) {
        result.push({ type: "image", mediaType: mimeType, data });
      }
      continue;
    }
    const fileData = optionalRecord(part, "fileData");
    if (fileData !== null) {
      const mimeType = readString(fileData, "mimeType") ?? "image/*";
      const fileUri = readString(fileData, "fileUri");
      if (fileUri !== null && mimeType.startsWith("image/")) {
        result.push({ type: "image", mediaType: mimeType, data: "", url: fileUri });
      }
      continue;
    }
    const functionCall = optionalRecord(part, "functionCall");
    if (functionCall !== null) {
      const name = readString(functionCall, "name");
      if (name !== null) {
        toolCallIndex += 1;
        const signature =
          readString(part, "thoughtSignature") ?? readString(functionCall, "thoughtSignature");
        result.push({
          type: "tool_call",
          id: `call_${toolCallIndex}`,
          name,
          arguments: JSON.stringify(functionCall.args ?? {}),
          ...(signature === null ? {} : { signature }),
        });
      }
      continue;
    }
    const functionResponse = optionalRecord(part, "functionResponse");
    if (functionResponse !== null) {
      const name = readString(functionResponse, "name");
      if (name !== null) {
        result.push({
          type: "tool_result",
          toolCallId: name,
          content: JSON.stringify(functionResponse.response ?? {}),
          isError: false,
        });
      }
    }
  }
  return result;
}

function parseGeminiTools(value: unknown[]): IrTool[] {
  const tools: IrTool[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    for (const declaration of optionalArray(entry, "functionDeclarations") ?? []) {
      if (!isRecord(declaration)) {
        continue;
      }
      const name = readString(declaration, "name");
      const parameters = optionalRecord(declaration, "parameters");
      if (name === null || parameters === null) {
        continue;
      }
      tools.push({
        name,
        description: readString(declaration, "description"),
        inputSchema: parameters,
      });
    }
  }
  return tools;
}

function parseGeminiToolChoice(value: unknown): IrToolChoice {
  const config = isRecord(value) ? optionalRecord(value, "functionCallingConfig") : null;
  if (config === null) {
    return null;
  }
  switch (readString(config, "mode")) {
    case "AUTO":
      return "auto";
    case "ANY":
      return "required";
    case "NONE":
      return "none";
    default:
      return null;
  }
}

function buildGeminiRequestBody(request: IrRequest, _model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: request.messages.map(buildGeminiContent),
  };
  if (request.system !== null) {
    body.systemInstruction = { parts: [{ text: request.system }] };
  }
  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? undefined,
          parameters: tool.inputSchema,
        })),
      },
    ];
    if (request.toolChoice !== null) {
      body.toolConfig = {
        functionCallingConfig: { mode: geminiToolMode(request.toolChoice) },
      };
    }
  }
  const generation: Record<string, unknown> = {
    maxOutputTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (request.temperature !== null) {
    generation.temperature = request.temperature;
  }
  if (request.topP !== null) {
    generation.topP = request.topP;
  }
  if (request.stop.length > 0) {
    generation.stopSequences = request.stop;
  }
  if (request.format !== null) {
    Object.assign(generation, geminiFormat(request.format));
  }
  body.generationConfig = generation;
  return body;
}

function buildGeminiContent(message: IrMessage): Record<string, unknown> {
  return {
    role: message.role === "assistant" ? "model" : "user",
    parts: message.parts.flatMap((part) => buildGeminiPart(part)),
  };
}

function geminiImagePart(image: IrImagePart): Record<string, unknown> {
  return image.url === undefined
    ? { inlineData: { mimeType: image.mediaType, data: image.data } }
    : { fileData: { mimeType: image.mediaType, fileUri: image.url } };
}

function buildGeminiPart(part: IrPart): Record<string, unknown>[] {
  switch (part.type) {
    case "text":
      return [{ text: part.text }];
    case "image":
      return [geminiImagePart(part)];
    case "search":
    case "reasoning_item":
      return [];
    case "tool_call":
      return [
        {
          functionCall: {
            name: part.name,
            args: parseArguments(part.arguments),
          },
          // Gemini wants its signature back; a call it didn't sign itself
          // takes the value Google documents (myna's gemini_signature.go).
          thoughtSignature: part.signature ?? SKIP_SIGNATURE,
        },
      ];
    case "tool_result":
      return [
        {
          functionResponse: {
            name: part.toolCallId,
            response: parseArguments(part.content),
          },
        },
        // Gemini takes an image a tool returned as a part beside its answer.
        ...(part.images ?? []).map((image) => geminiImagePart(image)),
      ];
    case "thinking":
      return [];
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function geminiToolMode(choice: Exclude<IrToolChoice, null>): string {
  if (choice === "none") {
    return "NONE";
  }
  return choice === "auto" ? "AUTO" : "ANY";
}

function parseGeminiResponse(body: Record<string, unknown>): IrResponse {
  const candidate = firstCandidate(body);
  const parts =
    candidate === null
      ? []
      : parseGeminiParts(optionalArray(optionalRecord(candidate, "content") ?? {}, "parts") ?? []);
  const finishReason = candidate === null ? null : readString(candidate, "finishReason");
  return {
    id: readString(body, "responseId"),
    parts,
    stopReason: normalizeStopReason(
      finishReason === null ? null : finishReason.toLowerCase(),
      parts.some((part) => part.type === "tool_call"),
    ),
    usage: readGeminiUsage(optionalRecord(body, "usageMetadata")),
  };
}

function firstCandidate(body: Record<string, unknown>): Record<string, unknown> | null {
  const candidates = optionalArray(body, "candidates");
  if (candidates === null || candidates.length === 0) {
    return null;
  }
  const first = candidates[0];
  return isRecord(first) ? first : null;
}

function readGeminiUsage(value: Record<string, unknown> | null): IrUsage {
  if (value === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  return {
    inputTokens: readNumber(value, "promptTokenCount") ?? 0,
    outputTokens: readNumber(value, "candidatesTokenCount") ?? 0,
    // Gemini counts cached content in `promptTokenCount`, and thinking in
    // `thoughtsTokenCount` beside the candidates.
    ...cacheFields(
      readNumber(value, "cachedContentTokenCount") ?? 0,
      0,
      readNumber(value, "thoughtsTokenCount") ?? 0,
    ),
  };
}

function buildGeminiResponseBody(
  response: IrResponse,
  requestedModel: string,
): Record<string, unknown> {
  // A reply that cited pages says so as Gemini does: groundingMetadata with
  // the queries it ran and the span of text that cited each page.
  const grounding = new GeminiGrounding();
  let citedOffset = 0;
  for (const part of response.parts) {
    if (part.type === "search") {
      grounding.search(part.query);
    } else if (part.type === "text") {
      grounding.cite(part.text, part.citations ?? [], citedOffset);
      citedOffset += [...part.text].length;
    }
  }
  const metadata = grounding.metadata();
  return {
    candidates: [
      {
        content: { role: "model", parts: response.parts.flatMap((part) => buildGeminiPart(part)) },
        finishReason: response.stopReason === "max_tokens" ? "MAX_TOKENS" : "STOP",
        index: 0,
        ...(metadata === null ? {} : { groundingMetadata: metadata }),
      },
    ],
    usageMetadata: {
      promptTokenCount: response.usage.inputTokens,
      candidatesTokenCount: response.usage.outputTokens,
      totalTokenCount: response.usage.inputTokens + response.usage.outputTokens,
    },
    modelVersion: requestedModel,
    responseId: `resp_${randomUUID()}`,
  };
}

class GeminiStreamDecoder implements StreamDecoder {
  private readonly parser = new SseParser();
  private toolCallIndex = 0;

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
    const events: IrEvent[] = [];
    const candidate = firstCandidate(payload);
    if (candidate !== null) {
      const content = optionalRecord(candidate, "content");
      for (const part of content === null ? [] : (optionalArray(content, "parts") ?? [])) {
        events.push(...this.decodePart(part));
      }
      const finishReason = readString(candidate, "finishReason");
      if (finishReason !== null) {
        events.push({
          type: "stop",
          reason: normalizeStopReason(finishReason.toLowerCase(), false),
        });
      }
    }
    const usage = readGeminiUsage(optionalRecord(payload, "usageMetadata"));
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      events.push({ type: "usage", usage });
    }
    return events;
  }

  private decodePart(value: unknown): IrEvent[] {
    if (!isRecord(value)) {
      return [];
    }
    const text = readString(value, "text");
    if (text !== null && text.length > 0) {
      return [
        value.thought === true ? { type: "thinking_delta", text } : { type: "text_delta", text },
      ];
    }
    const functionCall = optionalRecord(value, "functionCall");
    if (functionCall === null) {
      return [];
    }
    const name = readString(functionCall, "name");
    if (name === null) {
      return [];
    }
    this.toolCallIndex += 1;
    const id = `call_${this.toolCallIndex}`;
    const args = JSON.stringify(functionCall.args ?? {});
    const signature =
      readString(value, "thoughtSignature") ?? readString(functionCall, "thoughtSignature");
    return [
      { type: "tool_call_start", id, name, ...(signature === null ? {} : { signature }) },
      { type: "tool_args_delta", id, args },
    ];
  }
}

class GeminiStreamEncoder implements StreamEncoder {
  private readonly requestedModel: string;
  private readonly responseId = `resp_${randomUUID()}`;
  private usage: IrUsage = { inputTokens: 0, outputTokens: 0 };
  private readonly toolIds = new Map<string, string>();
  private finished = false;
  /** The grounding the streamed text earns, told in the closing frame. */
  private readonly grounding = new GeminiGrounding();
  private textLength = 0;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
  }

  public replyId(): string {
    return this.responseId;
  }

  public start(): string {
    return "";
  }

  public push(event: IrEvent): string {
    switch (event.type) {
      case "text_delta": {
        if (event.text.length === 0) {
          return "";
        }
        this.grounding.cite(event.text, event.citations ?? [], this.textLength);
        this.textLength += [...event.text].length;
        return this.chunk([{ text: event.text }]);
      }
      case "search":
        this.grounding.search(event.query);
        return "";
      case "tool_call_start": {
        this.toolIds.set(event.id, event.name);
        return "";
      }
      case "tool_args_delta": {
        const name = this.toolIds.get(event.id);
        if (name === undefined) {
          return "";
        }
        return this.chunk([{ functionCall: { name, args: parseArguments(event.args) } }]);
      }
      case "stop":
        // The final usage usually follows the stop in the same reply; the
        // closing frame carries it, so it is written from `end()`.
        return "";
      case "usage":
        this.usage = event.usage;
        return "";
      case "thinking_delta":
      case "signature_delta":
      case "redacted_thinking":
      case "reasoning_item":
      case "start":
        return "";
    }
  }

  public end(): string {
    return this.finished ? "" : this.finish();
  }

  private chunk(parts: Record<string, unknown>[]): string {
    const payload = {
      candidates: [{ content: { role: "model", parts }, index: 0 }],
      modelVersion: this.requestedModel,
      responseId: this.responseId,
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private finish(): string {
    if (this.finished) {
      return "";
    }
    this.finished = true;
    const metadata = this.grounding.metadata();
    const payload = {
      candidates: [
        {
          content: { role: "model", parts: [] },
          finishReason: "STOP",
          index: 0,
          ...(metadata === null ? {} : { groundingMetadata: metadata }),
        },
      ],
      modelVersion: this.requestedModel,
      responseId: this.responseId,
      usageMetadata: {
        promptTokenCount: this.usage.inputTokens,
        candidatesTokenCount: this.usage.outputTokens,
        totalTokenCount: this.usage.inputTokens + this.usage.outputTokens,
      },
    };
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
