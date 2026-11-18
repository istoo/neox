import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { spawnProcess } from "../../../utils/spawn.js";
import { signalProcessTree } from "../../../utils/tree-kill.js";
import { ClaudeStreamParser, type ClaudeStreamEvent } from "./stream.js";

export interface ClaudeToolResult {
  text: string;
  isError?: boolean;
}

export interface ClaudeRunOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  spawnImpl?: typeof spawn;
  /** The distro Claude Code runs in, when it is a WSL one. */
  wsl?: { distro: string; home: string; projects?: string };
  /** The token the MCP helper's callback URL carries; made here when absent. */
  token?: string;
}

/**
 * What the bridge needs of a run: one `claude -p` process, or Claude Code's
 * interactive mode standing where it would.
 */
export interface ClaudeRunLike {
  readonly token: string;
  readonly pid: number;
  readonly running: boolean;
  /** The session Claude Code keeps this conversation in. */
  readonly sessionId: string;
  /** The tool calls this run made since the caller last took its events. */
  readonly callsMade: ReadonlySet<string>;
  /** The session line that made a tool call, once Claude Code has told it. */
  callUuid?(id: string): string | undefined;
  readonly stderrTail: string;
  start(): void;
  events(): AsyncGenerator<ClaudeStreamEvent>;
  setEventListener(listener: ((event: ClaudeStreamEvent) => void) | null): void;
  sendUserMessage(content: readonly unknown[], uuid?: string): void;
  sendSaid(text: string): void;
  waitsFor(callId: string): boolean;
  deliverToolResult(callId: string, result: ClaudeToolResult): boolean;
  waitForToolResult(callId: string): Promise<ClaudeToolResult | null>;
  abort(): void;
  beginTurn(): AsyncGenerator<ClaudeStreamEvent>;
  waitForExit(): Promise<void>;
}

/**
 * One `claude -p` process, kept for its conversation's next turn. Its stdout
 * is stream-json; a caller's tool calls are answered by the MCP helper's
 * HTTP callback, whose request blocks this run's Claude Code until the
 * client's next request brings the result.
 */
export class ClaudeRun implements ClaudeRunLike {
  public readonly token: string;
  private readonly options: ClaudeRunOptions;
  private readonly parser = new ClaudeStreamParser();
  private child: ChildProcess | null = null;
  private queue: AsyncQueue<ClaudeStreamEvent> | null = null;
  private exited = false;
  private failed = false;
  private stderr = "";
  private readonly pending = new Map<string, (result: ClaudeToolResult | null) => void>();
  private readonly early = new Map<string, ClaudeToolResult>();
  private readonly toolCalls = new Set<string>();
  private onEvent: ((event: ClaudeStreamEvent) => void) | null = null;

  public constructor(options: ClaudeRunOptions) {
    this.options = options;
    this.token = options.token ?? randomBytes(18).toString("hex");
  }

  public get pid(): number {
    return this.child?.pid ?? 0;
  }

  public get running(): boolean {
    return this.child !== null && !this.exited;
  }

  /** The session Claude Code said it keeps this conversation in. */
  public get sessionId(): string {
    return this.parser.sessionId;
  }

  /** The tool calls this run made since the caller last took its events. */
  public get callsMade(): ReadonlySet<string> {
    return this.toolCalls;
  }

  /** The session line that made a tool call, once Claude Code has told it. */
  public callUuid(id: string): string | undefined {
    return this.parser.callUuid(id);
  }

  public start(): void {
    const options = {
      cwd: this.options.cwd,
      env: { ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    };
    // An npm-installed Claude Code is a `.cmd` on Windows, which Node can only
    // launch through cmd.exe; the shared launcher quotes its arguments safely.
    const child =
      this.options.spawnImpl !== undefined
        ? this.options.spawnImpl(this.options.binary, [...this.options.args], options)
        : spawnProcess(this.options.binary, [...this.options.args], options);
    this.child = child;
    this.queue = new AsyncQueue();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const event of this.parser.push(chunk)) {
        this.emit(event);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    child.stdin?.on("error", (error) => {
      this.stdinFailed(error);
    });
    child.on("error", (error) => {
      this.reportFailure(error.message);
    });
    child.on("close", () => {
      this.finish();
    });
  }

  /** What this turn's consumer reads; a turn takes the queue it started with. */
  public events(): AsyncGenerator<ClaudeStreamEvent> {
    this.queue ??= new AsyncQueue();
    return this.queue.drain();
  }

  public setEventListener(listener: ((event: ClaudeStreamEvent) => void) | null): void {
    this.onEvent = listener;
  }

  /** Writes one user message to Claude Code's stdin. */
  public sendUserMessage(content: readonly unknown[], uuid?: string): void {
    const line: Record<string, unknown> = {
      type: "user",
      message: { role: "user", content },
    };
    if (uuid !== undefined) {
      line.uuid = uuid;
    }
    this.write(line);
  }

  /** The words the client added beside its tool results, as its own message. */
  public sendSaid(text: string): void {
    if (text === "") {
      return;
    }
    this.sendUserMessage([{ type: "text", text }], randomBytes(16).toString("hex"));
  }

  /** Whether this run made the call, and so is the one waiting on its result. */
  public waitsFor(callId: string): boolean {
    return this.toolCalls.has(callId);
  }

  /**
   * Hands the client's result to the MCP helper's blocked call. A result that
   * arrives before the call is kept for it.
   */
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

  /** The result of a caller's tool call, as the helper waits for it. */
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
    const child = this.child;
    if (child === null || this.exited) {
      return;
    }
    if (process.platform === "win32") {
      // A `.cmd` shim runs under cmd.exe: killing it alone leaves the script's
      // own process holding the pipes, so the whole tree goes. waitForExit
      // resolves once that tree has closed.
      void signalProcessTree(child, "SIGKILL");
      return;
    }
    child.kill("SIGTERM");
  }

  /** Goes on with a turn after its tool calls; the next events are the reply's. */
  public beginTurn(): AsyncGenerator<ClaudeStreamEvent> {
    this.toolCalls.clear();
    this.queue = new AsyncQueue();
    return this.queue.drain();
  }

  public get stderrTail(): string {
    return this.stderr.trim();
  }

  public waitForExit(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  private readonly exitWaiters: Array<() => void> = [];

  private write(line: Record<string, unknown>): void {
    const stdin = this.child?.stdin;
    if (stdin === null || stdin === undefined) {
      this.reportFailure("can't send a message to Claude Code: its stdin is not available");
      return;
    }
    if (this.exited || stdin.destroyed || !stdin.writable) {
      this.reportFailure(
        this.exited
          ? "can't send a message to Claude Code: its process has exited"
          : "can't send a message to Claude Code: its stdin is not writable",
      );
      return;
    }
    try {
      stdin.write(`${JSON.stringify(line)}\n`);
    } catch (error) {
      this.stdinFailed(error);
    }
  }

  /** A broken stdin pipe fails the run the way a process error does. */
  private stdinFailed(error: unknown): void {
    if (!this.exited) {
      this.abort();
    }
    const reason = error instanceof Error ? error.message : String(error);
    this.reportFailure(`Claude Code's stdin failed: ${reason}`);
  }

  private reportFailure(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.emit({ kind: "error", message });
    this.finish();
  }

  private emit(event: ClaudeStreamEvent): void {
    if (event.kind === "toolCall") {
      this.toolCalls.add(event.id);
    }
    this.onEvent?.(event);
    this.queue?.push(event);
    if (event.kind === "stop") {
      // the turn's reply is over: the request that reads it ends, while the
      // process stays for the conversation's next turn
      this.queue?.close();
      this.queue = null;
    }
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
    for (const waiter of this.pending.values()) {
      waiter(null);
    }
    this.pending.clear();
    for (const resolve of this.exitWaiters.splice(0)) {
      resolve();
    }
  }
}

/** A queue an async iterator drains while a process writes into it. */
export class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  public push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver === undefined) {
      this.items.push(value);
      return;
    }
    resolver({ value, done: false });
  }

  public close(): void {
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  public async *drain(): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve);
      });
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }
}
