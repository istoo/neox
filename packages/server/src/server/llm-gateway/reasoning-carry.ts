/**
 * A Responses upstream's sealed reasoning across a client of another API.
 * A model that reasons between tool calls reads the step's reasoning back
 * on the next request; Grok Build sends every reasoning item it was given,
 * encrypted_content and all, before the calls it led to. A Messages, Chat
 * or Gemini client keeps no such item, so each step of its tool loop would
 * reach the upstream with none of the reasoning that made the calls
 * before it.
 *
 * The items that come before a step's first call ride in that call's id,
 * and come off it on the way back, in front of the assistant turn that
 * made the call (myna's reasoning_carry.go). They are kept under a short
 * key in the gateway's folder and the id carries that key
 * (`<id>__rck16__<key>`); a key no longer kept reads as no reasoning.
 * Without a folder (a test), short items ride inline instead.
 */
import type { IrEvent, IrPart } from "./ir.js";
import { keptValue, keepValue } from "./sigstore.js";

const MARK = "__rc";
const END = "__";
/** The most items an id carries; a step with more goes as it came. */
const MAX_INLINE = 4000;

type Json = Record<string, unknown>;

/** The suffix an id carries for these items, or none when they can't travel. */
export function reasoningIdSuffix(items: readonly Json[]): string {
  if (items.length === 0) {
    return "";
  }
  const json = JSON.stringify(items);
  const key = keepValue(json);
  if (key !== null) {
    return `${MARK}k${key.length}${END}${key}`;
  }
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return encoded.length > MAX_INLINE ? "" : `${MARK}${encoded.length}${END}${encoded}`;
}

/** The call's own id and the reasoning items its id carries. */
export function takeReasoning(id: string): { id: string; items: Json[] } {
  for (let from = 1; from < id.length; ) {
    const found = id.indexOf(MARK, from);
    if (found < 0) {
      break;
    }
    from = found + 1;
    const rest = id.slice(found + MARK.length);
    const kept = rest.startsWith("k");
    const afterKind = kept ? rest.slice(1) : rest;
    let digits = 0;
    while (digits < afterKind.length && afterKind[digits] >= "0" && afterKind[digits] <= "9") {
      digits += 1;
    }
    const encoded = afterKind.slice(digits);
    if (!encoded.startsWith(END)) {
      continue;
    }
    const body = encoded.slice(END.length);
    // A cut id leaves a partial item body, which is no reasoning.
    if (digits === 0 || afterKind.slice(0, digits) !== String(body.length) || body.length === 0) {
      return { id, items: [] };
    }
    const text = kept ? keptValue(body) : Buffer.from(body, "base64url").toString("utf8");
    if (text === null) {
      return { id, items: [] };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every(isRecord)) {
        return { id: id.slice(0, found), items: parsed };
      }
    } catch {
      // Not ours after all.
    }
    return { id, items: [] };
  }
  return { id, items: [] };
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a provider is a Responses API that asks its reasoning back (Grok's). */
export function isGrokLike(provider: {
  baseUrl: string;
  models: readonly { id: string }[];
}): boolean {
  try {
    if (new URL(provider.baseUrl).host.endsWith("x.ai")) {
      return true;
    }
  } catch {
    // A base URL that isn't one names no host.
  }
  return provider.models.some((model) => model.id.toLowerCase().includes("grok"));
}

/** A Responses body asking for the reasoning encrypted, so it can ride back. */
export function withSealedReasoning(body: Json): Json {
  const include = Array.isArray(body.include)
    ? body.include.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (include.includes("reasoning.encrypted_content")) {
    return body;
  }
  return { ...body, include: [...include, "reasoning.encrypted_content"] };
}

/** A whole reply with each step's reasoning in the id of its first call. */
export function packResponseReasoning<T extends { parts: IrPart[] }>(response: T): T {
  const parts: IrPart[] = [];
  let held: Json[] = [];
  let changed = false;
  for (const part of response.parts) {
    if (part.type === "reasoning_item") {
      held.push(part.item);
      changed = true;
      continue;
    }
    if (part.type === "tool_call" && held.length > 0) {
      const suffix = reasoningIdSuffix(held);
      if (suffix.length > 0) {
        parts.push({ ...part, id: `${part.id}${suffix}`, reasoning: held });
        held = [];
        changed = true;
        continue;
      }
      held = [];
    }
    parts.push(part);
  }
  return changed ? { ...response, parts } : response;
}

/**
 * One streamed reply: the reasoning items are held until the step's first
 * call names them, and dropped when no call follows.
 */
export class ReasoningCarry {
  private held: Json[] = [];
  private readonly renamed = new Map<string, string>();

  public event(event: IrEvent): IrEvent {
    if (event.type === "reasoning_item") {
      this.held.push(event.item);
      return event;
    }
    if (event.type === "tool_call_start") {
      const suffix = reasoningIdSuffix(this.held);
      this.held = [];
      if (suffix.length === 0) {
        return event;
      }
      const id = `${event.id}${suffix}`;
      this.renamed.set(event.id, id);
      return { ...event, id };
    }
    if (event.type === "tool_args_delta") {
      const id = this.renamed.get(event.id);
      return id === undefined ? event : { ...event, id };
    }
    if (event.type === "stop") {
      this.held = [];
    }
    return event;
  }
}
