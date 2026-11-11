/**
 * Claude Code keeps every tool_use id of a session in one Set and drops a
 * block whose id it has already seen. An upstream that numbers its calls
 * by their place in the reply (LiteLLM's bridge: fc_0 on every turn) makes
 * the same id come again on the next turn, and every later call of the
 * session is lost (#4910).
 *
 * A reply's tool_use id the client already holds, or one the same reply
 * said before, goes out under the mark: the upstream's id, a NUL and a
 * fresh salt, base64url'd. Nothing the client holds names it. The answer
 * comes back under the salted id and is given to the upstream as the id it
 * made (myna's tool_use_ids.go).
 */
import type { IrEvent, IrPart, IrResponse } from "./ir.js";

const MARK = "mp_";
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A tool_use id for a Messages client, salted so no two replies make it alike. */
export function saltToolUseId(id: string, salt: string): string {
  return MARK + Buffer.from(`${id}\u0000${salt}`, "utf8").toString("base64url");
}

/** The id a salted tool_use id was made from, if it is one. */
export function unsaltToolUseId(id: string): string | null {
  if (!id.startsWith(MARK) || !SAFE_ID.test(id)) {
    return null;
  }
  const raw = Buffer.from(id.slice(MARK.length), "base64url");
  const at = raw.indexOf(0);
  if (at <= 0 || at === raw.length - 1 || !raw.subarray(at + 1).length) {
    return null;
  }
  const text = raw.toString("utf8");
  return text.includes("�") ? null : text.slice(0, at);
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freshSalt(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

/** Every tool_use id a client's request holds, as its own protocol names them. */
export function clientCallIds(request: IrRequestLike): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call" && part.id.length > 0) {
        ids.push(part.id);
      }
    }
  }
  return ids;
}

interface IrRequestLike {
  messages: Array<{ parts: IrPart[] }>;
}

/**
 * One reply's ids: an id the client holds, or this reply has said, is
 * salted. The rest goes as it came, so an upstream whose ids are its own
 * is relayed byte for byte.
 */
export class ToolUseIds {
  private readonly seen: Set<string>;
  private readonly renamed = new Map<string, string>();
  private decoder: TextDecoder | null = null;
  private buffer = "";

  constructor(ids: Iterable<string>) {
    this.seen = new Set(ids);
  }

  /** The id this reply may say: itself the first time, salted after. */
  private idFor(id: string): string {
    if (!this.seen.has(id)) {
      this.seen.add(id);
      return id;
    }
    const salted = saltToolUseId(id, freshSalt());
    this.seen.add(salted);
    return salted;
  }

  /** One IR event, its call's id salted when the client has seen it. */
  event(event: IrEvent): IrEvent {
    if (event.type === "tool_call_start") {
      const id = this.idFor(event.id);
      this.renamed.set(event.id, id);
      return id === event.id ? event : { ...event, id };
    }
    if (event.type === "tool_args_delta") {
      const id = this.renamed.get(event.id);
      return id === undefined || id === event.id ? event : { ...event, id };
    }
    return event;
  }

  /** A whole reply's parts, each call's id salted when the client has seen it. */
  response<T extends IrResponse>(response: T): T {
    if (!response.parts.some((part) => part.type === "tool_call")) {
      return response;
    }
    return {
      ...response,
      parts: response.parts.map((part) =>
        part.type === "tool_call" ? { ...part, id: this.idFor(part.id) } : part,
      ),
    };
  }

  /** A Messages reply relayed as it came: its content blocks' call ids. */
  json(value: Json): Json {
    if (!Array.isArray(value.content)) {
      return value;
    }
    let changed = false;
    const content = value.content.map((block) => {
      if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") {
        return block;
      }
      const id = this.idFor(block.id);
      if (id === block.id) {
        return block;
      }
      changed = true;
      return { ...block, id };
    });
    return changed ? { ...value, content } : value;
  }

  /**
   * A relayed stream's bytes, one SSE event at a time: a content_block_start
   * naming a tool_use the client has seen goes out salted.
   */
  write(chunk: Uint8Array): Uint8Array {
    this.decoder ??= new TextDecoder();
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  flush(): Uint8Array {
    const rest = this.buffer;
    this.buffer = "";
    if (rest.length === 0) {
      return new Uint8Array();
    }
    return Buffer.from(this.saltEventBlock(rest), "utf8");
  }

  private drain(): Uint8Array {
    const events: string[] = [];
    let start = 0;
    for (;;) {
      const end = this.buffer.indexOf("\n\n", start);
      if (end < 0) {
        break;
      }
      events.push(this.buffer.slice(start, end + 2));
      start = end + 2;
    }
    if (start > 0) {
      this.buffer = this.buffer.slice(start);
    }
    return Buffer.from(events.map((event) => this.saltEventBlock(event)).join(""), "utf8");
  }

  private saltEventBlock(block: string): string {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.startsWith("data:"));
    if (at < 0) {
      return block;
    }
    const data = lines[at]?.slice("data:".length).trim() ?? "";
    if (!data.includes('"content_block_start"') || !data.includes('"tool_use"')) {
      return block;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return block;
    }
    if (
      !isRecord(parsed) ||
      parsed.type !== "content_block_start" ||
      !isRecord(parsed.content_block) ||
      parsed.content_block.type !== "tool_use" ||
      typeof parsed.content_block.id !== "string"
    ) {
      return block;
    }
    const id = this.idFor(parsed.content_block.id);
    if (id === parsed.content_block.id) {
      return block;
    }
    lines[at] =
      `data: ${JSON.stringify({ ...parsed, content_block: { ...parsed.content_block, id } })}`;
    return lines.join("\n");
  }
}

/** A block with its salted call ids given back, or itself when it had none. */
function unsaltBlock(block: Json): Json {
  const restored: Json = {};
  for (const field of ["id", "tool_use_id"] as const) {
    const value = block[field];
    if (typeof value !== "string") {
      continue;
    }
    const raw = unsaltToolUseId(value);
    if (raw !== null) {
      restored[field] = raw;
    }
  }
  return Object.keys(restored).length === 0 ? block : Object.assign({}, block, restored);
}

/**
 * A Messages request with the ids this gateway salted given back to the
 * upstream that made them, on the call and on the result answering it.
 */
export function unsaltRequestIds(body: Json): Json {
  if (!Array.isArray(body.messages)) {
    return body;
  }
  let changed = false;
  const messages = body.messages.map((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.content)) {
      return entry;
    }
    let touched = false;
    const content = entry.content.map((block) => {
      if (!isRecord(block)) {
        return block;
      }
      const next = unsaltBlock(block);
      if (next !== block) {
        touched = true;
      }
      return next;
    });
    if (!touched) {
      return entry;
    }
    changed = true;
    return { ...entry, content };
  });
  return changed ? { ...body, messages } : body;
}
