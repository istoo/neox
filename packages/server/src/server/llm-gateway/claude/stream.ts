/** What one Claude Code message cost, as Anthropic reports it to Claude Code. */
export interface ClaudeMessageUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/**
 * What the bridge takes from Claude Code's stream-json. The gateway maps these
 * to its own events; a caller's tool calls, refusals and structured answers
 * are added by later stages.
 */
export type ClaudeStreamEvent =
  | { kind: "text"; text: string }
  | { kind: "usage"; usage: ClaudeMessageUsage }
  | { kind: "stop"; stop: string }
  | { kind: "error"; message: string }
  /** A caller's tool, which the MCP helper is about to call. */
  | { kind: "toolCall"; id: string; name: string; arguments: string };

/**
 * Reads `claude -p --output-format stream-json` line by line. Chunk
 * boundaries are the stream's, not a line's: a partial line waits for the
 * rest.
 *
 * Claude Code with `--include-partial-messages` sends each message twice:
 * once as `stream_event`s and once whole as `assistant`. The text goes to the
 * caller once, from the stream; a whole message is used only when nothing
 * streamed it.
 */
export class ClaudeStreamParser {
  private buffer = "";
  private readonly streamed = new Set<string>();
  /** Tool blocks of the message being streamed, by their index. */
  private readonly toolBlocks = new Map<number, { id: string; name: string; args: string }>();
  private messageUsage: ClaudeMessageUsage = emptyUsage();
  private textShown = false;
  private session = "";
  /** The session line each tool call was made in, by the call's id. */
  private readonly callLines = new Map<string, string>();

  /** The session Claude Code says it keeps this conversation in, "" before it says. */
  public get sessionId(): string {
    return this.session;
  }

  /** The session line a tool call was made in, "" before Claude Code tells it. */
  public callUuid(id: string): string | undefined {
    return this.callLines.get(id);
  }

  public push(chunk: string): ClaudeStreamEvent[] {
    this.buffer += chunk;
    const events: ClaudeStreamEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return events;
      }
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...this.line(line));
    }
  }

  public end(): ClaudeStreamEvent[] {
    if (this.buffer === "") {
      return [];
    }
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    return this.line(line);
  }

  private line(line: string): ClaudeStreamEvent[] {
    if (line.trim() === "") {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    const record = asRecord(parsed);
    if (record === undefined) {
      return [];
    }
    const session = stringField(record, "session_id");
    if (session !== "") {
      this.session = session;
    }
    switch (stringField(record, "type")) {
      case "stream_event":
        return this.streamEvent(asRecord(record.event));
      case "assistant": {
        // the line's uuid, for a branch to cut the session after; it is
        // told with the whole message, which a streamed one sends too
        const message = asRecord(record.message);
        const uuid = stringField(record, "uuid");
        if (
          uuid !== "" &&
          message !== undefined &&
          stringField(message, "model") !== "<synthetic>"
        ) {
          for (const call of toolCallBlocks(message.content)) {
            if (call.kind === "toolCall") {
              this.callLines.set(call.id, uuid);
            }
          }
        }
        return this.wholeMessage(message);
      }
      case "result":
        return this.result(record);
      default:
        return [];
    }
  }

  private streamEvent(event: Record<string, unknown> | undefined): ClaudeStreamEvent[] {
    if (event === undefined) {
      return [];
    }
    switch (stringField(event, "type")) {
      case "message_start":
        return this.messageStart(asRecord(event.message));
      case "content_block_start":
        return this.blockStart(numberField(event, "index"), asRecord(event.content_block));
      case "content_block_delta":
        return this.blockDelta(numberField(event, "index"), asRecord(event.delta));
      case "content_block_stop":
        return this.blockStop(numberField(event, "index"));
      case "message_delta":
        return this.messageDelta(event);
      case "error": {
        const error = asRecord(event.error);
        const message =
          error === undefined ? "Claude Code stream error" : stringField(error, "message");
        return [{ kind: "error", message }];
      }
      default:
        return [];
    }
  }

  private messageStart(message: Record<string, unknown> | undefined): ClaudeStreamEvent[] {
    if (message === undefined) {
      return [];
    }
    const id = stringField(message, "id");
    if (id !== "") {
      this.streamed.add(id);
    }
    this.messageUsage = usageOf(asRecord(message.usage));
    this.toolBlocks.clear();
    return [];
  }

  private blockStart(
    index: number | null,
    block: Record<string, unknown> | undefined,
  ): ClaudeStreamEvent[] {
    if (index === null || block === undefined || stringField(block, "type") !== "tool_use") {
      return [];
    }
    this.toolBlocks.set(index, {
      id: stringField(block, "id"),
      name: stringField(block, "name"),
      args: "",
    });
    return [];
  }

  private blockDelta(
    index: number | null,
    delta: Record<string, unknown> | undefined,
  ): ClaudeStreamEvent[] {
    if (delta === undefined) {
      return [];
    }
    if (stringField(delta, "type") === "input_json_delta") {
      const block = index === null ? undefined : this.toolBlocks.get(index);
      if (block !== undefined) {
        block.args += stringField(delta, "partial_json");
      }
      return [];
    }
    if (stringField(delta, "type") !== "text_delta") {
      return [];
    }
    const text = stringField(delta, "text");
    if (text === "") {
      return [];
    }
    this.textShown = true;
    return [{ kind: "text", text }];
  }

  private blockStop(index: number | null): ClaudeStreamEvent[] {
    const block = index === null ? undefined : this.toolBlocks.get(index);
    if (block === undefined) {
      return [];
    }
    this.toolBlocks.delete(index ?? -1);
    if (block.id === "") {
      return [];
    }
    return [
      {
        kind: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.args === "" ? "{}" : block.args,
      },
    ];
  }

  private messageDelta(event: Record<string, unknown>): ClaudeStreamEvent[] {
    const delta = asRecord(event.delta);
    if (delta !== undefined) {
      const output = numberField(asRecord(event.usage), "output_tokens");
      if (output !== null) {
        this.messageUsage = { ...this.messageUsage, outputTokens: output };
      }
    }
    const events: ClaudeStreamEvent[] = [{ kind: "usage", usage: { ...this.messageUsage } }];
    const stop = delta === undefined ? "" : stringField(delta, "stop_reason");
    if (stop !== "") {
      events.push({ kind: "stop", stop });
    }
    return events;
  }

  private wholeMessage(message: Record<string, unknown> | undefined): ClaudeStreamEvent[] {
    if (message === undefined) {
      return [];
    }
    const id = stringField(message, "id");
    if (id !== "" && this.streamed.has(id)) {
      return [];
    }
    const events: ClaudeStreamEvent[] = [];
    for (const text of textBlocks(message.content)) {
      this.textShown = true;
      events.push({ kind: "text", text });
    }
    for (const call of toolCallBlocks(message.content)) {
      events.push(call);
    }
    const usage = usageOf(asRecord(message.usage));
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      events.push({ kind: "usage", usage });
    }
    const stop = stringField(message, "stop_reason");
    if (stop !== "") {
      events.push({ kind: "stop", stop });
    }
    return events;
  }

  private result(record: Record<string, unknown>): ClaudeStreamEvent[] {
    if (record.is_error === true) {
      const words = stringField(record, "result") || stringField(record, "subtype");
      return [{ kind: "error", message: words === "" ? "Claude Code ended with an error" : words }];
    }
    const result = stringField(record, "result");
    if (!this.textShown && result !== "") {
      this.textShown = true;
      return [{ kind: "text", text: result }];
    }
    return [];
  }
}

function emptyUsage(): ClaudeMessageUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
}

function usageOf(usage: Record<string, unknown> | undefined): ClaudeMessageUsage {
  if (usage === undefined) {
    return emptyUsage();
  }
  return {
    inputTokens: numberField(usage, "input_tokens") ?? 0,
    outputTokens: numberField(usage, "output_tokens") ?? 0,
    cacheCreationInputTokens: numberField(usage, "cache_creation_input_tokens") ?? 0,
    cacheReadInputTokens: numberField(usage, "cache_read_input_tokens") ?? 0,
  };
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined || stringField(record, "type") !== "text") {
      continue;
    }
    const text = stringField(record, "text");
    if (text !== "") {
      texts.push(text);
    }
  }
  return texts;
}

function toolCallBlocks(content: unknown): ClaudeStreamEvent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const calls: ClaudeStreamEvent[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined || stringField(record, "type") !== "tool_use") {
      continue;
    }
    const id = stringField(record, "id");
    if (id === "") {
      continue;
    }
    calls.push({
      kind: "toolCall",
      id,
      name: stringField(record, "name"),
      arguments: JSON.stringify(record.input ?? {}),
    });
  }
  return calls;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | null {
  if (record === undefined) {
    return null;
  }
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
