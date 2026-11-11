/**
 * Gemini's OpenAI-compatible API gives a call's thought signature beside
 * it, in tool_calls[].extra_content.google.thought_signature, and takes it
 * back there (myna's gemini_signature.go). A Chat client carries the
 * signature in the call's id, so a Chat body bound to that API is mended
 * before it goes: the id loses the signature, and the signature moves to
 * extra_content.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a provider's base URL is Gemini's OpenAI-compatible API. */
export function isGeminiCompat(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

/** A Chat body with no Gemini signature in its call ids, for any other API. */
export function withoutCallSignatures(
  body: Json,
  unsigned: (id: string) => { id: string; signature: string | null },
): Json {
  if (!Array.isArray(body.messages)) {
    return body;
  }
  let changed = false;
  const messages = body.messages.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    let next = entry;
    if (Array.isArray(entry.tool_calls)) {
      const calls = entry.tool_calls.map((call) => {
        if (!isRecord(call) || typeof call.id !== "string") {
          return call;
        }
        const split = unsigned(call.id);
        if (split.signature === null) {
          return call;
        }
        changed = true;
        return { ...call, id: split.id };
      });
      next = { ...next, tool_calls: calls };
    }
    if (typeof next.tool_call_id === "string") {
      const split = unsigned(next.tool_call_id);
      if (split.signature !== null) {
        next = { ...next, tool_call_id: split.id };
        changed = true;
      }
    }
    return next;
  });
  return changed ? { ...body, messages } : body;
}

/** A Chat body with Gemini's call signatures back in extra_content. */
export function withGeminiCallSignatures(
  body: Json,
  unsigned: (id: string) => { id: string; signature: string | null },
): Json {
  if (!Array.isArray(body.messages)) {
    return body;
  }
  let changed = false;
  const messages = body.messages.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const next: Json = { ...entry };
    if (Array.isArray(next.tool_calls)) {
      next.tool_calls = next.tool_calls.map((call) => {
        if (!isRecord(call) || typeof call.id !== "string") {
          return call;
        }
        const split = unsigned(call.id);
        if (split.signature === null) {
          return call;
        }
        changed = true;
        return {
          ...call,
          id: split.id,
          extra_content: { google: { thought_signature: split.signature } },
        };
      });
    }
    if (typeof next.tool_call_id === "string") {
      const split = unsigned(next.tool_call_id);
      if (split.signature !== null) {
        next.tool_call_id = split.id;
        changed = true;
      }
    }
    return next;
  });
  return changed ? { ...body, messages } : body;
}
