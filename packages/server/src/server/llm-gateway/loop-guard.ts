/**
 * A model can fall into a loop it never leaves: its reasoning goes on as
 * "Now." "Writing." "Go." over and over until the reply's token limit,
 * and the agent waits on it. This reads a relayed reply as it is sent,
 * in any protocol, and says when its reasoning or text has become such a
 * loop, so the gateway ends the reply with an error the agent can act on
 * (myna's loop_guard.go).
 */

import { eventEnd } from "./text-calls.js";

/** How many units of a channel are looked at. */
const LOOP_WINDOW = 256;
/** The most different units the window may hold and still be a loop. */
const LOOP_DISTINCT = 24;
/** How long a unit grows without a break before it is taken whole. */
const UNIT_MOST = 4096;
/** How much of a unit is told apart. */
const UNIT_KEPT = 256;
/** How many units cut at UNIT_MOST in a row are a loop. */
const RUN_ON_UNITS = 2;
/** The most different words a run-on loop has. */
const RUN_ON_DISTINCT = 8;

export interface LoopTrip {
  reasoning: boolean;
  units: string[];
  window: number;
  runOn: boolean;
}

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

function hasWord(s: string): boolean {
  let letters = false;
  let digits = false;
  for (const char of `${s} `) {
    if (LETTER.test(char) || DIGIT.test(char) || char === "_") {
      letters = letters || LETTER.test(char);
      digits = digits || DIGIT.test(char);
      continue;
    }
    if (letters && !digits) {
      return true;
    }
    letters = false;
    digits = false;
  }
  return false;
}

function trimEnds(s: string): string {
  return s.replace(/^[.!?。！？,，;；:：…\s]+|[.!?。！？,，;；:：…\s]+$/g, "");
}

/** What tells a unit apart, when it is a sentence at all. */
function unitKey(raw: string): string | null {
  const s = trimEnds(raw.trim());
  if (!hasWord(s)) {
    return null;
  }
  return s.toLowerCase().slice(0, UNIT_KEPT);
}

/** Whether s, written with no break, is the same few words over and over. */
function runOnWords(s: string): string[] | null {
  if (!hasWord(s)) {
    return null;
  }
  for (let size = 1; size <= 64 && 4 * size <= s.length; size += 1) {
    let index = size;
    while (index < s.length && s[index] === s[index - size]) {
      index += 1;
    }
    if (index === s.length) {
      const end = Math.min(size * 3, s.length);
      return [s.slice(0, end).trim()];
    }
  }
  const counts = new Map<string, number>();
  const order: string[] = [];
  let words = 0;
  for (const word of s.toLowerCase().split(/[^\p{L}\p{Nd}_]+/u)) {
    if (word === "") {
      continue;
    }
    words += 1;
    const seen = counts.get(word) ?? 0;
    counts.set(word, seen + 1);
    if (seen === 0) {
      order.push(word);
    }
    if (counts.size > RUN_ON_DISTINCT) {
      return null;
    }
  }
  if (words * 32 < s.length) {
    return null;
  }
  return [...order].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
}

interface UnitCount {
  n: number;
  text: string;
  at: number;
}

/** One channel's units: its reasoning's, or its text's. */
class UnitRun {
  private current = "";
  private stop = false;
  private lettered = false;
  private readonly ring: Array<string | null> = Array.from({ length: LOOP_WINDOW }, () => null);
  private n = 0;
  private readonly counts = new Map<string, UnitCount>();
  private runOn = 0;

  public add(s: string): LoopTrip | null {
    for (const char of s) {
      if (char === "\n") {
        const trip = this.end();
        if (trip !== null) {
          return trip;
        }
        continue;
      }
      if (this.stop && /\s/.test(char)) {
        const trip = this.end();
        if (trip !== null) {
          return trip;
        }
        continue;
      }
      this.current += char;
      if (char === "." || char === "!" || char === "?") {
        // A sentence's stop, not a list's number or a decimal.
        this.stop = this.lettered;
      } else if (char === "。" || char === "！" || char === "？") {
        const trip = this.end();
        if (trip !== null) {
          return trip;
        }
        continue;
      } else {
        this.stop = false;
        this.lettered = this.lettered || LETTER.test(char);
      }
      if (this.current.length >= UNIT_MOST) {
        const words = runOnWords(this.current);
        if (words !== null) {
          this.runOn += 1;
          if (this.runOn >= RUN_ON_UNITS) {
            return { reasoning: false, units: words, window: this.runOn * UNIT_MOST, runOn: true };
          }
        } else {
          this.runOn = 0;
        }
        const trip = this.end();
        if (trip !== null) {
          return trip;
        }
      }
    }
    return null;
  }

  private end(): LoopTrip | null {
    const raw = this.current;
    if (this.current.length < UNIT_MOST) {
      if (raw.length < UNIT_MOST / 8) {
        this.runOn = 0;
      } else if (runOnWords(raw) === null) {
        this.runOn = 0;
      }
    }
    this.current = "";
    this.stop = false;
    this.lettered = false;
    const key = unitKey(raw);
    if (key === null) {
      return null;
    }
    const slot = this.n % LOOP_WINDOW;
    if (this.n >= LOOP_WINDOW) {
      const old = this.ring[slot];
      if (old !== null && old !== undefined) {
        const count = this.counts.get(old);
        if (count !== undefined) {
          count.n -= 1;
          if (count.n === 0) {
            this.counts.delete(old);
          }
        }
      }
    }
    this.ring[slot] = key;
    let count = this.counts.get(key);
    if (count === undefined) {
      let text = raw.trim();
      const runes = [...text];
      if (runes.length > 40) {
        text = `${runes.slice(0, 40).join("")}…`;
      }
      count = { n: 0, text, at: this.n };
      this.counts.set(key, count);
    }
    count.n += 1;
    this.n += 1;
    if (this.n < LOOP_WINDOW || this.counts.size > LOOP_DISTINCT) {
      return null;
    }
    const all = [...this.counts.values()].sort((a, b) => (a.n !== b.n ? b.n - a.n : a.at - b.at));
    return {
      reasoning: false,
      units: all.map((entry) => entry.text),
      window: LOOP_WINDOW,
      runOn: false,
    };
  }
}

interface EventWords {
  think: string;
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** What one event says, in any protocol: its reasoning and its text. */
// debt: 四协议内容事件的分支与 myna 一一对应；再加协议时改表驱动
// eslint-disable-next-line complexity
function eventWords(block: string): EventWords {
  if (!block.includes("delta") && !block.includes("candidates")) {
    return { think: "", text: "" };
  }
  let data = "";
  for (const line of block.split("\n")) {
    const body = line.replace(/\r+$/, "");
    if (body.startsWith("data:")) {
      data += body.slice("data:".length).trim();
    }
  }
  if (data === "" || !data.startsWith("{")) {
    return { think: "", text: "" };
  }
  let event: Record<string, unknown>;
  try {
    const parsed = asRecord(JSON.parse(data));
    if (parsed === null) {
      return { think: "", text: "" };
    }
    event = parsed;
  } catch {
    return { think: "", text: "" };
  }
  const type = typeof event.type === "string" ? event.type : "";
  const delta = asRecord(event.delta);
  if (type === "content_block_delta") {
    const deltaType = typeof delta?.type === "string" ? delta.type : "";
    if (deltaType === "text_delta") {
      return { think: "", text: typeof delta?.text === "string" ? delta.text : "" };
    }
    if (deltaType === "thinking_delta") {
      return { think: typeof delta?.thinking === "string" ? delta.thinking : "", text: "" };
    }
    return { think: "", text: "" };
  }
  if (type === "response.output_text.delta") {
    return { think: "", text: typeof event.delta === "string" ? event.delta : "" };
  }
  if (
    type === "response.reasoning_text.delta" ||
    type === "response.reasoning_summary_text.delta"
  ) {
    return { think: typeof event.delta === "string" ? event.delta : "", text: "" };
  }
  if (type !== "") {
    return { think: "", text: "" };
  }
  let think = "";
  let text = "";
  for (const entry of asArray(event.choices)) {
    const choice = asRecord(entry);
    const piece = asRecord(choice?.delta);
    const content = typeof piece?.reasoning_content === "string" ? piece.reasoning_content : "";
    if (content !== "") {
      think += content;
    } else if (typeof piece?.reasoning === "string") {
      think += piece.reasoning;
    }
    text += typeof piece?.content === "string" ? piece.content : "";
  }
  for (const entry of asArray(event.candidates)) {
    for (const part of asArray(asRecord(asRecord(entry)?.content)?.parts)) {
      const shape = asRecord(part);
      const value = typeof shape?.text === "string" ? shape.text : "";
      if (shape?.thought === true) {
        think += value;
      } else {
        text += value;
      }
    }
  }
  return { think, text };
}

/** The message the agent and the logs are told. */
export function loopTripMessage(trip: LoopTrip): string {
  const what = trip.reasoning ? "reasoning" : "text";
  const quoted = trip.units.slice(0, 6).map((unit) => JSON.stringify(unit));
  const said = quoted.join(" ");
  if (trip.runOn) {
    return `Neox ended this reply: the model's ${what} was stuck in a loop, its last ${trip.window} characters the same over and over without a break (${said}), and would have run on to its output limit. Ask again, or turn off Settings › Models › Replies › Stop looping replies.`;
  }
  return `Neox ended this reply: the model's ${what} was stuck in a loop, its last ${trip.window} lines and sentences all among the same ${trip.units.length} (${said}), and would have run on to its output limit. Ask again, or turn off Settings › Models › Replies › Stop looping replies.`;
}

/** Reads a relayed reply as it is sent, and says when it has looped. */
export class LoopGuard {
  private pending = "";
  private readonly think = new UnitRun();
  private readonly textRun = new UnitRun();

  public feed(piece: string): LoopTrip | null {
    this.pending += piece;
    for (;;) {
      const end = eventEnd(this.pending);
      if (end < 0) {
        break;
      }
      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      const words = eventWords(block);
      if (words.think !== "") {
        const trip = this.think.add(words.think);
        if (trip !== null) {
          return { ...trip, reasoning: true };
        }
      }
      if (words.text !== "") {
        const trip = this.textRun.add(words.text);
        if (trip !== null) {
          return trip;
        }
      }
    }
    if (this.pending.length > 1 << 20) {
      this.pending = "";
    }
    return null;
  }
}

/** The error event a cut loop ends the reply with, in the client's protocol. */
export function loopErrorEvent(
  protocol: "anthropic" | "openai" | "openai-responses" | "gemini",
  message: string,
): string {
  if (protocol === "anthropic") {
    return `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    })}\n\n`;
  }
  if (protocol === "openai-responses") {
    return `event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        id: "",
        object: "response",
        status: "failed",
        error: { code: "server_error", message },
      },
    })}\n\n`;
  }
  if (protocol === "gemini") {
    return `data: ${JSON.stringify({ error: { code: 502, message, status: "INTERNAL" } })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { message, type: "server_error", code: 502 } })}\n\n`;
}
