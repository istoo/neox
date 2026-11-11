/**
 * Two fixes a Responses reply may need on its way to the client: an
 * assistant message the upstream gave no phase gets one — "commentary"
 * for what came on the way, "final_answer" for the message that ends the
 * turn, which Codex folds by (myna's phase.go) — and an item keeps the one
 * id its output_item.added gave it, which Copilot's /responses does not
 * (myna's itemids.go).
 */

import { eventData, eventEnd, type StreamFilter, withData } from "./text-calls.js";

const PHASE_COMMENTARY = "commentary";
const PHASE_FINAL = "final_answer";
/** How many events may wait behind a message whose phase isn't known yet. */
const HELD_MOST = 512;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function unphased(item: Record<string, unknown> | null): boolean {
  if (item === null || item.type !== "message") {
    return false;
  }
  if (item.role !== undefined && item.role !== "assistant") {
    return false;
  }
  return typeof item.phase !== "string" || item.phase === "";
}

function anyUnphased(output: unknown): boolean {
  return asArray(output).some((entry) => unphased(asRecord(entry)));
}

/** Gives each assistant message in a reply's output its phase. */
function phaseOutput(output: unknown[], done: boolean): boolean {
  let last = -1;
  output.forEach((entry, index) => {
    const item = asRecord(entry);
    if (item !== null && item.type !== "reasoning") {
      last = index;
    }
  });
  let changed = false;
  output.forEach((entry, index) => {
    const item = asRecord(entry);
    if (item === null || !unphased(item)) {
      return;
    }
    if (index < last) {
      item.phase = PHASE_COMMENTARY;
      changed = true;
    } else if (index === last && done) {
      item.phase = PHASE_FINAL;
      changed = true;
    }
  });
  return changed;
}

/** A whole Responses reply with its messages' phases, when it needed them. */
export function phaseWholeText(body: string): string | null {
  const response = safeRecord(body);
  if (response === null || response.object !== "response") {
    return null;
  }
  if (!phaseOutput(asArray(response.output), response.status === "completed")) {
    return null;
  }
  return JSON.stringify(response);
}

function phasedEvent(data: string, phase: string): string | null {
  const event = safeRecord(data);
  if (event === null || !unphased(asRecord(event.item))) {
    return null;
  }
  const item = asRecord(event.item);
  if (item === null) {
    return null;
  }
  item.phase = phase;
  return JSON.stringify(event);
}

/**
 * A relayed Responses stream: an output_item.done of an unphased message
 * waits with what follows until the next item that isn't reasoning
 * (commentary) or the reply's end (final answer).
 */
export class PhaseTidy implements StreamFilter {
  private readonly sse: boolean;
  private buffer = "";
  private held: string[] | null = null;

  public constructor(sse: boolean) {
    this.sse = sse;
  }

  public write(piece: string): string {
    this.buffer += piece;
    if (!this.sse) {
      return "";
    }
    const split = this.tidy();
    return split;
  }

  public flush(): string {
    const tail = this.buffer;
    this.buffer = "";
    if (!this.sse) {
      return phaseWholeText(tail) ?? tail;
    }
    // A stream that ended with a message still waiting says nothing about
    // the turn's end, so it goes as it came.
    return this.release("") + tail;
  }

  private tidy(): string {
    let out = "";
    let at = 0;
    for (;;) {
      const size = eventEnd(this.buffer.slice(at));
      if (size < 0) {
        break;
      }
      out += this.event(this.buffer.slice(at, at + size));
      at += size;
    }
    this.buffer = this.buffer.slice(at);
    return out;
  }

  // debt: 与 myna 的事件分支一一对应；再加事件类型时改表驱动
  // eslint-disable-next-line complexity
  private event(block: string): string {
    const data = eventData(block);
    const parsed = safeRecord(data);
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (this.held !== null) {
      if (type === "response.output_item.added" && asRecord(parsed?.item)?.type === "reasoning") {
        return this.hold(block);
      }
      if (type === "response.output_item.added") {
        return this.release(PHASE_COMMENTARY) + this.event(block);
      }
      if (type === "response.completed") {
        return this.release(PHASE_FINAL) + this.ended(block, parsed, true);
      }
      if (type === "response.incomplete" || type === "response.failed" || type === "error") {
        return this.release("") + this.ended(block, parsed, false);
      }
      return this.hold(block);
    }
    if (type === "response.output_item.done") {
      const item = asRecord(parsed?.item);
      if (item?.type === "message" && item.role !== "user" && (item.phase ?? "") === "") {
        this.held = [block];
        return "";
      }
    }
    if (type === "response.completed") {
      return this.ended(block, parsed, true);
    }
    if (type === "response.incomplete") {
      return this.ended(block, parsed, false);
    }
    return block;
  }

  private hold(block: string): string {
    if (this.held === null) {
      this.held = [];
    }
    this.held.push(block);
    if (this.held.length > HELD_MOST) {
      return this.release("");
    }
    return "";
  }

  private release(phase: string): string {
    const held = this.held;
    this.held = null;
    if (held === null || held.length === 0) {
      return "";
    }
    if (phase !== "" && held[0] !== undefined) {
      const fixed = phasedEvent(eventData(held[0]), phase);
      if (fixed !== null) {
        held[0] = withData(held[0], fixed);
      }
    }
    return held.join("");
  }

  private ended(block: string, parsed: Record<string, unknown> | null, done: boolean): string {
    if (parsed === null) {
      return block;
    }
    const response = asRecord(parsed.response);
    if (response === null || !anyUnphased(response.output)) {
      return block;
    }
    if (!phaseOutput(asArray(response.output), done)) {
      return block;
    }
    return withData(block, JSON.stringify(parsed));
  }
}

interface Added {
  id: string;
  type: string;
}

/** A relayed Responses stream whose items keep the id their added gave them. */
export class ItemIdTidy implements StreamFilter {
  private buffer = "";
  private readonly ids = new Map<number, Added>();

  public write(piece: string): string {
    this.buffer += piece;
    let out = "";
    let at = 0;
    for (;;) {
      const size = eventEnd(this.buffer.slice(at));
      if (size < 0) {
        break;
      }
      out += this.event(this.buffer.slice(at, at + size));
      at += size;
    }
    this.buffer = this.buffer.slice(at);
    return out;
  }

  public flush(): string {
    const tail = this.buffer;
    this.buffer = "";
    return tail;
  }

  // debt: 与 myna 的事件分支一一对应；再加事件类型时改表驱动
  // eslint-disable-next-line complexity
  private event(block: string): string {
    const data = eventData(block);
    const parsed = safeRecord(data);
    if (parsed === null) {
      return block;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const at = typeof parsed.output_index === "number" ? parsed.output_index : null;
    if (type === "response.output_item.added") {
      const item = asRecord(parsed.item);
      if (item !== null && typeof item.id === "string" && item.id !== "" && at !== null) {
        this.ids.set(at, { id: item.id, type: typeof item.type === "string" ? item.type : "" });
      }
      return block;
    }
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      return this.ended(block, parsed);
    }
    if (at === null) {
      return block;
    }
    const was = this.ids.get(at);
    if (was === undefined) {
      return block;
    }
    const itemID = typeof parsed.item_id === "string" ? parsed.item_id : null;
    const item = asRecord(parsed.item);
    const itemIn = typeof item?.id === "string" ? item.id : null;
    const itemIDDiffers = itemID !== null && itemID !== was.id;
    const itemInDiffers = itemIn !== null && itemIn !== was.id;
    if (!itemIDDiffers && !itemInDiffers) {
      return block;
    }
    if (itemID !== null) {
      parsed.item_id = was.id;
    }
    if (item !== null && itemIn !== null && (was.type === "" || item.type === was.type)) {
      item.id = was.id;
    }
    return withData(block, JSON.stringify(parsed));
  }

  private ended(block: string, parsed: Record<string, unknown>): string {
    const response = asRecord(parsed.response);
    if (response === null) {
      return block;
    }
    const output = asArray(response.output);
    let differs = false;
    output.forEach((entry, index) => {
      const was = this.ids.get(index);
      const item = asRecord(entry);
      if (was === undefined || item === null || typeof item.id !== "string") {
        return;
      }
      if (item.id !== was.id && (was.type === "" || item.type === was.type)) {
        differs = true;
      }
    });
    if (!differs) {
      return block;
    }
    output.forEach((entry, index) => {
      const was = this.ids.get(index);
      const item = asRecord(entry);
      if (was === undefined || item === null || item.id === undefined) {
        return;
      }
      if (was.type === "" || item.type === was.type) {
        item.id = was.id;
      }
    });
    response.output = output;
    return withData(block, JSON.stringify(parsed));
  }
}
