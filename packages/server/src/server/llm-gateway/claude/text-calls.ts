import type { ClaudeStreamEvent } from "./stream.js";

/** The lines that open a tool call told in text. */
const TEXT_CALL_OPENS = ["[tool call ", "<invoke name=", "<function_calls>"];

/**
 * Holds back a reply's words from the first line that opens as a tool call
 * written out as text instead of made. The model can take the "[tool call …]"
 * lines of a past conversation for how it calls a tool; Claude Code then has
 * no call to make, the turn ends, and the client is shown the lines as the
 * reply (myna's textCalls).
 */
export class TextCallsFilter {
  private mid = false;
  private line = "";
  private seen = false;
  private held = "";

  /** Takes the next of the reply's words and says which go to the client now. */
  public push(text: string): string {
    if (this.seen) {
      this.held += text;
      return "";
    }
    let out = "";
    for (let at = 0; at < text.length; at += 1) {
      const char = text[at] ?? "";
      if (this.mid) {
        out += char;
        this.mid = char !== "\n";
        continue;
      }
      const line = this.line + char;
      const open = line.trimStart();
      const opens = TEXT_CALL_OPENS.some((prefix) => open.startsWith(prefix));
      const may = TEXT_CALL_OPENS.some((prefix) => prefix.startsWith(open));
      if (opens) {
        this.seen = true;
        this.line = "";
        this.held += line;
        this.held += text.slice(at + 1);
        return out;
      }
      if (may) {
        this.line = line;
      } else {
        out += line;
        this.line = "";
        this.mid = char !== "\n";
      }
    }
    return out;
  }

  /** What was held at the reply's end, and whether a call's line opened it. */
  public end(): { held: string; seen: boolean } {
    if (!this.seen) {
      const held = this.line;
      this.line = "";
      return { held, seen: false };
    }
    return { held: this.held, seen: true };
  }
}

/**
 * Filters a turn's events: a fake call's words are withheld while the reply
 * goes on; at its stop, words that opened a call with no real call beside it
 * are shown as written, since nothing can ask the run to make it.
 */
export async function* filterTextCalls(
  events: AsyncIterable<ClaudeStreamEvent>,
): AsyncGenerator<ClaudeStreamEvent> {
  let filter = new TextCallsFilter();
  let called = false;
  for await (const event of events) {
    if (event.kind === "toolCall") {
      called = true;
      yield event;
      continue;
    }
    if (event.kind === "text") {
      const words = filter.push(event.text);
      if (words !== "") {
        yield { kind: "text", text: words };
      }
      continue;
    }
    if (event.kind === "stop") {
      const { held } = filter.end();
      if (held !== "" && !called) {
        yield { kind: "text", text: held };
      }
      yield event;
      // The next message of a tool loop starts its own reply.
      filter = new TextCallsFilter();
      called = false;
      continue;
    }
    yield event;
  }
}
