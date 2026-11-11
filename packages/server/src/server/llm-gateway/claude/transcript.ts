import type { ClaudeTapReader } from "./tap-reader.js";

/** Where a translator's lines go: the bridge, as `claude -p` would tell them. */
export interface ClaudeTranscriptOutput {
  emit(value: Record<string, unknown>): void;
  /** A message the user sent reached the transcript. */
  sawRow(): void;
  /** A turn ended. */
  turnOver(): void;
}

/** What the translator asks of the tap while it reads rows. */
export type ClaudeTapSource = Pick<ClaudeTapReader, "before" | "settle">;

/**
 * Tells the bridge what Claude Code's session transcript says, as `-p`'s
 * stream-json does: one row for a content block of an assistant message,
 * a result at a turn's end. Claude Code writes the transcript whether the
 * conversation is driven through its screen or not.
 */
export class ClaudeTranscriptTranslator {
  private readonly out: ClaudeTranscriptOutput;
  private failed = false;
  /** The tap whose streams go out before their whole rows. */
  public tap: ClaudeTapSource | null = null;

  public constructor(out: ClaudeTranscriptOutput) {
    this.out = out;
  }

  public async row(line: string): Promise<void> {
    let row: TranscriptRow;
    try {
      row = JSON.parse(line) as TranscriptRow;
    } catch {
      return;
    }
    if (row === null || typeof row !== "object" || row.isSidechain === true) {
      return;
    }
    switch (row.type) {
      case "queue-operation":
        // a message sent mid-turn waits in Claude Code's queue
        if (row.operation === "enqueue") {
          this.out.sawRow();
        }
        return;
      case "user":
        this.userRow(row);
        return;
      case "assistant":
        await this.assistantRow(row);
        return;
      case "system":
        await this.systemRow(row);
        return;
      default:
    }
  }

  private userRow(row: TranscriptRow): void {
    if (row.isMeta !== true && isPrompt(row.message)) {
      this.failed = false;
      this.out.sawRow();
    }
    const result = row.toolUseResult;
    if (typeof result === "string" && result.startsWith("{")) {
      try {
        this.out.emit({ type: "user", tool_use_result: JSON.parse(result) });
      } catch {
        // not a result the transcript can tell
      }
    } else if (result !== null && typeof result === "object") {
      this.out.emit({ type: "user", tool_use_result: result });
    }
  }

  private async assistantRow(row: TranscriptRow): Promise<void> {
    const message = asRecord(row.message);
    const id = typeof message?.id === "string" ? message.id : "";
    const model = typeof message?.model === "string" ? message.model : "";
    const synthetic = model === "<synthetic>";
    if (!synthetic && id !== "" && this.tap !== null) {
      await this.tap.before(id);
    }
    this.out.emit(assistantLine(row));
    if (!synthetic || row.isApiErrorMessage !== true) {
      return;
    }
    const rateLimit = asRecord(asRecord(row.apiErrorParams)?.rate_limit_info);
    if (rateLimit !== null && Object.keys(rateLimit).length > 0) {
      this.out.emit({ type: "rate_limit_event", rate_limit_info: rateLimit });
    }
    this.failed = true;
    await this.tap?.settle();
    this.out.turnOver();
    this.out.emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: contentText(message?.content),
      api_error_status: row.apiErrorStatus ?? 0,
    });
  }

  private async systemRow(row: TranscriptRow): Promise<void> {
    if (row.subtype !== "turn_duration") {
      return;
    }
    await this.tap?.settle();
    if (!this.failed) {
      this.out.emit({ type: "result", subtype: "success", is_error: false });
    }
    this.failed = false;
    this.out.turnOver();
  }
}

/**
 * An assistant row as `-p` tells it. The row's place in the session goes
 * with it: the bridge branches a conversation off there.
 */
function assistantLine(row: TranscriptRow): Record<string, unknown> {
  const line: Record<string, unknown> = { type: "assistant", message: row.message };
  if (typeof row.uuid === "string" && row.uuid !== "") {
    line.uuid = row.uuid;
  }
  if (typeof row.requestId === "string" && row.requestId !== "") {
    line.request_id = row.requestId;
  }
  if (row.error !== undefined) {
    line.error = row.error;
  }
  return line;
}

interface TranscriptRow {
  type?: string;
  subtype?: string;
  uuid?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  requestId?: string;
  error?: unknown;
  isApiErrorMessage?: boolean;
  apiErrorStatus?: number;
  toolUseResult?: unknown;
  operation?: string;
  apiErrorParams?: unknown;
  message?: unknown;
}

/**
 * Whether a user row's message is one typed in: text, not a tool's result.
 */
export function isPrompt(message: unknown): boolean {
  const content = asRecord(message)?.content;
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content === "string") {
    return content !== "";
  }
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (asRecord(block)?.type === "tool_result") {
      return false;
    }
  }
  return content.length > 0;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  let text = "";
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") {
      text += record.text;
    }
  }
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
