import type { IrPart } from "./ir.js";
import { codecFor } from "./protocols.js";
import type { GatewayProtocol } from "./upstream.js";

/**
 * The reply beside the prompt's text, myna's `prompt_reply.go`: what the
 * model answered, read from the reply as the agent got it — the archive's
 * copy — into the pieces the prompt viewer shows. The copy is already
 * masked, so nothing here reads a value the prompt's own text would hide.
 */

export interface ReplyPiece {
  /** The answer's text, its thinking, or a tool call it made. */
  role: "assistant" | "thinking" | "call";
  name?: string;
  text: string;
}

export interface ReplyRead {
  pieces: ReplyPiece[];
  /** Only the reply's start was kept, or it ended before it was whole. */
  cut: boolean;
}

/** Reads a reply body (JSON or an event stream) into pieces, or null. */
export function replyPieces(
  protocol: GatewayProtocol,
  body: string,
  cut: boolean,
): ReplyRead | null {
  const parts = readParts(protocol, body);
  const pieces: ReplyPiece[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      pieces.push({ role: "assistant", text: part.text });
    } else if (part.type === "thinking") {
      pieces.push({ role: "thinking", text: part.text });
    } else if (part.type === "tool_call") {
      pieces.push({ role: "call", name: part.name, text: part.arguments });
    }
  }
  return pieces.length === 0 ? null : { pieces, cut };
}

function readParts(protocol: GatewayProtocol, body: string): IrPart[] {
  const codec = codecFor(protocol);
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return codec.parseResponse(parsed as Record<string, unknown>).parts;
      }
    } catch {
      return [];
    }
    return [];
  }
  return streamParts(codec, body);
}

function streamParts(codec: ReturnType<typeof codecFor>, body: string): IrPart[] {
  const decoder = codec.createStreamDecoder();
  const events = [...decoder.push(body), ...decoder.flush()];
  const parts: IrPart[] = [];
  let text = "";
  let thinking = "";
  const calls = new Map<string, { name: string; args: string }>();
  const flushText = (): void => {
    if (text.length > 0) {
      parts.push({ type: "text", text });
      text = "";
    }
    if (thinking.length > 0) {
      parts.push({ type: "thinking", text });
      thinking = "";
    }
  };
  for (const event of events) {
    if (event.type === "text_delta") {
      text += event.text;
    } else if (event.type === "thinking_delta") {
      thinking += event.text;
    } else if (event.type === "tool_call_start") {
      flushText();
      calls.set(event.id, { name: event.name, args: "" });
    } else if (event.type === "tool_args_delta") {
      const call = calls.get(event.id);
      if (call !== undefined) {
        call.args += event.args;
      }
    } else if (event.type === "stop") {
      flushText();
    }
  }
  flushText();
  for (const call of calls.values()) {
    parts.push({ type: "tool_call", id: "", name: call.name, arguments: call.args });
  }
  return parts;
}
