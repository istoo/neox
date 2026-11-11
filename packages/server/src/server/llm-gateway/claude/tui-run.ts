import { randomBytes, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ClaudeRunLike, ClaudeRunOptions, ClaudeToolResult } from "./run.js";
import { AsyncQueue } from "./run.js";
import { ClaudeStreamParser, type ClaudeStreamEvent } from "./stream.js";
import { createClaudeTap, type ClaudeTap } from "./tap.js";
import { ClaudeTapReader } from "./tap-reader.js";
import { ClaudeTranscriptTranslator } from "./transcript.js";
import { TuiSession } from "./tui.js";
import { startWslTranscript, type WslTranscript } from "./wsl.js";

export interface ClaudeTuiRunOptions extends ClaudeRunOptions {
  /** Claude Code's project folders for this run's cwd. */
  sessionDirs: readonly string[];
  /** The file the MCP helper writes once Claude Code has listed its tools. */
  listedFile?: string;
  readyTimeoutMs?: number;
  /** Whether the bridge answers the trust question; on by default. */
  trust?: boolean;
  /** How long a message waits for its transcript row, and a turn for its streams. */
  waitMs?: number;
  /** For a test's stand-in for Claude Code's interactive mode. */
  createSession?: (options: ConstructorParameters<typeof TuiSession>[0]) => TuiSession;
  createTap?: typeof createClaudeTap;
}

/**
 * Claude Code's interactive mode standing where `claude -p` does: the same
 * conversation, tools and MCP helper, driven through its screen, with its
 * transcript told on as `-p`'s stream-json. This is the run the bridge keeps
 * for a conversation when `claudePrintMode` is off, as myna does by default.
 */
export class ClaudeTuiRun implements ClaudeRunLike {
  public readonly token: string;
  private readonly options: ClaudeTuiRunOptions;
  private readonly parser = new ClaudeStreamParser();
  private readonly pending = new Map<string, (result: ClaudeToolResult | null) => void>();
  private readonly early = new Map<string, ClaudeToolResult>();
  private readonly toolCalls = new Set<string>();
  private readonly exitWaiters: Array<() => void> = [];
  private rowWaiters: Array<() => void> = [];
  private queue: AsyncQueue<ClaudeStreamEvent> | null = null;
  private onEvent: ((event: ClaudeStreamEvent) => void) | null = null;
  private session: TuiSession | null = null;
  private tap: ClaudeTap | null = null;
  private reader: ClaudeTapReader | null = null;
  private translator: ClaudeTranscriptTranslator | null = null;
  private sid = "";
  private from = 0;
  private rows = 0;
  private busy = false;
  private ready: Promise<void> | null = null;
  private tail: Promise<void> | null = null;
  private transcriptPath: string | null = null;
  private wslReader: WslTranscript | null = null;
  private exited = false;
  private started = false;

  public constructor(options: ClaudeTuiRunOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(18).toString("hex");
  }

  public get pid(): number {
    return this.session?.pid ?? 0;
  }

  public get running(): boolean {
    return this.started && !this.exited;
  }

  public get sessionId(): string {
    return this.sid;
  }

  public get callsMade(): ReadonlySet<string> {
    return this.toolCalls;
  }

  /** The session line that made a tool call, from its transcript row. */
  public callUuid(id: string): string | undefined {
    return this.parser.callUuid(id);
  }

  public get stderrTail(): string {
    return "";
  }

  public start(): void {
    this.queue = new AsyncQueue();
    this.ready = this.bringUp();
    void this.ready.catch((error: unknown) => {
      this.emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      this.finish();
    });
  }

  public events(): AsyncGenerator<ClaudeStreamEvent> {
    this.queue ??= new AsyncQueue();
    return this.queue.drain();
  }

  public setEventListener(listener: ((event: ClaudeStreamEvent) => void) | null): void {
    this.onEvent = listener;
  }

  /** Types one user message into Claude Code's prompt, as a paste. */
  public sendUserMessage(content: readonly unknown[], _uuid?: string): void {
    const ready = this.ready;
    if (ready === null) {
      return;
    }
    void ready
      .then(() => this.paste(messageText(content)))
      .catch((error: unknown) => {
        this.emit({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  public sendSaid(text: string): void {
    if (text !== "") {
      this.sendUserMessage([{ type: "text", text }], randomBytes(16).toString("hex"));
    }
  }

  public waitsFor(callId: string): boolean {
    return this.toolCalls.has(callId);
  }

  public deliverToolResult(callId: string, result: ClaudeToolResult): boolean {
    if (this.exited) {
      return false;
    }
    const waiter = this.pending.get(callId);
    if (waiter !== undefined) {
      this.pending.delete(callId);
      waiter(result);
      return true;
    }
    this.early.set(callId, result);
    return true;
  }

  public waitForToolResult(callId: string): Promise<ClaudeToolResult | null> {
    const early = this.early.get(callId);
    if (early !== undefined) {
      this.early.delete(callId);
      return Promise.resolve(early);
    }
    if (this.exited) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.pending.set(callId, resolve);
    });
  }

  public abort(): void {
    this.session?.kill();
  }

  public beginTurn(): AsyncGenerator<ClaudeStreamEvent> {
    this.toolCalls.clear();
    this.queue = new AsyncQueue();
    return this.queue.drain();
  }

  public waitForExit(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  private async bringUp(): Promise<void> {
    const args = interactiveArgs(this.options.args);
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--resume" && i + 1 < args.length) {
        this.sid = args[i + 1] ?? "";
      }
    }
    if (this.sid === "") {
      this.sid = randomUUID();
      args.push("--session-id", this.sid);
    }
    if (this.options.wsl !== undefined && !(await this.projectsReadable())) {
      // Windows can't read the distro's own folder: the transcript is
      // read inside it, copied to a file of this machine's
      this.wslReader = await startWslTranscript({
        distro: this.options.wsl.distro,
        sid: this.sid,
      });
      await this.wslReader.ready;
      this.transcriptPath = this.wslReader.path;
    }
    this.from = this.transcriptPath === null ? await this.transcriptSize() : 0;
    const tapOptions =
      this.options.env.BUN_OPTIONS === undefined
        ? {}
        : { bunOptions: this.options.env.BUN_OPTIONS };
    this.tap = await (this.options.createTap ?? createClaudeTap)(tapOptions);
    const out = {
      emit: (value: Record<string, unknown>) => this.feed(value),
      sawRow: () => this.sawRow(),
      turnOver: () => {
        this.busy = false;
      },
    };
    this.reader =
      this.tap === null
        ? null
        : new ClaudeTapReader({
            file: this.tap.file,
            sessionId: this.sid,
            out: {
              emit: (value) => this.feed(value),
            },
            ...(this.options.waitMs === undefined ? {} : { waitMs: this.options.waitMs }),
          });
    this.translator = new ClaudeTranscriptTranslator(out);
    if (this.reader !== null) {
      this.translator.tap = this.reader;
    }
    const createSession = this.options.createSession ?? ((options) => new TuiSession(options));
    const session = createSession({
      binary: this.options.binary,
      args,
      cwd: this.options.cwd,
      env: this.options.env,
      ...(this.options.listedFile === undefined ? {} : { listedFile: this.options.listedFile }),
      ...(this.options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.options.readyTimeoutMs }),
      ...(this.options.trust === undefined ? {} : { trust: this.options.trust }),
      ...(this.tap === null ? {} : { tap: this.tap }),
    });
    this.session = session;
    session.start();
    this.started = true;
    await session.ready();
    this.tail = this.readTranscript();
    void session.waitForExit().then(async () => {
      if (this.tail !== null) {
        await this.tail;
      }
      this.finish();
      return undefined;
    });
  }

  /** Reads the session's transcript as Claude Code writes it, from where it started. */
  private async readTranscript(): Promise<void> {
    const file = this.transcriptPath ?? (await this.transcriptFile());
    if (file === null) {
      return;
    }
    const handle = await open(file, "r").catch(() => null);
    if (handle === null) {
      return;
    }
    const decoder = new StringDecoder("utf8");
    let offset = this.from;
    let part = "";
    try {
      for (;;) {
        const buffer = Buffer.alloc(1 << 16);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead > 0) {
          offset += bytesRead;
          part += decoder.write(buffer.subarray(0, bytesRead));
          const lines = part.split("\n");
          part = lines.pop() ?? "";
          for (const line of lines) {
            await this.translator?.row(line);
          }
          continue;
        }
        if (this.exited) {
          if (part !== "") {
            await this.translator?.row(part);
          }
          await this.wslReader?.settle();
          await this.reader?.settle();
          return;
        }
        await sleep(50);
      }
    } finally {
      await handle.close();
    }
  }

  /** Whether the distro's project folder is read through its Windows share. */
  private async projectsReadable(): Promise<boolean> {
    for (const dir of this.options.sessionDirs) {
      if ((await stat(path.dirname(dir)).catch(() => null)) !== null) {
        return true;
      }
    }
    return false;
  }

  /** Where Claude Code keeps this session's transcript; waits for it to be written. */
  private async transcriptFile(): Promise<string | null> {
    for (;;) {
      for (const dir of this.options.sessionDirs) {
        const file = path.join(dir, `${this.sid}.jsonl`);
        if ((await stat(file).catch(() => null)) !== null) {
          return file;
        }
      }
      if (this.exited) {
        return null;
      }
      await sleep(100);
    }
  }

  /** The size the transcript has before this run: a resumed one has earlier turns. */
  private async transcriptSize(): Promise<number> {
    for (const dir of this.options.sessionDirs) {
      const found = await stat(path.join(dir, `${this.sid}.jsonl`)).catch(() => null);
      if (found !== null) {
        return found.size;
      }
    }
    return 0;
  }

  /** Pastes a message into Claude Code's prompt and presses Enter until its row comes. */
  private async paste(text: string): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    const before = this.rows;
    const body = text.trim() === "" ? "." : pasteable(text, this.busy);
    session.clearScreen();
    session.type(`\u001b[200~${body}\u001b[201~`);
    await sleep(150);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      session.enter();
      if (await this.rowAfter(before, 3_000)) {
        return;
      }
    }
    throw new Error(`Claude Code did not take the message: ${session.screen()}`);
  }

  private sawRow(): void {
    this.rows += 1;
    this.busy = true;
    for (const waiter of this.rowWaiters.splice(0)) {
      waiter();
    }
  }

  private rowAfter(before: number, timeoutMs: number): Promise<boolean> {
    if (this.rows > before) {
      return Promise.resolve(true);
    }
    if (this.exited) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(this.rows > before);
      };
      const timer = setTimeout(() => {
        this.rowWaiters = this.rowWaiters.filter((waiter) => waiter !== check);
        settle();
      }, timeoutMs);
      const check = (): void => {
        clearTimeout(timer);
        settle();
      };
      this.rowWaiters.push(check);
    });
  }

  private feed(value: Record<string, unknown>): void {
    for (const event of this.parser.push(`${JSON.stringify(value)}\n`)) {
      this.emit(event);
    }
    // the transcript tells a turn's end as `-p`'s result, its last line
    if (value.type === "result") {
      this.closeTurn();
    }
  }

  private emit(event: ClaudeStreamEvent): void {
    if (event.kind === "toolCall") {
      this.toolCalls.add(event.id);
    }
    this.onEvent?.(event);
    this.queue?.push(event);
    if (event.kind === "stop") {
      this.closeTurn();
    }
  }

  private closeTurn(): void {
    this.queue?.close();
    this.queue = null;
  }

  private finish(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const event of this.parser.end()) {
      this.emit(event);
    }
    this.queue?.close();
    this.queue = null;
    for (const waiter of this.pending.values()) {
      waiter(null);
    }
    this.pending.clear();
    for (const waiter of this.rowWaiters.splice(0)) {
      waiter();
    }
    for (const resolve of this.exitWaiters.splice(0)) {
      resolve();
    }
    if (this.wslReader !== null) {
      void this.wslReader.stop();
      this.wslReader = null;
    }
    if (this.tap !== null) {
      void this.tap.drop();
    }
  }
}

/** A user message's words, as they can be pasted into Claude Code's prompt. */
function messageText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n\n");
}

/**
 * Text as a paste can carry it: no escape that would end the paste early,
 * nor other control characters, and not opening with what Claude Code's
 * prompt takes as a command.
 */
function pasteable(text: string, busy: boolean): string {
  const clean = stripControl(text.replaceAll("\r\n", "\n").replace(/\r/g, "\n"));
  const trimmed = clean.replace(/^[ \t\n]+/, "");
  if (trimmed !== "" && "/!#&".includes(trimmed[0] ?? "")) {
    return busy ? `[user message]\n${trimmed}` : `\n${trimmed}`;
  }
  return clean;
}

/**
 * `claude -p`'s arguments made the interactive mode's: the same model,
 * tools, MCP servers, settings, effort, system prompt and session, without
 * what only `-p` takes; the bridge's tools allowed without a prompt.
 */
export function interactiveArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  const allowed = ["mcp__neox"];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    switch (arg) {
      case "-p":
      case "--print":
      case "--verbose":
      case "--include-partial-messages":
      case "--dangerously-skip-permissions":
      case "--no-session-persistence":
      case "--replay-user-messages":
        continue;
      case "--output-format":
      case "--input-format":
      case "--thinking-display":
      case "--json-schema":
      case "--permission-mode":
        i += 1;
        continue;
      case "--tools": {
        const tools = args[i + 1] ?? "";
        for (const tool of tools.split(/[\s,]+/).filter(Boolean)) {
          allowed.push(tool);
        }
        break;
      }
      default:
        break;
    }
    out.push(arg);
  }
  return [
    ...out,
    "--permission-mode",
    "default",
    "--allowedTools",
    allowed.join(","),
    "--no-chrome",
  ];
}

/** Text without the control characters a paste cannot carry; lines and tabs stay. */
function stripControl(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 ? char === "\n" || char === "\t" : code !== 0x7f) {
      out += char;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
