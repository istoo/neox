/**
 * Claude's signed reasoning through a Responses client: Claude signs each
 * thinking block and Anthropic wants it back as it came on the next turn
 * of a tool loop. A Responses client keeps only what a reply's reasoning
 * items carry, and only encrypted_content is opaque, so the block goes
 * there, base64'd under this gateway's mark. A Responses upstream would
 * refuse it as invalid_encrypted_content, so it is dropped before one
 * (myna's claude_seal.go).
 */
import type { IrPart } from "./ir.js";

// The mark sealed blocks carry.
const MARK = "neolix-claude1:";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The encrypted_content carrying Claude's thinking block, signature and all. */
export function sealThinking(text: string, signature: string): string {
  const block = { type: "thinking", thinking: text, signature };
  return MARK + Buffer.from(JSON.stringify(block), "utf8").toString("base64");
}

/** Whether encrypted_content is one this gateway sealed. */
export function isClaudeSeal(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MARK);
}

/** The thinking block an encrypted_content carries, or null for another's. */
export function openSealedThinking(encrypted: unknown): { text: string; signature: string } | null {
  if (!isClaudeSeal(encrypted)) {
    return null;
  }
  try {
    const block: unknown = JSON.parse(
      Buffer.from(String(encrypted).slice(MARK.length), "base64").toString("utf8"),
    );
    if (
      !isRecord(block) ||
      block.type !== "thinking" ||
      typeof block.thinking !== "string" ||
      typeof block.signature !== "string" ||
      block.signature.length === 0
    ) {
      return null;
    }
    return { text: block.thinking, signature: block.signature };
  } catch {
    return null;
  }
}

/** The reasoning item a signed thinking part travels in. */
export function reasoningItem(text: string, signature: string, id: string): Json {
  return {
    id,
    type: "reasoning",
    status: "completed",
    summary: text.length > 0 ? [{ type: "summary_text", text }] : [],
    encrypted_content: sealThinking(text, signature),
  };
}

/** The text a reasoning item says, its own reasoning first, else its summary. */
function reasoningText(item: Json): string {
  let text = "";
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string") {
      text += part.text;
    }
  }
  if (text.length > 0) {
    return text;
  }
  for (const part of Array.isArray(item.summary) ? item.summary : []) {
    if (isRecord(part) && typeof part.text === "string") {
      text += part.text;
    }
  }
  return text;
}

/** The thinking a Responses reasoning item stands for, with Claude's signature. */
export function thinkingOfReasoningItem(item: Json): IrPart | null {
  const sealed = openSealedThinking(item.encrypted_content);
  if (sealed !== null) {
    return { type: "thinking", text: sealed.text, signature: sealed.signature };
  }
  const text = reasoningText(item);
  return text.length > 0 ? { type: "thinking", text } : null;
}

/**
 * A Responses request without Claude's sealed blocks: an item keeps its
 * summary, as it was before the block was carried; one with none goes.
 * Every other item, and a body with none, goes as it came.
 */
export function withoutClaudeSeals(body: Json): Json {
  if (!Array.isArray(body.input)) {
    return body;
  }
  let changed = false;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isRecord(item) || item.type !== "reasoning" || !isClaudeSeal(item.encrypted_content)) {
      input.push(item);
      continue;
    }
    changed = true;
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const content = Array.isArray(item.content) ? item.content : [];
    if (summary.length === 0 && content.length === 0) {
      continue;
    }
    const kept = { ...item };
    delete kept.encrypted_content;
    input.push(kept);
  }
  return changed ? { ...body, input } : body;
}
