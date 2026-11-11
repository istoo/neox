/**
 * Tells the model that the placeholders masking put in a request stand for
 * real values that are put back before anything runs, so it uses them as
 * written instead of refusing to search with one or writing an example
 * (myna's placeholder_note.go). The note is the same on every turn and
 * says neither the gateway's nor a vendor's name, so a cached prefix stays
 * cached.
 *
 * It goes where the request's first placeholder appears, so everything
 * before that point is sent as it was: the instructions when they or the
 * tools hold one, otherwise the earliest message that does. Two paths are
 * left alone, because their request must look as its own client sent it:
 * a Claude subscription run through Claude Code, and Codex's ChatGPT
 * sign-in; and a Responses turn continuing from a stored response, where
 * a note said each turn would pile up.
 */

import type { GatewayProtocol } from "./upstream.js";

/**
 * The note masking puts in a masked request. Its example uses a letter
 * (g) that is not in this gateway's placeholder alphabet (eight hex
 * digits), so it is never taken for a placeholder or put back.
 */
export const PLACEHOLDER_NOTE =
  "Values written like {{NAME_ab12cdg4}} are placeholders for real values. " +
  "Use them exactly as written, in replies and in tool calls alike: they are filled in with the real values before anything runs. " +
  "Don't ask to verify them, and don't replace them with examples.";

/** The note as a block after the text it follows. */
const NOTE_BLOCK = `\n\n${PLACEHOLDER_NOTE}`;

/** A placeholder as `masking.ts` writes it. */
const PLACEHOLDER = /\{\{[A-Z][A-Z0-9_]*_[0-9a-fA-F]{8}\}\}/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Whether a value's text, at any depth, holds a placeholder. */
export function holdsPlaceholder(value: unknown): boolean {
  if (typeof value === "string") {
    return PLACEHOLDER.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(holdsPlaceholder);
  }
  const record = asRecord(value);
  return record !== null && Object.values(record).some(holdsPlaceholder);
}

/** The first element of a list that holds a placeholder, -1 for none. */
function earliest(items: unknown[]): number {
  return items.findIndex(holdsPlaceholder);
}

function withLine(text: string, line: string): string {
  return text === "" ? line : `${text}\n\n${line}`;
}

function isSystemRole(message: Record<string, unknown> | null): boolean {
  return message?.role === "system" || message?.role === "developer";
}

/**
 * Puts a note after the content of one message, keeping its other fields.
 * A string answer stays a string for Chat and becomes two blocks for
 * Anthropic, where a block of its own keeps it a paragraph.
 */
function withMessageNote(
  body: Record<string, unknown>,
  messages: unknown[],
  index: number,
  stringStays: boolean,
): Record<string, unknown> {
  const message = asRecord(messages[index]);
  if (message === null) {
    return body;
  }
  const content = message.content;
  let next: unknown;
  if (typeof content === "string") {
    next = stringStays
      ? withLine(content, PLACEHOLDER_NOTE)
      : [
          { type: "text", text: content },
          { type: "text", text: NOTE_BLOCK },
        ];
  } else if (Array.isArray(content)) {
    next = [...content, { type: "text", text: NOTE_BLOCK }];
  } else {
    return body;
  }
  const edited = messages.map((entry, at) =>
    at === index ? { ...message, content: next } : entry,
  );
  return { ...body, messages: edited };
}

function withNoteAnthropic(body: Record<string, unknown>): Record<string, unknown> {
  const system = body.system;
  if (holdsPlaceholder(system) || holdsPlaceholder(body.tools)) {
    if (system === undefined || system === null) {
      return { ...body, system: PLACEHOLDER_NOTE };
    }
    if (typeof system === "string") {
      return { ...body, system: withLine(system, PLACEHOLDER_NOTE) };
    }
    if (Array.isArray(system)) {
      return { ...body, system: [...system, { type: "text", text: NOTE_BLOCK }] };
    }
    return body;
  }
  const messages = asArray(body.messages);
  if (messages === null) {
    return body;
  }
  const index = earliest(messages);
  return index < 0 ? body : withMessageNote(body, messages, index, false);
}

function withNoteChat(body: Record<string, unknown>): Record<string, unknown> {
  const messages = asArray(body.messages);
  if (messages === null) {
    return body;
  }
  let index = earliest(messages);
  if (holdsPlaceholder(body.tools) || (index >= 0 && isSystemRole(asRecord(messages[index])))) {
    // The instructions: the first system (or developer) message, or one
    // of the note's own.
    index = messages.findIndex((entry) => isSystemRole(asRecord(entry)));
    if (index < 0) {
      return {
        ...body,
        messages: [{ role: "system", content: PLACEHOLDER_NOTE }, ...messages],
      };
    }
  }
  return index < 0 ? body : withMessageNote(body, messages, index, true);
}

function developerMessage(): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: PLACEHOLDER_NOTE }],
  };
}

function withNoteResponses(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input;
  if (typeof input === "string") {
    return {
      ...body,
      input: [developerMessage(), { role: "user", content: input }],
    };
  }
  const items = asArray(input);
  if (items === null) {
    return body;
  }
  if (holdsPlaceholder(body.instructions) || holdsPlaceholder(body.tools)) {
    return { ...body, input: [developerMessage(), ...items] };
  }
  let index = earliest(items);
  if (index < 0) {
    return body;
  }
  // A call's run of outputs stays whole: the note goes after it.
  while (index + 1 < items.length) {
    const next = asRecord(items[index + 1]);
    if (typeof next?.type !== "string" || !next.type.endsWith("_call_output")) {
      break;
    }
    index += 1;
  }
  return {
    ...body,
    input: [...items.slice(0, index + 1), developerMessage(), ...items.slice(index + 1)],
  };
}

function withNoteGemini(body: Record<string, unknown>): Record<string, unknown> {
  for (const key of ["systemInstruction", "system_instruction"]) {
    const instruction = body[key];
    if (instruction === undefined || instruction === null) {
      continue;
    }
    if (!holdsPlaceholder(instruction) && !holdsPlaceholder(body.tools)) {
      break;
    }
    const record = asRecord(instruction);
    const parts = asArray(record?.parts);
    if (record !== null && parts !== null) {
      return { ...body, [key]: { ...record, parts: [...parts, { text: NOTE_BLOCK }] } };
    }
    return body;
  }
  if (holdsPlaceholder(body.tools)) {
    return {
      ...body,
      systemInstruction: { parts: [{ text: PLACEHOLDER_NOTE }] },
    };
  }
  const contents = asArray(body.contents);
  if (contents === null) {
    return body;
  }
  const index = earliest(contents);
  if (index < 0) {
    return body;
  }
  const content = asRecord(contents[index]);
  const parts = asArray(content?.parts);
  if (content === null || parts === null) {
    return body;
  }
  const edited: unknown[] = [];
  contents.forEach((entry, at) => {
    edited.push(at === index ? { ...content, parts: [...parts, { text: NOTE_BLOCK }] } : entry);
  });
  return { ...body, contents: edited };
}

/**
 * A request body told about its placeholders, when masking wrote one and
 * the way it goes out allows it; the same body, untouched, otherwise.
 */
export function withPlaceholderNote(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
  provider: { agent?: string } = {},
): Record<string, unknown> {
  if (provider.agent === "claude-code" || provider.agent === "chatgpt-api") {
    return body;
  }
  if (
    protocol === "openai-responses" &&
    typeof body.previous_response_id === "string" &&
    body.previous_response_id !== ""
  ) {
    return body;
  }
  if (!holdsPlaceholder(body)) {
    return body;
  }
  switch (protocol) {
    case "anthropic":
      return withNoteAnthropic(body);
    case "openai":
      return withNoteChat(body);
    case "openai-responses":
      return withNoteResponses(body);
    case "gemini":
      return withNoteGemini(body);
    default:
      return body;
  }
}
