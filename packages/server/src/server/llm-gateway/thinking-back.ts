/**
 * DeepSeek and Kimi in thinking mode demand an earlier tool turn's
 * reasoning back; a client that keeps none (Claude Code on a relay, a
 * Chat agent whose history lost the field) gets a 400 instead of an
 * answer. The refusal is learned per provider, model and API, and the
 * turns are filled with what myna fills them with: a single space.
 */

/** A model asking for an earlier turn's thinking back. */
const THINKING_BACK =
  /`?(?:content\[\]\.thinking|reasoning_content)`? in the thinking mode must be passed back/i;
const REASONING_BACK =
  /\breasoning_content\b[^"]{0,40}\b(?:is (?:missing|required)|must be (?:passed|provided|included))|\b(?:missing|required)\b[^"]{0,80}\breasoning_content\b/i;

/** What myna puts in a tool turn's reasoning. */
const NO_REASONING = " ";

export function refusedThinkingBack(message: string): boolean {
  return THINKING_BACK.test(message) || REASONING_BACK.test(message);
}

const needed = new Set<string>();

function key(providerId: string, model: string, protocol: string): string {
  return `${providerId}\u0000${model}\u0000${protocol}`;
}

/** Remembers that this provider's model asks for its thinking back here. */
export function markNeedsThinkingBack(providerId: string, model: string, protocol: string): void {
  needed.add(key(providerId, model, protocol));
}

export function needsThinkingBack(providerId: string, model: string, protocol: string): boolean {
  return needed.has(key(providerId, model, protocol));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A body with a filler reasoning on each tool turn that carries none. */
export function fillThinkingBack(
  protocol: string,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; changed: boolean } {
  if (protocol === "anthropic") {
    return fillAnthropic(body);
  }
  if (protocol === "openai") {
    return fillChat(body);
  }
  return { body, changed: false };
}

function fillAnthropic(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let changed = false;
  const filled = [...messages];
  for (let index = 0; index < filled.length; index += 1) {
    const message = isRecord(filled[index]) ? (filled[index] as Record<string, unknown>) : null;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const blocks = message.content.filter(isRecord);
    if (!blocks.some((block) => block.type === "tool_use" || block.type === "server_tool_use")) {
      continue;
    }
    if (blocks.some((block) => block.type === "thinking" || block.type === "redacted_thinking")) {
      continue;
    }
    changed = true;
    filled[index] = {
      ...message,
      content: [{ type: "thinking", thinking: NO_REASONING }, ...message.content],
    };
  }
  return changed ? { body: { ...body, messages: filled }, changed } : { body, changed };
}

function fillChat(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let changed = false;
  const filled = [...messages];
  for (let index = 0; index < filled.length; index += 1) {
    const message = isRecord(filled[index]) ? (filled[index] as Record<string, unknown>) : null;
    if (message === null || message.role !== "assistant") {
      continue;
    }
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      continue;
    }
    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
      continue;
    }
    changed = true;
    const next: Record<string, unknown> = { ...message, reasoning_content: NO_REASONING };
    // A server that reads reasoning and reasoning_content as one field
    // turns a message with both away.
    delete next.reasoning;
    filled[index] = next;
  }
  return changed ? { body: { ...body, messages: filled }, changed } : { body, changed };
}
