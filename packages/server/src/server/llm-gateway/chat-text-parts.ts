/**
 * A relayed Chat request whose message content is a list of plain text
 * parts is sent with the string the parts say, because a vendor's own
 * OpenAI-compatible server may take a string alone and turn the list away
 * (myna's chat_text_parts.go). Only a list whose every part is exactly
 * `{"type":"text","text":"…"}` is joined, with a newline between parts, as
 * vLLM's chat template renders one; a part with an image, a file, a
 * thinking part or a cache mark keeps the list as it is.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The text of a list of plain text parts, or null for any other list. */
function plainTextParts(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const texts: string[] = [];
  for (const entry of value) {
    const part = asRecord(entry);
    if (part === null) {
      return null;
    }
    const keys = Object.keys(part);
    if (keys.length !== 2 || part.type !== "text" || typeof part.text !== "string") {
      return null;
    }
    texts.push(part.text);
  }
  return texts.join("\n");
}

/**
 * The body with each plain text-part list joined into a string; the same
 * body, untouched, when it has none.
 */
export function chatTextParts<T extends Record<string, unknown>>(body: T): T {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages === null) {
    return body;
  }
  let changed = false;
  const edited: unknown[] = [];
  for (const entry of messages) {
    const message = asRecord(entry);
    const text = message === null ? null : plainTextParts(message.content);
    if (message === null || text === null) {
      edited.push(entry);
      continue;
    }
    changed = true;
    edited.push({ ...message, content: text });
  }
  return changed ? { ...body, messages: edited } : body;
}
