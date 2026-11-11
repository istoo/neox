/**
 * Every tool call of a Chat request that came with no id gets one, and the
 * tool messages after it that answer with no tool_call_id get that same
 * id, in the calls' order (myna's chat_call_ids.go, #2611). The id comes
 * from the call's place in the request and what it says, never at random,
 * so the next turn sends the same history and the upstream's prompt cache
 * still holds.
 */

import { createHash } from "node:crypto";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function callId(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The id a call at this place gets on every request that says the same. */
export function placedCallId(msg: number, index: number, name: string, args: string): string {
  const sum = createHash("sha256")
    .update(`${msg}.${index}\u0000${name}\u0000${args}`)
    .digest("hex")
    .slice(0, 24);
  return `call_${sum}`;
}

function argsText(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * A Chat request body whose calls and tool messages carry the ids they
 * were missing; the same object, edited in place, when any was given.
 */
export function chatCallIds<T extends Record<string, unknown>>(body: T): T {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages === null) {
    return body;
  }
  let open: string[] = [];
  messages.forEach((entry, index) => {
    const message = asRecord(entry);
    if (message === null) {
      return;
    }
    if (message.role === "assistant") {
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length === 0) {
        return;
      }
      open = [];
      calls.forEach((entryCall, position) => {
        const call = asRecord(entryCall);
        if (call === null || callId(call.id) !== "") {
          return;
        }
        const fn = asRecord(call.function);
        const name = typeof fn?.name === "string" ? fn.name : "";
        const id = placedCallId(index, position, name, argsText(fn?.arguments));
        call.id = id;
        open.push(id);
      });
      if (open.length > 0) {
        message.tool_calls = calls;
      }
      return;
    }
    if (message.role === "tool") {
      if (open.length === 0 || callId(message.tool_call_id) !== "") {
        return;
      }
      const id = open[0];
      if (id === undefined) {
        return;
      }
      message.tool_call_id = id;
      open = open.slice(1);
    }
  });
  return body;
}
