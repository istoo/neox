/**
 * A model can loop across turns: it asks for the same tool call, the agent
 * runs it and sends back the same result, and the model asks again. Every
 * turn of such a loop carries the whole conversation, so the loop is in
 * the request itself: its newest turns are the same calls with the same
 * arguments answered with the same results. This notices that and answers
 * the turn here, with a notice that ends it, instead of sending it
 * (myna's tool_loop.go).
 */

import type { IrMessage, IrPart, IrRequest } from "./ir.js";

/** How many turns in a row of the same calls answered the same stop the next. */
export const TOOL_LOOP_REPEATS = 8;

/** What each API's tool result is written with, to skip a body without a loop. */
const RESULT_MARKS: Record<string, string[]> = {
  "openai-responses": ['_output"'],
  openai: ['"tool_call_id"'],
  anthropic: ['"tool_result"'],
  gemini: ['"functionResponse"', '"function_response"'],
};

/** Whether a request body has results enough to hold a loop (a cheap check). */
export function mayLoop(
  protocol: "anthropic" | "openai" | "openai-responses" | "gemini",
  body: string,
): boolean {
  let count = 0;
  for (const mark of RESULT_MARKS[protocol] ?? []) {
    count += body.split(mark).length - 1;
  }
  return count >= TOOL_LOOP_REPEATS;
}

export interface ToolLoop {
  calls: Array<{ name: string; arguments: string }>;
  turns: number;
}

interface Exchange {
  sum: string;
  calls: Array<{ name: string; arguments: string }>;
}

const WAIT_WORDS = new Set(["sleep", "wait", "delay", "pause", "poll"]);
const DURATION_KEYS = new Set([
  "duration",
  "duration_ms",
  "duration_s",
  "duration_seconds",
  "ms",
  "milliseconds",
  "seconds",
  "secs",
  "sec",
  "timeout",
  "timeout_ms",
  "delay",
  "delay_ms",
  "minutes",
]);

/** Whether a call only waits, which the same result a moment later is progress for. */
function isWait(call: { name: string; arguments: string }): boolean {
  let name = call.name;
  for (const separator of ["__", ".", "/", ":"]) {
    const at = name.lastIndexOf(separator);
    if (at >= 0) {
      name = name.slice(at + separator.length);
    }
  }
  const words = name
    .replace(/([A-Z])/g, " $1")
    .split(/[^A-Za-z]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  if (words.some((word) => WAIT_WORDS.has(word))) {
    return true;
  }
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return false;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(
    ([key, value]) => DURATION_KEYS.has(key.toLowerCase()) && typeof value === "number",
  );
}

function allWaits(calls: Array<{ name: string; arguments: string }>): boolean {
  return calls.length > 0 && calls.every((call) => isWait(call));
}

/** A call's arguments with their keys in one order. */
function steadyArgs(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    return JSON.stringify(value);
  } catch {
    return raw;
  }
}

/** What an agent writes of the run itself, which differs every time. */
const RUN_NOISE: Array<[string, RegExp]> = [
  ["Wall time", /^(Wall time:? )[0-9.]+( seconds?)/gm],
  ["Chunk ID: ", /^(Chunk ID: )\S+/gm],
  ['"duration_seconds"', /("duration_seconds"\s*:\s*)[0-9.eE+-]+/g],
];

function steadyResult(text: string): string {
  let out = text;
  for (const [mark, pattern] of RUN_NOISE) {
    if (out.includes(mark)) {
      out = out.replace(pattern, "$1#");
    }
  }
  return out;
}

function resultSum(part: IrPart): string {
  if (part.type !== "tool_result") {
    return "";
  }
  let out = part.isError ? "error\u0000" : "";
  out += steadyResult(part.content);
  for (const image of part.images ?? []) {
    out += `\u0000${image.mediaType}${image.data}${image.url ?? ""}`;
  }
  return out;
}

/** One turn of tool use: its calls, and the results the agent sent back. */
function exchangeOf(asked: IrPart[], said: IrPart[]): Exchange | null {
  const calls = asked.filter(
    (part): part is Extract<IrPart, { type: "tool_call" }> => part.type === "tool_call",
  );
  const results = new Map<string, string[]>();
  const rest: string[] = [];
  let hasResult = false;
  for (const part of said) {
    if (part.type === "tool_result") {
      hasResult = true;
      const list = results.get(part.toolCallId) ?? [];
      list.push(resultSum(part));
      results.set(part.toolCallId, list);
    } else if (part.type === "text") {
      rest.push(`text\u0000${part.text}`);
    } else {
      rest.push(`${part.type}\u0000`);
    }
  }
  if (calls.length === 0 || !hasResult) {
    return null;
  }
  const keys: string[] = [];
  for (const call of calls) {
    const got = results.get(call.id) ?? [];
    results.delete(call.id);
    keys.push(`${call.name}\u0000${steadyArgs(call.arguments)}\u0000${got.join("\u0001")}`);
  }
  for (const got of results.values()) {
    keys.push(`\u0000\u0000${got.join("\u0001")}`);
  }
  keys.sort();
  return {
    sum: `${keys.join("\u0000")}\u0002${rest.join("\u0000")}`,
    calls: calls.map((call) => ({ name: call.name, arguments: call.arguments })),
  };
}

/** The turns of tool use msgs end in, oldest first. */
function exchanges(messages: IrMessage[]): Exchange[] {
  interface Run {
    role: string;
    parts: IrPart[];
  }
  const runs: Run[] = [];
  for (const message of messages) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.role === message.role) {
      last.parts = [...last.parts, ...message.parts];
      continue;
    }
    runs.push({ role: message.role, parts: [...message.parts] });
  }
  const out: Exchange[] = [];
  for (let index = runs.length - 1; index >= 1; index -= 2) {
    const said = runs[index];
    const asked = runs[index - 1];
    if (said === undefined || asked === undefined) {
      break;
    }
    if (said.role !== "user" || asked.role !== "assistant") {
      break;
    }
    const exchange = exchangeOf(asked.parts, said.parts);
    if (exchange === null) {
      break;
    }
    out.push(exchange);
  }
  return out.toReversed();
}

/** The loop a request's newest turns are, when the last eight are one exchange. */
export function toolLoopOf(request: IrRequest): ToolLoop | null {
  const turns = exchanges(request.messages);
  if (turns.length < TOOL_LOOP_REPEATS) {
    return null;
  }
  const last = turns[turns.length - 1];
  if (last === undefined || allWaits(last.calls)) {
    return null;
  }
  let count = 0;
  for (let index = turns.length - 1; index >= 0 && turns[index]?.sum === last.sum; index -= 1) {
    count += 1;
  }
  if (count < TOOL_LOOP_REPEATS) {
    return null;
  }
  return { calls: last.calls, turns: count };
}

/** A turn's calls as the notice names them, each cut short. */
export function toolLoopCalled(loop: ToolLoop): string {
  return loop.calls
    .map((call) => {
      let args = steadyArgs(call.arguments);
      if ([...args].length > 120) {
        args = `${[...args].slice(0, 120).join("")}…`;
      }
      return `${call.name} ${args}`;
    })
    .join("; ");
}

/** What the routing and usage views say of the turn. */
export function toolLoopWhy(loop: ToolLoop): string {
  return `tool loop: the same tool call got the same result ${loop.turns} turns in a row (${toolLoopCalled(loop)}); answered by Neox, sent nowhere`;
}

/** What the agent shows the user, as the turn's answer. */
export function toolLoopNotice(loop: ToolLoop): string {
  return `Neox stopped this turn before it reached the model: the agent ran the same tool call ${loop.turns} times in a row and got the same result every time (${toolLoopCalled(loop)}). The model is stuck repeating it, and each further turn would spend your quota with no progress, so this turn was sent nowhere. Tell the agent how to go on and the conversation continues; Settings › Models › Replies › Stop looping replies turns this check off.`;
}
