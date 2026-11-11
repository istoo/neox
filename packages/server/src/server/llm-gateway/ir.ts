import type { IrFormat } from "./format.js";

export type IrRole = "user" | "assistant";

export interface IrImagePart {
  type: "image";
  mediaType: string;
  data: string;
  /** Where it lives, when it wasn't sent inline; data is then empty. */
  url?: string;
}

export interface IrSearchPage {
  title: string;
  url: string;
  age?: string;
  /** What the search said of the page; a citation quotes it (never sent). */
  text?: string;
}

/** A page citation as Anthropic's own web search reports it. */
export interface IrCitation {
  type: "web_search_result_location";
  url: string;
  title: string;
  /** Anthropic's sealed pointer into its own result; empty when made here. */
  encrypted_index: string;
  cited_text: string;
}

export type IrPart =
  | { type: "text"; text: string; citations?: IrCitation[] }
  | {
      type: "thinking";
      text: string;
      /** Anthropic's signature, when the vendor wrote one. */ signature?: string;
      /**
       * Anthropic's redacted_thinking block, base64, when the vendor hid
       * the reasoning: no vendor but Anthropic's takes it back.
       */
      redacted?: string;
    }
  | IrImagePart
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
      /** Gemini's thought signature, when the vendor signed the call. */
      signature?: string;
      /**
       * A Responses upstream's reasoning items this step made before the
       * call, carried by the call's id for a client that keeps none.
       */
      reasoning?: Record<string, unknown>[];
    }
  | {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
      /**
       * Images the tool returned. They are kept apart from the text so a
       * translation into another protocol, and image recognition, see them.
       */
      images?: IrImagePart[];
      /**
       * The tools an Anthropic client's ToolSearch loaded here, by name
       * (myna's Part.Loads): a Responses upstream that loads tools in place
       * is offered them after this result.
       */
      loads?: string[];
    }
  | { type: "search"; query: string; pages: IrSearchPage[] }
  | { type: "reasoning_item"; item: Record<string, unknown> };

export interface IrMessage {
  role: IrRole;
  parts: IrPart[];
}

export interface IrTool {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
  /**
   * The client marked the tool `defer_loading`: Claude Code's ToolSearch
   * offers it from where a result loaded it, not from the start (myna's
   * Tool.Deferred).
   */
  deferred?: boolean;
}

export type IrToolChoice = "auto" | "none" | "required" | { name: string } | null;

export interface IrRequest {
  system: string | null;
  messages: IrMessage[];
  tools: IrTool[];
  toolChoice: IrToolChoice;
  /** The structured output the client asked for, null when it asked for none. */
  format: IrFormat | null;
  maxTokens: number | null;
  temperature: number | null;
  topP: number | null;
  stop: string[];
  stream: boolean;
  /**
   * A Responses upstream that takes an `additional_tools` item where a
   * result loaded a deferred tool, instead of moving it into the top-level
   * tools (myna's Request.LoadedInPlace). The request path sets it from the
   * target provider; a client body never carries it.
   */
  loadedInPlace?: boolean;
}

export type IrStopReason = "end_turn" | "max_tokens" | "tool_use" | "stop";

export interface IrUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Prompt tokens the vendor served from its cache, and tokens written to it.
   * Whether they are part of `inputTokens` is the vendor's: Anthropic reports
   * them apart, the OpenAI and Gemini shapes count cache reads in the prompt.
   * The usage report reads `upstreamProtocol` to tell the two apart.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Of `cacheWriteTokens`, the ones the vendor kept for an hour (Anthropic's
   * 1-hour cache TTL), billed at its own price.
   */
  cacheWrite1hTokens?: number;
  /** Reasoning tokens, for the vendors that count them inside the output. */
  reasoningTokens?: number;
  /** The credits a vendor billed (WorkBuddy's `usage.credit`). */
  credits?: number;
}

/** The cache and reasoning counts a vendor reported, and only those it reported. */
export function cacheFields(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  reasoningTokens: number | undefined,
): Pick<IrUsage, "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"> {
  return {
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(reasoningTokens === undefined || reasoningTokens <= 0 ? {} : { reasoningTokens }),
  };
}

export interface IrResponse {
  id: string | null;
  parts: IrPart[];
  stopReason: IrStopReason;
  usage: IrUsage;
  /** The tier the vendor served on ("default", "flex", "priority", Anthropic's
   * speed), when it said (myna's TierServed). */
  tierServed?: string;
}

export type IrEvent =
  | { type: "start"; id: string | null }
  | { type: "text_delta"; text: string; citations?: IrCitation[] }
  | { type: "thinking_delta"; text: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "signature_delta"; signature: string }
  | { type: "tool_call_start"; id: string; name: string; signature?: string }
  | { type: "tool_args_delta"; id: string; args: string }
  | { type: "search"; query: string; pages: IrSearchPage[] }
  | { type: "reasoning_item"; item: Record<string, unknown> }
  | { type: "usage"; usage: IrUsage }
  | { type: "stop"; reason: IrStopReason };

export function normalizeStopReason(value: string | null, sawToolCall: boolean): IrStopReason {
  if (value === "tool_calls" || value === "tool_use") {
    return "tool_use";
  }
  if (value === "length" || value === "max_tokens") {
    return "max_tokens";
  }
  if (value === "stop_sequence") {
    return "stop";
  }
  return sawToolCall ? "tool_use" : "end_turn";
}

export function emptyRequest(): IrRequest {
  return {
    system: null,
    messages: [],
    tools: [],
    toolChoice: null,
    format: null,
    maxTokens: null,
    temperature: null,
    topP: null,
    stop: [],
    stream: false,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function optionalRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  return assertRecord(value, key);
}

export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

export function optionalArray(record: Record<string, unknown>, key: string): unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}
