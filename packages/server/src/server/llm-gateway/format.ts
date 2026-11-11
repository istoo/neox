import type { IrRequest, IrResponse } from "./ir.js";

/** Structured output as a client asked for it (myna's Format). */
export interface IrFormat {
  type: "json_schema" | "json_object";
  name: string;
  description?: string;
  schema?: unknown;
  strict?: boolean;
}

const DEFAULT_NAME = "response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasSchema(value: unknown): boolean {
  return isRecord(value);
}

/** OpenAI's APIs read a schema of no shape as any JSON object. */
function openAiHasSchema(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0;
}

/** Chat's response_format or Responses' text.format. */
export function parseOpenAiFormat(raw: unknown): IrFormat | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = readString(raw.type);
  if (type === "json_object") {
    return { type: "json_object", name: DEFAULT_NAME };
  }
  if (type !== "json_schema") {
    return null;
  }
  const inner = isRecord(raw.json_schema) ? raw.json_schema : raw;
  if (!openAiHasSchema(inner.schema)) {
    return { type: "json_object", name: DEFAULT_NAME };
  }
  return {
    type: "json_schema",
    name: readString(inner.name) ?? DEFAULT_NAME,
    ...(readString(inner.description) === null
      ? {}
      : { description: readString(inner.description) ?? "" }),
    schema: inner.schema,
    ...(typeof inner.strict === "boolean" ? { strict: inner.strict } : {}),
  };
}

/** Anthropic's output_config.format. */
export function parseAnthropicFormat(raw: unknown): IrFormat | null {
  if (!isRecord(raw) || raw.type !== "json_schema" || !hasSchema(raw.schema)) {
    return null;
  }
  return { type: "json_schema", name: DEFAULT_NAME, schema: raw.schema };
}

/** Gemini's generationConfig.responseMimeType with its schema. */
export function parseGeminiFormat(generationConfig: unknown): IrFormat | null {
  if (!isRecord(generationConfig) || generationConfig.responseMimeType !== "application/json") {
    return null;
  }
  const schema = generationConfig.responseSchema;
  if (!hasSchema(schema)) {
    return { type: "json_object", name: DEFAULT_NAME };
  }
  return { type: "json_schema", name: DEFAULT_NAME, schema };
}

/** The format as Chat's response_format says it. */
export function chatFormat(format: IrFormat): Record<string, unknown> {
  if (format.type !== "json_schema" || format.schema === undefined) {
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.description === undefined ? {} : { description: format.description }),
      ...(format.strict === undefined ? {} : { strict: format.strict }),
    },
  };
}

/** The format as Responses' text.format says it. */
export function responsesFormat(format: IrFormat): Record<string, unknown> {
  if (format.type !== "json_schema" || format.schema === undefined) {
    return { type: "json_object" };
  }
  return {
    type: "json_schema",
    name: format.name,
    schema: format.schema,
    ...(format.description === undefined ? {} : { description: format.description }),
    ...(format.strict === undefined ? {} : { strict: format.strict }),
  };
}

/** Anthropic's field; any JSON object is told in words instead. */
export function anthropicFormat(format: IrFormat): Record<string, unknown> | null {
  if (format.type !== "json_schema" || format.schema === undefined) {
    return null;
  }
  return { type: "json_schema", schema: format.schema };
}

/** Gemini's generationConfig fields. */
export function geminiFormat(format: IrFormat): Record<string, unknown> {
  if (format.type !== "json_schema" || format.schema === undefined) {
    return { responseMimeType: "application/json" };
  }
  return { responseMimeType: "application/json", responseSchema: format.schema };
}

/** The format said in words, for an API that can't be asked for it. */
export function formatInstruction(format: IrFormat): string {
  if (format.type === "json_schema" && format.schema !== undefined) {
    return `Respond with a single JSON value and nothing else, matching this JSON schema:\n${JSON.stringify(format.schema)}.`;
  }
  return "Respond with a single JSON object and nothing else.";
}

/** A request with the format told in its system prompt (Anthropic's object case). */
export function formatInSystem(request: IrRequest): IrRequest {
  const format = request.format;
  if (format === null) {
    return request;
  }
  const line = formatInstruction(format);
  return {
    ...request,
    format: null,
    system:
      request.system === null || request.system.length === 0
        ? line
        : `${request.system}\n\n${line}`,
  };
}

/** A whole JSON value inside an unlabelled or json-labelled fence, unwrapped. */
export function unfence(text: string): { text: string; fenced: boolean } {
  const trimmed = text.trim();
  if (trimmed.length < 6 || !trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return { text, fenced: false };
  }
  const newline = trimmed.indexOf("\n");
  if (newline < 0) {
    return { text, fenced: false };
  }
  const tag = trimmed.slice(3, newline).trim();
  if (tag.length > 0 && tag.toLowerCase() !== "json") {
    return { text, fenced: false };
  }
  const inner = trimmed.slice(newline + 1, -3).trim();
  try {
    JSON.parse(inner);
  } catch {
    return { text, fenced: false };
  }
  return { text: inner, fenced: true };
}

/** An answer's fenced text taken off, for a client that asked for structured output. */
export function unfenceResponse(response: IrResponse): IrResponse {
  let changed = false;
  const parts = response.parts.map((part) => {
    if (part.type !== "text") {
      return part;
    }
    const { text, fenced } = unfence(part.text);
    if (!fenced) {
      return part;
    }
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...response, parts } : response;
}

/** An answer's fenced text taken off, for a client that asked for structured output. */
export function unfenceParts<T extends { parts: Array<{ type: string; text?: string }> }>(
  response: T,
): T {
  let changed = false;
  const parts = response.parts.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") {
      return part;
    }
    const { text, fenced } = unfence(part.text);
    if (!fenced) {
      return part;
    }
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...response, parts } : response;
}

/**
 * Holds a structured answer's text while it could still be a fence's
 * start, so the client never sees the fence; once it begins otherwise the
 * text passes on as it comes, and a fenced answer goes on whole.
 */
export class FenceHold {
  private held = "";
  private holding = false;
  private past = false;

  public push(text: string): string {
    if (this.past) {
      return text;
    }
    this.held += text;
    const lead = this.held.replace(/^[ \t\r\n]+/, "");
    if (lead.length === 0 || lead.startsWith("```") || "```".startsWith(lead)) {
      this.holding = true;
      return "";
    }
    this.past = true;
    this.holding = false;
    const out = this.held;
    this.held = "";
    return out;
  }

  public flush(): string {
    if (!this.holding) {
      return "";
    }
    this.holding = false;
    this.past = true;
    const out = unfence(this.held).text;
    this.held = "";
    return out;
  }
}

/** Whether a client's body asked for structured output. */
export function wantsStructuredOutput(protocol: string, body: Record<string, unknown>): boolean {
  switch (protocol) {
    case "openai":
      return parseOpenAiFormat(body.response_format) !== null;
    case "openai-responses":
      return parseOpenAiFormat(isRecord(body.text) ? body.text.format : undefined) !== null;
    case "anthropic":
      return (
        parseAnthropicFormat(
          isRecord(body.output_config) ? body.output_config.format : undefined,
        ) !== null
      );
    case "gemini":
      return parseGeminiFormat(body.generationConfig) !== null;
    default:
      return false;
  }
}
