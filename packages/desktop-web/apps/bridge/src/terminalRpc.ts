// Synara terminal RPCs backed by the Neox daemon's terminal API.
//
// Neox terminals are keyed by a daemon-minted id and addressed by cwd; Synara
// addresses them by (threadId, terminalId). The bridge keeps that mapping, owns
// one live observation per daemon terminal, and translates the daemon's binary
// replay/output frames into Synara's `TerminalEvent` stream.
//
// Ordering: the daemon delivers replay frames and then live output in order, and
// every frame is decoded and emitted synchronously from that single callback, so
// the client sees one ordered stream. The initial replay is folded into the
// `terminal.open` snapshot; later replays (transport reconnects) are emitted as
// `cleared` followed by `output` so the renderer rebuilds the screen in place.
//
// The daemon delivers PTY exit codes on its stream-exit message and terminal activity through
// its terminals listing. The bridge forwards both as Synara `exited` and `activity` events.
import {
  DEFAULT_TERMINAL_ID,
  type TerminalCharacterWidths,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalFocusHeartbeatInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
  WS_METHODS,
  WsRpcError,
} from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { TerminalStreamEvent } from "../../../../client/dist/daemon-client.js";
import type { BridgeModel } from "./model.ts";
import { bridgeError, codedError, fromPromise, rpcError as toRpcError } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

/** The daemon's first replay can be large; the open call waits this long at most. */
const INITIAL_REPLAY_TIMEOUT_MS = 15_000;

function now(): string {
  return new Date().toISOString();
}

function fromSubscription<A>(subscribe: (emit: (item: A) => void) => () => void): Stream.Stream<A> {
  // debt: the stream queue is unbounded. A client that stops draining grows
  // bridge memory; a bounded queue would need an overflow resync
  // (`cleared` plus a fresh replay) to avoid dropping terminal state.
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((item) => Queue.offerUnsafe(queue, item))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

function rpcError(_method: string, cause: unknown): WsRpcError {
  return toRpcError(cause);
}

function terminalKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

/** The contract's decoded inputs apply DEFAULT_TERMINAL_ID; mirror that here. */
function terminalIdOf(terminalId: string | undefined): string {
  return terminalId ?? DEFAULT_TERMINAL_ID;
}

interface TerminalActivityUpdate {
  hasRunningSubprocess: boolean;
  agentState: "running" | "attention" | "review" | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The daemon's activity has one state plus an attention reason; Synara models a running
 * subprocess and an agent attention state separately. `finished` is a review prompt, and
 * `needs_input` is attention, matching the daemon's own status bucket.
 */
function activityUpdate(activity: unknown): TerminalActivityUpdate {
  if (!isRecord(activity)) return { hasRunningSubprocess: false, agentState: null };
  const reason = activity.attentionReason;
  if (reason === "needs_input") return { hasRunningSubprocess: true, agentState: "attention" };
  if (reason === "finished") return { hasRunningSubprocess: true, agentState: "review" };
  if (activity.state === "working") return { hasRunningSubprocess: true, agentState: "running" };
  if (activity.state === "attention")
    return { hasRunningSubprocess: true, agentState: "attention" };
  return { hasRunningSubprocess: false, agentState: null };
}

function sameActivity(left: TerminalActivityUpdate | null, right: TerminalActivityUpdate): boolean {
  return (
    left !== null &&
    left.hasRunningSubprocess === right.hasRunningSubprocess &&
    left.agentState === right.agentState
  );
}

/**
 * The daemon parses its headless buffer with UAX #29 grapheme widths when it advertises
 * `terminal-grapheme-widths`. A client re-parses the daemon's replay with its own table, so a
 * disagreement shifts the cursor and every later cell on rows holding an emoji or conjunct.
 * Older daemons omit the feature; the web terminal then keeps Unicode 11.
 */
function characterWidthsForClient(client: BridgeModel["client"]): TerminalCharacterWidths {
  return client.getLastServerInfoMessage()?.features?.["terminal-grapheme-widths"] === true
    ? "graphemes"
    : "unicode11";
}

/** The daemon terminal name is unique per Synara session, so reattach can find it. */
function terminalName(threadId: string, terminalId: string): string {
  return `synara:${threadId}:${terminalId}`;
}

/**
 * Ends every daemon terminal a thread opened. The web leaves terminal cleanup on delete to the
 * server, and a daemon terminal outlives the bridge session that created it.
 */
export async function killThreadTerminals(
  client: BridgeModel["client"],
  threadId: string,
): Promise<void> {
  const prefix = terminalName(threadId, "");
  const { terminals } = await client.listTerminals();
  await Promise.all(
    terminals
      .filter((terminal) => terminal.name?.startsWith(prefix))
      .map((terminal) => client.killTerminal(terminal.id)),
  );
}

interface TerminalSession {
  readonly threadId: string;
  readonly terminalId: string;
  readonly daemonId: string;
  readonly cwd: string;
  readonly observation: ReturnType<BridgeModel["client"]["observeTerminal"]>;
  observationReady?: Promise<void>;
  decoder: InstanceType<typeof TextDecoder>;
  history: string;
  replayText: string;
  initializing: boolean;
  exited: boolean;
  /** The program's exit code, reported by the daemon when it ends on its own. */
  exitCode: number | null;
  activity: TerminalActivityUpdate | null;
  terminalsObservation: { release(): Promise<void> } | null;
  /** True when the daemon terminal outlives this session (a workspace script PTY). */
  attached: boolean;
  resolveInitialReplay: () => void;
  initialReplay: Promise<void>;
}

function createSessionBase(input: {
  threadId: string;
  terminalId: string;
  daemonId: string;
  cwd: string;
  attached?: boolean;
}): Omit<TerminalSession, "observation"> {
  let resolveInitialReplay = () => {};
  const initialReplay = new Promise<void>((resolve) => {
    resolveInitialReplay = resolve;
  });
  return {
    ...input,
    attached: input.attached ?? false,
    decoder: new TextDecoder(),
    history: "",
    replayText: "",
    initializing: true,
    exited: false,
    exitCode: null,
    activity: null,
    terminalsObservation: null,
    resolveInitialReplay,
    initialReplay,
  };
}

class TerminalSessions {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly opening = new Map<string, Promise<TerminalSessionSnapshot>>();
  // Sizes that arrive between write/fit and the daemon terminal's creation. Dropping them leaves
  // the PTY at 80x24 while xterm draws the real width, which wraps zsh's prompt in the wrong
  // place, so the latest one is replayed once the session exists.
  private readonly pendingResizes = new Map<string, { cols: number; rows: number }>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();

  constructor(private readonly client: BridgeModel["client"]) {}

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async open(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const key = terminalKey(input.threadId, terminalIdOf(input.terminalId));
    const pending = this.opening.get(key);
    if (pending) return pending;

    const task = this.openSession(input);
    this.opening.set(key, task);
    try {
      return await task;
    } finally {
      this.opening.delete(key);
      // A failed open leaves nothing to apply queued sizes to; a successful one already drained
      // them in claimInitialSize.
      this.pendingResizes.delete(key);
    }
  }

  private async openSession(input: TerminalOpenInput): Promise<TerminalSessionSnapshot> {
    const terminalId = terminalIdOf(input.terminalId);
    const key = terminalKey(input.threadId, terminalId);
    const current = this.sessions.get(key);
    if (current && !current.exited) {
      // Reconcile/reopen calls carry the renderer's current size; the existing PTY may have been
      // created or resized with a different one.
      this.applyInitialSize(current, input.cols, input.rows, key);
      return this.snapshot(current);
    }
    if (current) {
      await this.stop(current);
      this.sessions.delete(key);
    }

    const { daemonId, cwd, attached } = await this.findOrCreate(input);
    // Claim the renderer's size before subscribing. The daemon serializes the initial replay
    // from its headless buffer, so a size applied afterwards would replay (and let the shell
    // redraw) at the old width — zsh then wraps its prompt and the echoed input where xterm
    // does not. A size queued while the PTY was being created wins over the one the caller
    // captured before the open.
    this.claimInitialSize(daemonId, input.cols, input.rows, key);
    const session = this.attach(
      createSessionBase({
        threadId: input.threadId,
        terminalId,
        daemonId,
        cwd,
        attached,
      }),
    );
    this.sessions.set(key, session);

    try {
      await session.observationReady;
    } catch (cause) {
      this.pendingResizes.delete(key);
      await this.stop(session);
      this.sessions.delete(key);
      throw rpcError("terminal.open", cause);
    }

    const timedOut = await Promise.race([
      session.initialReplay.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), INITIAL_REPLAY_TIMEOUT_MS)),
    ]);
    if (timedOut) session.initializing = false;
    session.resolveInitialReplay();

    const snapshot = this.snapshot(session);
    // The caller replays `snapshot.history`; the lifecycle event carries no history
    // so a listener that also saw the event does not repaint the screen twice.
    this.emit({
      type: "started",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: now(),
      snapshot: { ...snapshot, history: "" },
    });
    return snapshot;
  }

  async restart(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const key = terminalKey(input.threadId, terminalIdOf(input.terminalId));
    const task = this.restartSession(input);
    this.opening.set(key, task);
    try {
      return await task;
    } finally {
      this.opening.delete(key);
      this.pendingResizes.delete(key);
    }
  }

  private async restartSession(input: TerminalRestartInput): Promise<TerminalSessionSnapshot> {
    const terminalId = terminalIdOf(input.terminalId);
    const key = terminalKey(input.threadId, terminalId);
    const current = this.sessions.get(key);
    if (current?.attached) {
      throw codedError(
        "terminal.restart-attached",
        "terminal.restart: an attached terminal is owned by the host; restart it from its own surface.",
        undefined,
        { retryable: false },
      );
    }
    if (current) {
      await this.stop(current);
      this.sessions.delete(key);
      await this.killDaemon(current.daemonId);
    }

    const { daemonId, cwd } = await this.findOrCreate(input);
    this.claimInitialSize(daemonId, input.cols, input.rows, key);
    const session = this.attach(
      createSessionBase({
        threadId: input.threadId,
        terminalId,
        daemonId,
        cwd,
      }),
    );
    this.sessions.set(key, session);
    try {
      await session.observationReady;
    } catch (cause) {
      this.pendingResizes.delete(key);
      await this.stop(session);
      this.sessions.delete(key);
      throw rpcError("terminal.restart", cause);
    }
    await Promise.race([
      session.initialReplay,
      new Promise<void>((resolve) => setTimeout(resolve, INITIAL_REPLAY_TIMEOUT_MS)),
    ]);
    session.initializing = false;
    session.resolveInitialReplay();

    const snapshot = this.snapshot(session);
    this.emit({
      type: "restarted",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: now(),
      snapshot: { ...snapshot, history: "" },
    });
    return snapshot;
  }

  write(input: TerminalWriteInput): void {
    const session = this.require(input.threadId, terminalIdOf(input.terminalId), "terminal.write");
    try {
      this.client.sendTerminalInput(session.daemonId, { type: "input", data: input.data });
    } catch (cause) {
      throw rpcError("terminal.write", cause);
    }
  }

  resize(input: TerminalResizeInput): void {
    const terminalId = terminalIdOf(input.terminalId);
    const key = terminalKey(input.threadId, terminalId);
    const session = this.sessions.get(key);
    if (!session || session.exited) {
      // A fit performed while `open` is still creating the PTY has no session to address yet.
      // Keep the latest size and let open apply it instead of failing the renderer's resize.
      if (this.opening.has(key)) {
        this.pendingResizes.set(key, { cols: input.cols, rows: input.rows });
        return;
      }
      throw codedError(
        "terminal.not-open",
        `terminal.resize: terminal ${terminalId} is not open for thread ${input.threadId}.`,
        { terminal: terminalId, thread: input.threadId },
        { retryable: false },
      );
    }
    this.sendResize(session, input.cols, input.rows, "update");
  }

  private sendResize(
    session: TerminalSession,
    cols: number,
    rows: number,
    intent: "claim" | "update",
  ): void {
    try {
      this.client.sendTerminalInput(session.daemonId, {
        type: "resize",
        cols,
        rows,
        intent,
      });
    } catch (cause) {
      throw rpcError("terminal.resize", cause);
    }
  }

  /**
   * Claims the renderer's size on a daemon terminal before subscribing. The daemon serializes
   * its replay buffer at the PTY's size, and only the client that claimed the size may change
   * it afterwards (`intent: "update"` from anyone else is dropped), so this both makes the
   * initial replay match xterm's grid and keeps later fits effective. A size queued while the
   * PTY was being created wins over the one captured before the open.
   */
  private claimInitialSize(
    daemonId: string,
    cols: number | undefined,
    rows: number | undefined,
    key: string,
  ): void {
    const pending = this.pendingResizes.get(key);
    this.pendingResizes.delete(key);
    const size = pending ?? (cols !== undefined && rows !== undefined ? { cols, rows } : undefined);
    if (!size) return;
    try {
      this.client.sendTerminalInput(daemonId, {
        type: "resize",
        cols: size.cols,
        rows: size.rows,
        intent: "claim",
      });
    } catch {
      // A failed initial resize must not turn a usable terminal into an open error.
    }
  }

  /** Applies the renderer's size to a session that already exists (reopen/reconcile). */
  private applyInitialSize(
    session: TerminalSession,
    cols: number | undefined,
    rows: number | undefined,
    key: string,
  ): void {
    this.claimInitialSize(session.daemonId, cols, rows, key);
  }

  clear(input: { threadId: string; terminalId?: string | undefined }): void {
    const session = this.require(input.threadId, terminalIdOf(input.terminalId), "terminal.clear");
    // The daemon owns its scrollback and exposes no clear operation. Reset the
    // bridge's replay transcript so a later open does not resurrect the content,
    // and tell the renderer to clear its view.
    session.history = "";
    session.decoder = new TextDecoder();
    this.emit({
      type: "cleared",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: now(),
    });
  }

  /**
   * Clears the daemon's terminal attention when the visible page actually focuses
   * one of our terminals. The caller names a Synara session, not a daemon id; an
   * unknown pair or a hidden page reports no terminal so a forged or stale id
   * cannot clear a sibling pane's or another daemon's attention.
   */
  focusHeartbeat(input: TerminalFocusHeartbeatInput): void {
    const session = input.terminalId
      ? this.sessions.get(terminalKey(input.threadId, input.terminalId))
      : undefined;
    const focusedTerminalId =
      input.appVisible && session && !session.exited ? session.daemonId : null;
    try {
      this.client.sendHeartbeat({
        deviceType: "web",
        // The daemon requires the field. This bridge has no agent-focus source, so
        // it reports null. The heartbeat belongs to this bridge's own client
        // session and cannot change another connected client's focus.
        focusedAgentId: null,
        focusedTerminalId,
        lastActivityAt: new Date().toISOString(),
        appVisible: input.appVisible,
      });
    } catch {
      // Focus reporting is best-effort: a dropped transport must not fail the UI.
    }
  }

  async close(input: TerminalCloseInput): Promise<void> {
    const key = terminalKey(input.threadId, input.terminalId ?? "default");
    const session = this.sessions.get(key);
    if (session) {
      await this.stop(session);
      this.sessions.delete(key);
      // An attached session is a viewer for a host-owned PTY (a workspace script):
      // closing the view must not stop the process behind it.
      if (!session.attached) await this.killDaemon(session.daemonId);
      return;
    }
    // A bridge restart drops the in-memory map; find the daemon terminal by the
    // name this bridge assigned to it so close still releases the PTY.
    const daemonId = await this.findDaemonId(input.threadId, input.terminalId ?? "default");
    if (daemonId) await this.killDaemon(daemonId);
  }

  private require(threadId: string, terminalId: string, method: string): TerminalSession {
    const session = this.sessions.get(terminalKey(threadId, terminalId));
    if (!session || session.exited) {
      throw codedError(
        "terminal.not-open",
        `${method}: terminal ${terminalId} is not open for thread ${threadId}.`,
        { terminal: terminalId, thread: threadId },
        { retryable: false },
      );
    }
    return session;
  }

  private async findOrCreate(
    input: TerminalOpenInput,
  ): Promise<{ daemonId: string; cwd: string; attached: boolean }> {
    // debt: `input.providerAuthInstanceId` names the account a sign-in is for,
    // but the daemon's `create_terminal_request` carries no HOME/env, so an
    // extra account's sign-in runs as the host's default. Multi-account
    // sign-in needs a daemon-side sign-in or an env-carrying terminal.
    if (input.attachToDaemonTerminalId) {
      const terminal = (await this.client.listTerminals()).terminals.find(
        (candidate) => candidate.id === input.attachToDaemonTerminalId,
      );
      if (!terminal) {
        throw codedError(
          "terminal.not-found",
          `terminal.open failed: the host no longer has terminal ${input.attachToDaemonTerminalId}.`,
          { terminal: input.attachToDaemonTerminalId },
          { retryable: false },
        );
      }
      return { daemonId: terminal.id, cwd: terminal.cwd ?? input.cwd, attached: true };
    }
    const name = terminalName(input.threadId, terminalIdOf(input.terminalId));
    const existing = await this.findDaemonTerminal(name).catch(() => undefined);
    if (existing) return { daemonId: existing.id, cwd: existing.cwd ?? input.cwd, attached: false };

    const size =
      input.cols !== undefined && input.rows !== undefined
        ? { cols: input.cols, rows: input.rows }
        : undefined;
    let created;
    try {
      created = await this.client.createTerminal(input.cwd, name, undefined, {
        ...(size ? { size } : {}),
        ...(input.profile
          ? { command: input.profile.command, args: [...(input.profile.args ?? [])] }
          : {}),
      });
    } catch (cause) {
      throw rpcError("terminal.open", cause);
    }
    if (!created.terminal) {
      throw codedError(
        "terminal.open-failed",
        `terminal.open failed: ${created.error ?? "the daemon did not create a terminal"}`,
        created.error ? { detail: created.error } : undefined,
        { retryable: true },
      );
    }
    return { daemonId: created.terminal.id, cwd: created.terminal.cwd, attached: false };
  }

  private async findDaemonId(threadId: string, terminalId: string): Promise<string | undefined> {
    return (await this.findDaemonTerminal(terminalName(threadId, terminalId)))?.id;
  }

  private async findDaemonTerminal(
    name: string,
  ): Promise<{ id: string; cwd?: string | undefined } | undefined> {
    const list = await this.client.listTerminals();
    return list.terminals.find((terminal) => terminal.name === name);
  }

  private attach(session: Omit<TerminalSession, "observation">): TerminalSession {
    const full = session as TerminalSession;
    const observation = this.client.observeTerminal(
      session.daemonId,
      (event) => this.onStreamEvent(full, event),
      { restore: { mode: "full-snapshot" } },
    );
    // `observeTerminal` mutates its returned handle in place; assigning it after
    // construction keeps the receive callback's captured session complete.
    (full as { observation: TerminalSession["observation"] }).observation = observation;
    full.observationReady = observation.ready.then((payload) => {
      if ("error" in payload && payload.error !== null) {
        throw bridgeError("terminal.observation-failed", payload.error, { detail: payload.error });
      }
    });
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "terminal_stream_exit") {
          const exitCode =
            typeof (message.payload as { exitCode?: unknown }).exitCode === "number"
              ? (message.payload as { exitCode: number }).exitCode
              : null;
          this.onStreamExit(full, message.payload.error, exitCode);
        }
      },
      error: (error) => this.onStreamExit(full, error, null),
    });
    this.observeActivity(full);
    return full;
  }

  private observeActivity(session: TerminalSession): void {
    const observation = this.client.observeTerminals({ cwd: session.cwd });
    session.terminalsObservation = observation;
    const apply = (terminals: readonly unknown[]) => {
      const entry = terminals.find(
        (candidate): candidate is { id: string; activity?: unknown } =>
          isRecord(candidate) && candidate.id === session.daemonId,
      );
      if (!entry) return;
      const next = activityUpdate(entry.activity);
      if (sameActivity(session.activity, next)) return;
      session.activity = next;
      this.emit({
        type: "activity",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: now(),
        cliKind: null,
        ...next,
      });
    };
    observation.subscribe({
      snapshot: (snapshot) => apply(snapshot.terminals),
      update: (message) => {
        if (message.type === "terminals_changed") apply(message.payload.terminals);
      },
      error: () => undefined,
    });
  }

  private onStreamEvent(session: TerminalSession, event: TerminalStreamEvent): void {
    if (event.type === "output") {
      this.appendOutput(session, event.data, event.data.byteLength);
      return;
    }
    switch (event.replay.type) {
      case "begin":
        session.replayText = "";
        // A replay starts a new byte stream; drop any partial UTF-8 sequence
        // left over from the live tail so it cannot leak into the replay.
        session.decoder = new TextDecoder();
        if (!session.initializing) {
          // A reconnect replays the daemon's authoritative screen. Reset both the
          // renderer and our transcript before streaming it as ordinary output.
          session.history = "";
          this.emit({
            type: "cleared",
            threadId: session.threadId,
            terminalId: session.terminalId,
            createdAt: now(),
          });
        }
        return;
      case "data":
        if (session.initializing) {
          session.replayText += session.decoder.decode(event.replay.data, { stream: true });
        } else {
          this.appendOutput(session, event.replay.data, event.replay.data.byteLength);
        }
        return;
      case "end":
        if (session.initializing) {
          session.history = session.replayText;
          session.replayText = "";
        }
        session.initializing = false;
        session.resolveInitialReplay();
        return;
    }
  }

  private appendOutput(session: TerminalSession, data: Uint8Array, byteLength: number): void {
    const text = session.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    session.history += text;
    this.emit({
      type: "output",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: now(),
      data: text,
      byteLength,
    });
  }

  private onStreamExit(session: TerminalSession, error: unknown, exitCode: number | null): void {
    if (session.exited) return;
    session.exited = true;
    session.exitCode = exitCode;
    void session.terminalsObservation?.release().catch(() => undefined);
    session.terminalsObservation = null;
    session.initializing = false;
    session.resolveInitialReplay();
    if (typeof error === "string" && error.length > 0) {
      this.emit({
        type: "error",
        threadId: session.threadId,
        terminalId: session.terminalId,
        createdAt: now(),
        message: error,
      });
      return;
    }
    this.emit({
      type: "exited",
      threadId: session.threadId,
      terminalId: session.terminalId,
      createdAt: now(),
      exitCode,
      exitSignal: null,
    });
  }

  private snapshot(session: TerminalSession): TerminalSessionSnapshot {
    return {
      threadId: session.threadId,
      terminalId: session.terminalId,
      cwd: session.cwd,
      status: session.exited ? "exited" : "running",
      pid: null,
      history: session.history,
      characterWidths: characterWidthsForClient(this.client),
      exitCode: session.exitCode,
      exitSignal: null,
      updatedAt: now(),
    };
  }

  private async stop(session: TerminalSession): Promise<void> {
    try {
      await session.observation.release();
    } catch {
      // The observation may already have been released by a stream exit.
    }
    try {
      await session.terminalsObservation?.release();
    } catch {
      // The terminal listing may already have been released with its stream.
    }
    session.terminalsObservation = null;
  }

  private async killDaemon(daemonId: string): Promise<void> {
    try {
      await this.client.killTerminal(daemonId);
    } catch (cause) {
      throw rpcError("terminal.close", cause);
    }
  }
}

export function makeTerminalHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const sessions = new TerminalSessions(model.client);
  return {
    [WS_METHODS.terminalOpen]: (payload) =>
      fromPromise("terminal.open", () => sessions.open(payload as TerminalOpenInput)),
    [WS_METHODS.terminalWrite]: (payload) =>
      Effect.try({
        try: () => sessions.write(payload as TerminalWriteInput),
        catch: (cause) => (cause instanceof WsRpcError ? cause : rpcError("terminal.write", cause)),
      }),
    [WS_METHODS.terminalResize]: (payload) =>
      Effect.try({
        try: () => sessions.resize(payload as TerminalResizeInput),
        catch: (cause) =>
          cause instanceof WsRpcError ? cause : rpcError("terminal.resize", cause),
      }),
    // The daemon applies its own transport backpressure and never waited for
    // Synara's parser ACKs, so acknowledgements have nothing to release.
    [WS_METHODS.terminalAckOutput]: () => Effect.void,
    [WS_METHODS.terminalClear]: (payload) =>
      Effect.try({
        try: () => sessions.clear(payload as { threadId: string; terminalId?: string | undefined }),
        catch: (cause) => (cause instanceof WsRpcError ? cause : rpcError("terminal.clear", cause)),
      }),
    [WS_METHODS.terminalRestart]: (payload) =>
      fromPromise("terminal.restart", () => sessions.restart(payload as TerminalRestartInput)),
    [WS_METHODS.terminalClose]: (payload) =>
      fromPromise("terminal.close", () => sessions.close(payload as TerminalCloseInput)),
    [WS_METHODS.terminalFocusHeartbeat]: (payload) =>
      Effect.sync(() => sessions.focusHeartbeat(payload as TerminalFocusHeartbeatInput)),
    [WS_METHODS.subscribeTerminalEvents]: () =>
      fromSubscription<TerminalEvent>((emit) => sessions.subscribe(emit)),
  };
}
