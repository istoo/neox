import { createHash } from "node:crypto";
import type { IrMessage, IrPart } from "./ir.js";

/**
 * A client may send its conversation back with earlier images and files
 * taken out. The run that had the conversation already saw them; told the
 * conversation anew, it would write all of it to the vendor's prompt cache
 * again. This detects that rewrite by the conversation's shape, not by a
 * client's words for it: every media part is in the new conversation, or
 * gone, or text stands in its place, and nothing else changed.
 *
 * Ported from myna's `lost_media.go`. Its caller in myna is the Claude
 * subscription bridge (`claude_subscription.go`), which Neolix does not have
 * yet; the detector is kept here so that bridge can use it unchanged. The
 * IR keeps a tool result as text, so myna's case of an image taken out of a
 * tool result cannot be seen here.
 */

type PartKind = "text" | "tool_call" | "tool_result" | "image";

interface WordPart {
  kind: PartKind;
  words: string;
}

interface HeardPart {
  kind: PartKind;
  length: number;
  sum: Buffer;
  words: string;
}

interface HeardRun {
  role: string;
  parts: HeardPart[];
}

/** Whether `now` is `was` with media taken out (and text put in its place). */
export function lostMedia(was: readonly IrMessage[], now: readonly IrMessage[]): boolean {
  const before = heardRuns(was);
  const after = heardRuns(now);
  if (after.length < before.length) {
    return false;
  }
  let lost = 0;
  for (let index = 0; index < before.length; index += 1) {
    const oldRun = before[index];
    const newRun = after[index];
    if (oldRun === undefined || newRun === undefined || newRun.role !== oldRun.role) {
      return false;
    }
    const count = lostFromRun(oldRun.parts, newRun.parts);
    if (count === null) {
      return false;
    }
    lost += count;
  }
  return lost > 0;
}

function heardRuns(messages: readonly IrMessage[]): HeardRun[] {
  const runs: HeardRun[] = [];
  let call = 0;
  const calls = new Map<string, number>();
  for (const message of messages) {
    const parts = messageParts(
      message,
      () => {
        call += 1;
        return call;
      },
      calls,
    );
    if (parts.length === 0) {
      continue;
    }
    const last = runs[runs.length - 1];
    const run =
      last !== undefined && last.role === message.role ? last : { role: message.role, parts: [] };
    if (run !== last) {
      runs.push(run);
    }
    for (const part of parts) {
      run.parts.push({
        kind: part.kind,
        length: part.words.length,
        sum: sha256(part.words),
        words: part.words,
      });
    }
  }
  return runs;
}

function messageParts(
  message: IrMessage,
  nextCall: () => number,
  calls: Map<string, number>,
): WordPart[] {
  const out: WordPart[] = [];
  for (const part of message.parts) {
    const word = wordOf(part, nextCall, calls);
    if (word !== null && word.words.length > 0) {
      out.push(word);
    }
  }
  return out;
}

function wordOf(part: IrPart, nextCall: () => number, calls: Map<string, number>): WordPart | null {
  switch (part.type) {
    case "text":
      return { kind: "text", words: squeeze(part.text) };
    case "thinking":
      return null;
    case "tool_call": {
      const index = nextCall();
      calls.set(part.id, index);
      return { kind: "tool_call", words: squeeze(`\x01call ${part.name} #${index}`) };
    }
    case "tool_result": {
      const known = calls.get(part.toolCallId);
      return {
        kind: "tool_result",
        words: squeeze(`\x01result #${known ?? "?"} ${part.content}`),
      };
    }
    case "image":
      return { kind: "image", words: squeeze(`\x01image ${part.data.length}`) };
    case "reasoning_item":
      return null;
    case "search":
      return {
        kind: "text",
        words: squeeze(`\x01search ${part.query} ${part.pages.map((page) => page.url).join(" ")}`),
      };
  }
}

function lostFromRun(was: readonly HeardPart[], now: readonly HeardPart[]): number | null {
  let lost = 0;
  let cursor = 0;
  for (let index = 0; index < was.length; index += 1) {
    const part = was[index];
    if (part === undefined) {
      break;
    }
    const current = now[cursor];
    if (current !== undefined && same(part, current)) {
      cursor += 1;
      continue;
    }
    if (part.kind === "image") {
      lost += 1;
      let next = index + 1;
      while (next < was.length && was[next]?.kind === "image") {
        next += 1;
      }
      const nextPart = was[next];
      while (cursor < now.length) {
        const replaced = now[cursor];
        if (replaced === undefined || replaced.kind !== "text") {
          break;
        }
        if (nextPart !== undefined && same(nextPart, replaced)) {
          break;
        }
        cursor += 1;
      }
      continue;
    }
    return null;
  }
  return cursor === now.length ? lost : null;
}

function same(was: HeardPart, now: HeardPart): boolean {
  return (
    was.kind === now.kind && was.length === now.words.length && was.sum.equals(sha256(now.words))
  );
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

/** Words as Go's `strings.Fields` joins them: runs of whitespace collapsed. */
function squeeze(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
