/**
 * Some replicas of GLM's flash models stitch a streamed tool call's
 * argument fragments with CR: a lone JSON \r escape at a token boundary
 * breaks the line the client reads. A \r\n pair stays (it is a line
 * ending), \\r is a backslash and an r, and every other \r goes
 * (myna's tool_args_cr.go).
 */

/** Whether a model id names one of those flash models, prefix aside. */
export function glmFlash(id: string): boolean {
  const bare = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  return bare.startsWith("glm-5.3-flash");
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code < 0xdc00;
}

/** Drops CRs from a whole argument string, keeping the \r\n pair. */
export function dropCR(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === "\\") {
      out += "\\\\";
      index += 1;
      continue;
    }
    if (next === "r") {
      if (text[index + 2] === "\\" && text[index + 3] === "n") {
        out += "\\r\\n";
        index += 3;
      } else {
        index += 1;
      }
      continue;
    }
    if (next === "u" && text.slice(index + 2, index + 6).length === 4) {
      const code = Number.parseInt(text.slice(index + 2, index + 6), 16);
      if (code === 0x0d) {
        index += 5;
        continue;
      }
      if (isHighSurrogate(code) && text[index + 6] === "\\" && text[index + 7] === "u") {
        out += text.slice(index, index + 12);
        index += 11;
        continue;
      }
      out += text.slice(index, index + 6);
      index += 5;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * A whole reply's JSON with the CRs of its calls' arguments dropped: a
 * call's `arguments` text, or a tool_use's `input` object (myna's
 * crResult and the non-stream half of crTidy).
 */
export function crInResponseJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => crInResponseJson(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "arguments" && typeof entry === "string") {
      out[key] = dropCR(entry);
      continue;
    }
    if (key === "input" && typeof entry === "object" && entry !== null) {
      out[key] = crInStrings(entry);
      continue;
    }
    if (key === "input" && typeof entry === "string") {
      out[key] = dropCR(entry);
      continue;
    }
    out[key] = crInResponseJson(entry);
  }
  return out;
}

function crInStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return dropCR(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => crInStrings(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, crInStrings(entry)]));
}

/**
 * A relayed SSE stream, a piece at a time, with each event's calls' arguments
 * cured: a line waits for its newline, a call's fragments keep their dropper
 * so an escape cut between events is read with the piece that finishes it
 * (myna's crTidy).
 */
type TidyProtocol = "anthropic" | "openai" | "openai-responses" | "gemini";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entriesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

/** A custom tool's raw input text without a lone CR byte (myna's crBytes). */
class CrBytes {
  private pending = "";

  public get held(): boolean {
    return this.pending !== "";
  }

  public write(piece: string): string {
    const text = this.pending === "" ? piece : `${this.pending}${piece}`;
    this.pending = "";
    return this.scan(text, false);
  }

  public flush(): string {
    const rest = this.scan(this.pending, true);
    this.pending = "";
    return rest;
  }

  private scan(text: string, final: boolean): string {
    let out = "";
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "\r") {
        out += text[index];
        continue;
      }
      if (index + 1 < text.length) {
        if (text[index + 1] === "\n") {
          out += "\r\n";
          index += 1;
        }
        continue;
      }
      if (final) {
        continue;
      }
      this.pending = text.slice(index);
      return out;
    }
    return out;
  }
}

export class CrLineTidy {
  private buffer = "";
  private readonly protocol: TidyProtocol;
  private readonly calls = new Map<string, CrDropper>();
  private readonly texts = new Map<string, CrBytes>();

  public constructor(protocol: TidyProtocol) {
    this.protocol = protocol;
  }

  public write(piece: string): string {
    this.buffer += piece;
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) {
      return "";
    }
    const ready = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    return this.tidy(ready);
  }

  public flush(): string {
    const rest = this.tidy(this.buffer);
    this.buffer = "";
    return rest;
  }

  /** Whether a call waits for the piece that says what its cut escape is. */
  private cut(): boolean {
    for (const dropper of this.calls.values()) {
      if (dropper.held) {
        return true;
      }
    }
    for (const bytes of this.texts.values()) {
      if (bytes.held) {
        return true;
      }
    }
    return false;
  }

  private tidy(region: string): string {
    if (!region.includes("\\r") && !this.cut()) {
      return region;
    }
    let out = "";
    let rest = region;
    while (rest.length > 0) {
      const end = rest.indexOf("\n");
      const line = end < 0 ? rest : rest.slice(0, end + 1);
      rest = end < 0 ? "" : rest.slice(end + 1);
      out += this.line(line);
    }
    return out;
  }

  private line(line: string): string {
    if (!line.includes("\\r") && !this.cut()) {
      return line;
    }
    const body = line.replace(/[\r\n]+$/, "");
    if (!body.startsWith("data:")) {
      return line;
    }
    const next = this.event(body.slice("data:".length).trim());
    if (next === null) {
      return line;
    }
    return `data: ${next}${line.slice(body.length)}`;
  }

  private event(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const event = recordOf(parsed);
    if (event === null) {
      return null;
    }
    if (!this.fix(event)) {
      return null;
    }
    return JSON.stringify(event);
  }

  private fix(event: Record<string, unknown>): boolean {
    if (this.protocol === "anthropic") {
      return this.anthropic(event);
    }
    if (this.protocol === "openai-responses") {
      return this.responses(event);
    }
    if (this.protocol === "openai") {
      return this.chat(event);
    }
    return false;
  }

  private stream(key: string, text: string): string {
    let dropper = this.calls.get(key);
    if (dropper === undefined) {
      dropper = new CrDropper();
      this.calls.set(key, dropper);
    }
    return dropper.write(text);
  }

  private rawText(key: string, text: string): string {
    let bytes = this.texts.get(key);
    if (bytes === undefined) {
      bytes = new CrBytes();
      this.texts.set(key, bytes);
    }
    return bytes.write(text);
  }

  // debt: 三种协议各一段整形，规则多分支广；再叉出协议时拆成策略表
  // eslint-disable-next-line complexity
  private anthropic(event: Record<string, unknown>): boolean {
    let changed = false;
    const block = (value: unknown): void => {
      const shape = recordOf(value);
      if (shape === null || shape.type !== "tool_use" || shape.input === undefined) {
        return;
      }
      const fixed = crInStrings(shape.input);
      if (JSON.stringify(fixed) !== JSON.stringify(shape.input)) {
        shape.input = fixed;
        changed = true;
      }
    };
    for (const entry of entriesOf(event.content)) {
      block(entry);
    }
    block(event.content_block);
    const delta = recordOf(event.delta);
    if (event.type === "content_block_delta" && delta?.type === "input_json_delta") {
      const text = delta.partial_json;
      if (typeof text === "string") {
        const fixed = this.stream(textOf(event.index), text);
        if (fixed !== text) {
          delta.partial_json = fixed;
          changed = true;
        }
      }
    }
    if (event.type === "content_block_stop") {
      this.calls.delete(textOf(event.index));
    }
    return changed;
  }

  private chat(event: Record<string, unknown>): boolean {
    let changed = false;
    for (const entry of entriesOf(event.choices)) {
      const choice = recordOf(entry);
      if (choice === null) {
        continue;
      }
      const delta = recordOf(choice.delta);
      if (delta !== null) {
        changed = this.chatCalls(delta.tool_calls, textOf(choice.index), changed);
      }
      const message = recordOf(choice.message);
      if (message !== null) {
        changed = this.chatWhole(message.tool_calls, changed);
      }
    }
    return changed;
  }

  private chatCalls(value: unknown, choice: string, changed: boolean): boolean {
    let touched = changed;
    const calls = entriesOf(value);
    calls.forEach((entry, position) => {
      const call = recordOf(entry);
      const fn = recordOf(call?.function);
      if (fn === null || typeof fn.arguments !== "string") {
        return;
      }
      const slot = call?.index === undefined ? String(position) : textOf(call.index);
      const fixed = this.stream(`${choice}/${slot}`, fn.arguments);
      if (fixed !== fn.arguments) {
        fn.arguments = fixed;
        touched = true;
      }
    });
    return touched;
  }

  private chatWhole(value: unknown, changed: boolean): boolean {
    let touched = changed;
    for (const entry of entriesOf(value)) {
      const fn = recordOf(recordOf(entry)?.function);
      if (fn === null || typeof fn.arguments !== "string") {
        continue;
      }
      const fixed = dropCR(fn.arguments);
      if (fixed !== fn.arguments) {
        fn.arguments = fixed;
        touched = true;
      }
    }
    return touched;
  }

  // debt: 同 anthropic，Responses 的事件形态最多；再加形态时改表驱动
  // eslint-disable-next-line complexity
  private responses(event: Record<string, unknown>): boolean {
    let changed = false;
    const item = (value: unknown): void => {
      const call = recordOf(value);
      if (call === null) {
        return;
      }
      if (call.type === "function_call" && typeof call.arguments === "string") {
        const fixed = dropCR(call.arguments);
        if (fixed !== call.arguments) {
          call.arguments = fixed;
          changed = true;
        }
      }
      if (call.type === "custom_tool_call" && typeof call.input === "string") {
        const fixed = dropRawCR(call.input);
        if (fixed !== call.input) {
          call.input = fixed;
          changed = true;
        }
      }
    };
    item(event.item);
    const key = this.callKey(event);
    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.delta === "string"
    ) {
      const fixed = this.stream(key, event.delta);
      if (fixed !== event.delta) {
        event.delta = fixed;
        changed = true;
      }
    }
    if (event.type === "response.custom_tool_call_input.delta" && typeof event.delta === "string") {
      const fixed = this.rawText(key, event.delta);
      if (fixed !== event.delta) {
        event.delta = fixed;
        changed = true;
      }
    }
    if (
      event.type === "response.function_call_arguments.done" &&
      typeof event.arguments === "string"
    ) {
      this.calls.delete(key);
      const fixed = dropCR(event.arguments);
      if (fixed !== event.arguments) {
        event.arguments = fixed;
        changed = true;
      }
    }
    if (event.type === "response.custom_tool_call_input.done" && typeof event.input === "string") {
      this.texts.delete(key);
      const fixed = dropRawCR(event.input);
      if (fixed !== event.input) {
        event.input = fixed;
        changed = true;
      }
    }
    const whole = recordOf(event.response) ?? (event.object === "response" ? event : null);
    if (whole !== null) {
      for (const entry of entriesOf(whole.output)) {
        item(entry);
      }
    }
    return changed;
  }

  private callKey(event: Record<string, unknown>): string {
    const id = event.item_id;
    if (typeof id === "string" && id !== "") {
      return id;
    }
    return `#${textOf(event.output_index)}`;
  }
}

/** A custom tool's whole input text without its lone CR bytes. */
function dropRawCR(text: string): string {
  const bytes = new CrBytes();
  return bytes.write(text) + bytes.flush();
}

/**
 * The same, a streamed piece at a time: an escape cut between pieces waits
 * for the next one.
 */
export class CrDropper {
  private pending = "";

  /** Whether an escape waits for the piece that finishes it. */
  public get held(): boolean {
    return this.pending !== "";
  }

  public write(piece: string): string {
    this.pending += piece;
    let cut = this.pending.length;
    // An escape cut off at the end waits for the piece that finishes it.
    const tail = /(\\+)$/.exec(this.pending);
    if (tail !== null) {
      const count = tail[1]?.length ?? 0;
      if (count % 2 === 1) {
        cut -= 1;
      } else if (this.pending.endsWith("\\r")) {
        cut -= 2;
      } else if (/\\u[0-9a-fA-F]{0,3}$/.test(this.pending)) {
        cut = this.pending.lastIndexOf("\\u");
      }
    }
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return dropCR(ready);
  }

  public flush(): string {
    const rest = dropCR(this.pending);
    this.pending = "";
    return rest;
  }
}
