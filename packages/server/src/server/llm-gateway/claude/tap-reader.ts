import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** Where a tap's stream events go, as `claude -p` tells them. */
export interface ClaudeTapReadOutput {
  emit(value: Record<string, unknown>): void;
}

export interface ClaudeTapReaderOptions {
  /** The file tap.cjs writes its JSON lines to. */
  file: string;
  /** The session's id, told with every stream event. */
  sessionId: string;
  out: ClaudeTapReadOutput;
  /** How long a message waits for its stream, and a turn's end for its streams. */
  waitMs?: number;
  /** How often the tap is read while a wait goes on. */
  pollMs?: number;
}

interface TapStream {
  id: string;
  stopped: boolean;
}

/**
 * Reads what tap.cjs writes: each of the main turn's replies as Anthropic
 * streams it, before Claude Code's transcript has the whole message. A tap
 * that isn't there (Claude Code isn't Bun, or doesn't load it) says so, and
 * the translator tells each reply whole.
 */
export class ClaudeTapReader {
  private readonly options: ClaudeTapReaderOptions;
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  private part = "";
  /** tap.cjs was loaded and taps Claude Code's requests. */
  private on = false;
  /** The streams going, by tap.cjs's number, once their message_start comes. */
  private readonly open = new Map<number, TapStream>();
  private readonly ended = new Set<number>();
  private readonly started = new Set<string>();
  /** The messages told whole, as their stream came late. */
  private readonly dropped = new Set<string>();

  public constructor(options: ClaudeTapReaderOptions) {
    this.options = options;
  }

  public get tapping(): boolean {
    return this.on;
  }

  /** Tells what tap.cjs wrote since it was last read. */
  public async read(): Promise<void> {
    const handle = await open(this.options.file, "r").catch(() => null);
    if (handle === null) {
      return;
    }
    // the file is opened for this read alone: nothing is held between
    // reads, so a reader a caller drops holds no file open
    try {
      for (;;) {
        const buffer = Buffer.alloc(1 << 16);
        const { bytesRead: bytes } = await handle.read(buffer, 0, buffer.length, this.offset);
        if (bytes === 0) {
          return;
        }
        this.offset += bytes;
        this.part += this.decoder.write(buffer.subarray(0, bytes));
        let end = this.part.indexOf("\n");
        while (end >= 0) {
          this.line(this.part.slice(0, end));
          this.part = this.part.slice(end + 1);
          end = this.part.indexOf("\n");
        }
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Called before the transcript's message id is told: a message streamed
   * is told after its stream has begun; one whose stream doesn't come
   * within the wait is told whole, its stream left out. A message no
   * stream can be (no reply is being read) waits for none.
   */
  public async before(id: string): Promise<void> {
    await this.read();
    if (!this.on || this.started.has(id) || this.dropped.has(id)) {
      return;
    }
    const until = Date.now() + (this.options.waitMs ?? 1_000);
    while (this.going(true) && Date.now() < until) {
      await sleep(this.options.pollMs ?? 10);
      await this.read();
      if (this.started.has(id)) {
        return;
      }
    }
    this.dropped.add(id);
  }

  /**
   * Called before a turn's end is told: its streams end first, within the
   * wait, and one still going then ends there.
   */
  public async settle(): Promise<void> {
    await this.read();
    const until = Date.now() + (this.options.waitMs ?? 1_000);
    while (this.going(false) && Date.now() < until) {
      await sleep(this.options.pollMs ?? 10);
      await this.read();
    }
    for (const n of this.open.keys()) {
      this.end(n);
    }
  }

  private line(line: string): void {
    let l: TapLine;
    try {
      l = JSON.parse(line) as TapLine;
    } catch {
      return;
    }
    if (l === null || typeof l !== "object" || this.ended.has(l.s ?? -1)) {
      return;
    }
    if (typeof l.tap === "string") {
      this.on = l.tap === "on";
      return;
    }
    if (l.open === true) {
      this.open.set(l.s ?? 0, { id: "", stopped: false });
      return;
    }
    if (l.e !== undefined) {
      this.event(l);
      return;
    }
    if (typeof l.end === "string") {
      this.end(l.s ?? 0);
    }
  }

  private event(l: TapLine): void {
    const n = l.s ?? 0;
    const e = asRecord(l.e);
    if (e === null) {
      return;
    }
    let stream = this.open.get(n);
    if (e.type === "message_start") {
      stream = { id: asRecord(e.message)?.id as string, stopped: false };
      this.open.set(n, stream);
      if (this.dropped.has(stream.id)) {
        return;
      }
      this.started.add(stream.id);
    }
    if (stream === undefined || stream.id === "" || this.dropped.has(stream.id)) {
      return;
    }
    if (e.type === "message_stop") {
      stream.stopped = true;
    }
    this.options.out.emit({
      type: "stream_event",
      event: l.e,
      session_id: this.options.sessionId,
      parent_tool_use_id: null,
    });
  }

  /**
   * Ends stream n: one cut short ends as Claude Code ends such a stream in
   * `-p`, with a message_stop and no message_delta, which the bridge takes
   * as an attempt it asks again after.
   */
  private end(n: number): void {
    const stream = this.open.get(n);
    this.open.delete(n);
    this.ended.add(n);
    if (
      stream !== undefined &&
      stream.id !== "" &&
      !stream.stopped &&
      !this.dropped.has(stream.id)
    ) {
      this.options.out.emit({
        type: "stream_event",
        event: { type: "message_stop" },
        session_id: this.options.sessionId,
        parent_tool_use_id: null,
      });
    }
  }

  /** Whether a stream is open, one with no message yet if bare. */
  private going(bare: boolean): boolean {
    for (const stream of this.open.values()) {
      if (!bare || stream.id === "") {
        return true;
      }
    }
    return false;
  }
}

interface TapLine {
  tap?: string;
  s?: number;
  open?: boolean;
  end?: string;
  e?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
