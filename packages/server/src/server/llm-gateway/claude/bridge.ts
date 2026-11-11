import { createHash } from "node:crypto";
import type { spawn } from "node:child_process";
import { CLAUDE_NOT_INSTALLED, claudeCliArgs, findClaudeBinary, type ClaudeLaunch } from "./cli.js";
import {
  callsTool,
  type ClaudePromptMessage,
  renderClaudePrompt,
  renderClaudeTurn,
  resolveCalledTool,
  type ClaudeTurnRequest,
  turnKey,
} from "./prompt.js";
import type { ClientCacheMarks } from "./cache.js";
import type { IrMessage } from "../ir.js";
import { lostMedia } from "../vision-lost-media.js";
import { writeReplaySession } from "./replay.js";
import { ClaudeRoom, runsMostFor } from "./room.js";
import { claudeRunBudget, oversizedRun, type ProcessReader } from "./rss.js";
import { ClaudeRun, type ClaudeRunLike, type ClaudeRunOptions } from "./run.js";
import type { ClaudeAnswer } from "./schema.js";
import { ClaudeSessionShelf, cutSession } from "./sessions.js";
import type { ClaudeStreamEvent } from "./stream.js";
import type { ClaudeToolSpec } from "./tools.js";

export interface ClaudeTurnInput {
  /** Whom the run serves: provider, account and model. */
  owner: string;
  model: string;
  request: ClaudeTurnRequest;
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** The `--mcp-config` JSON for this run. */
  mcpConfig: string;
  /** The token the helper's callback URL carries, when the caller made the files. */
  runToken?: string;
  /** The request's IR messages, whose media a client may have taken out. */
  irMessages?: readonly IrMessage[];
  /** The caller's own cache marks, replayed on a prompt built anew. */
  cacheMarks?: ClientCacheMarks;
  /** Claude Code's project folders for cwd, when sessions are kept. */
  sessionDirs?: readonly string[];
  effort?: string;
  webSearch?: boolean;
  thinkingOff?: boolean;
  jsonSchema?: string;
  systemPromptFile?: string;
  /** The interactive mode's own runs: taken where the bridge makes one that way. */
  tui?: ClaudeTuiTurn;
  /** The answer tool a request with a JSON schema is answered through. */
  answer?: ClaudeAnswer;
}

export interface ClaudeTuiTurn {
  listedFile: string;
  readyTimeoutMs?: number;
  trust?: boolean;
  waitMs?: number;
}

export interface ClaudeTurnHandle {
  run: ClaudeRunLike;
  events: AsyncGenerator<ClaudeStreamEvent>;
  /** The answer a schema's tool gave this turn, if it was called. */
  takeAnswer(): string | null;
}

export interface ClaudeToolCallInput {
  token: string;
  toolCallId: string;
  name: string;
  arguments: string;
}

export interface ClaudeToolCallAnswer {
  status: number;
  body: unknown;
}

export interface ClaudeBridgeOptions {
  resolveBinary?: () => Promise<string>;
  spawnImpl?: typeof spawn;
  /** Conversations kept as processes for their next turn; myna keeps 6. */
  idleMost?: number;
  /** How long a run waits for its next turn; the prompt cache's hour. */
  idleMs?: number;
  /** Conversations kept as transcripts; myna keeps 64. */
  shelfMost?: number;
  /** A shelf of the caller's, for its timers and its files. */
  shelf?: ClaudeSessionShelf;
  /** A room of the caller's; by default the machine's memory bounds it. */
  room?: ClaudeRoom;
  /** How long one run may take; myna ends it at 30 minutes. */
  runTimeoutMs?: number;
  /** How long a run waits on its caller's tool results; myna waits 5 minutes. */
  parkMs?: number;
  /** How many parked runs are kept; myna keeps 16. */
  parkedMost?: number;
  /** The memory Claude Code processes share; 0 is unknown. */
  memoryLimitBytes?: number;
  /** How many processes may run, read at each ask (the user's setting). */
  runsMost?: () => number;
  /** Makes a run's process as it is started: a WSL distro's Claude Code, or the host's. */
  prepareLaunch?: (launch: ClaudeLaunch) => Promise<ClaudeLaunch>;
  /** Makes the run: `claude -p`, or the interactive mode standing where it would. */
  createRun?: (
    options: ClaudeRunOptions,
    input: ClaudeTurnInput,
    dirs: readonly string[],
  ) => ClaudeRunLike;
  platform?: NodeJS.Platform;
  rssReader?: ProcessReader;
  now?: () => number;
}

interface TurnState {
  /** The input of the answer tool's call that fit its schema, until the turn ends. */
  answer?: string;
  answerTool?: ClaudeAnswer;
  /** The conversation this run was told, by its key: a branch must match it. */
  told: string;
  owner: string;
  model: string;
  messages: readonly ClaudePromptMessage[];
  tools: readonly ClaudeToolSpec[];
  dirs: readonly string[];
  said: string;
  started: number;
  since: number;
  ir?: readonly IrMessage[];
}

/** Where in its session a run wrote the reply that made a tool call. */
interface CallLine {
  uuid: string;
  seq: number;
  /** The conversation the run had been told then: the branch must be that one. */
  told: string;
  session: string;
  dirs: readonly string[];
}

export interface ClaudeRunInfo {
  pid: number;
  model: string;
  account: string;
  state: "answering" | "idle" | "tools";
  since: number;
  started: number;
}

export interface ClaudeRunsInfo {
  object: "claude-runs";
  runs: ClaudeRunInfo[];
  live: number;
  most: number;
  mostWhy: string;
  idleMost: number;
  idleForMs: number;
}

interface IdleEntry {
  run: ClaudeRunLike;
  key: string;
  at: number;
  timer: NodeJS.Timeout;
  dirs: readonly string[];
  ir?: readonly IrMessage[];
}

interface Conversation {
  key: string;
  since: ClaudePromptMessage[];
}

interface Resume {
  session: string;
  dirs: readonly string[];
  since: readonly ClaudePromptMessage[];
}

/**
 * The Claude subscription bridge: it drives the real `claude` binary so
 * Anthropic's subscription checks see Claude Code's own requests, keeps a
 * process (or its saved session) for each conversation's next turn, and hands
 * the caller's tools over through an MCP helper that blocks until the
 * caller's next request.
 */
export class ClaudeBridge {
  private readonly options: ClaudeBridgeOptions;
  private readonly shelf: ClaudeSessionShelf;
  private readonly room: ClaudeRoom;
  private readonly runs = new Map<string, ClaudeRunLike>();
  private readonly calls = new Map<string, ClaudeRunLike>();
  private readonly idle = new Map<string, IdleEntry>();
  private readonly turns = new Map<string, TurnState>();
  private readonly releases = new Map<string, (left: boolean) => void>();
  private readonly aborted = new Set<string>();
  private readonly runTimers = new Map<string, NodeJS.Timeout>();
  private readonly parked = new Map<string, { at: number; timer: NodeJS.Timeout }>();
  /** The session lines that made each run's tool calls, by the call's id. */
  private readonly callLines = new Map<string, Map<string, CallLine>>();

  public constructor(options: ClaudeBridgeOptions = {}) {
    this.options = options;
    this.shelf =
      options.shelf ??
      new ClaudeSessionShelf({
        most: options.shelfMost,
        ttlMs: options.idleMs,
        now: options.now,
      });
    const platform = options.platform ?? process.platform;
    this.room =
      options.room ??
      new ClaudeRoom({
        most: options.runsMost ?? (() => runsMostFor(platform, options.memoryLimitBytes ?? 0)),
        why: "the machine's memory",
        now: options.now,
      });
    this.room.setPressure(() => this.evictForRoom());
  }

  public async startTurn(input: ClaudeTurnInput): Promise<ClaudeTurnHandle> {
    const turn = await this.turnWithSessionDirs(input);
    const run = await this.resumeWithResults(turn);
    if (run !== null) {
      return this.continueRun(run, turn);
    }
    const branch = await this.branchedResume(turn);
    if (branch !== null) {
      return this.startResumed(turn, branch);
    }
    const conversation = conversationKey(turn);
    if (conversation !== null) {
      const idle = this.takeIdle(conversation.key);
      if (idle !== null) {
        return this.continueIdle(idle, turn, conversation.since);
      }
      const loose = this.takeLooseIdle(turn);
      if (loose !== null) {
        return this.continueIdle(loose, turn, conversation.since);
      }
      const saved = this.shelf.get(conversation.key);
      if (saved !== undefined) {
        this.shelf.delete(conversation.key);
        return this.startResumed(turn, {
          session: saved.session,
          dirs: saved.dirs,
          since: conversation.since,
        });
      }
    }
    const replayed = await this.replay(turn, conversation);
    if (replayed !== null) {
      return this.startResumed(turn, replayed);
    }
    return this.startRun(turn);
  }

  /**
   * The turn's session folders as its launch will have them: a WSL
   * distro's are read and written through its Windows share, so a replay
   * lands where Claude Code will find it.
   */
  private async turnWithSessionDirs(input: ClaudeTurnInput): Promise<ClaudeTurnInput> {
    if (
      this.options.prepareLaunch === undefined ||
      input.sessionDirs === undefined ||
      input.sessionDirs.length === 0
    ) {
      return input;
    }
    const launch = await this.options.prepareLaunch({
      binary: "claude",
      args: [],
      cwd: input.cwd,
      env: { ...input.env },
      sessionDirs: input.sessionDirs,
    });
    const same =
      launch.sessionDirs.length === input.sessionDirs.length &&
      launch.sessionDirs.every((dir, at) => dir === input.sessionDirs?.[at]);
    return same ? input : { ...input, sessionDirs: launch.sessionDirs };
  }

  /**
   * The MCP helper's tools/call, held until the caller's next request hands
   * the result over.
   */
  public async handleToolCall(input: ClaudeToolCallInput): Promise<ClaudeToolCallAnswer> {
    const run = this.runs.get(input.token);
    if (run === undefined) {
      return { status: 404, body: { error: "unknown or expired Claude run" } };
    }
    const state = this.turns.get(run.token);
    const name = state === undefined ? input.name : resolveCalledTool(state.tools, input.name);
    if (state?.answerTool !== undefined && name === state.answerTool.name) {
      return this.acceptAnswer(state, input.arguments);
    }
    const result = await run.waitForToolResult(input.toolCallId);
    if (result === null) {
      return { status: 410, body: { error: `the agent's run ended before ${name} answered` } };
    }
    return {
      status: 200,
      body: {
        content: [{ type: "text", text: result.text }],
        is_error: result.isError === true,
      },
    };
  }

  public abortAll(): void {
    for (const entry of this.idle.values()) {
      clearTimeout(entry.timer);
    }
    this.idle.clear();
    for (const timer of this.runTimers.values()) {
      clearTimeout(timer);
    }
    this.runTimers.clear();
    for (const parked of this.parked.values()) {
      clearTimeout(parked.timer);
    }
    this.parked.clear();
    for (const run of this.runs.values()) {
      run.abort();
    }
    this.runs.clear();
    this.calls.clear();
    this.turns.clear();
    this.releases.clear();
  }

  private async startRun(input: ClaudeTurnInput): Promise<ClaudeTurnHandle> {
    return this.startResumed(input, null);
  }

  private async startResumed(
    input: ClaudeTurnInput,
    resume: Resume | null,
  ): Promise<ClaudeTurnHandle> {
    const binary = await this.resolveBinary();
    const dirs = resume?.dirs ?? input.sessionDirs ?? [];
    const args = claudeCliArgs({
      model: input.model,
      mcpConfig: input.mcpConfig,
      effort: input.effort,
      webSearch: input.webSearch,
      thinkingOff: input.thinkingOff,
      jsonSchema: input.jsonSchema,
      systemPromptFile: input.systemPromptFile,
      resumeSession: resume?.session,
      persistSession: dirs.length > 0,
    });
    const launch = (await this.options.prepareLaunch?.({
      binary: binary === "" ? "claude" : binary,
      args,
      cwd: input.cwd,
      env: { ...input.env },
      sessionDirs: dirs,
    })) ?? {
      binary,
      args,
      cwd: input.cwd,
      env: { ...input.env },
      sessionDirs: dirs,
    };
    if (binary === "" && launch.wsl === undefined) {
      throw new Error(CLAUDE_NOT_INSTALLED);
    }
    const release = await this.room.take();
    const runOptions: ClaudeRunOptions = {
      binary: launch.binary,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      spawnImpl: this.options.spawnImpl,
      token: input.runToken,
      ...(launch.wsl === undefined ? {} : { wsl: launch.wsl }),
    };
    const run =
      this.options.createRun !== undefined && input.tui !== undefined
        ? this.options.createRun(runOptions, input, launch.sessionDirs)
        : new ClaudeRun(runOptions);
    this.runs.set(run.token, run);
    this.releases.set(run.token, release);
    this.track(input, run, launch.sessionDirs);
    try {
      run.start();
    } catch (error) {
      release(false);
      this.releases.delete(run.token);
      this.runs.delete(run.token);
      this.turns.delete(run.token);
      throw error;
    }
    const events = run.events();
    this.listen(run);
    this.armTimeout(run);
    if (resume === null) {
      run.sendUserMessage(renderClaudePrompt(input.request, input.cacheMarks));
    } else {
      run.sendUserMessage(renderClaudeTurn(resume.since, input.request.tools ?? []));
    }
    void run.waitForExit().then(() => this.forget(run));
    return this.handle(run, events);
  }

  private continueRun(run: ClaudeRunLike, input: ClaudeTurnInput): ClaudeTurnHandle {
    const events = run.beginTurn();
    this.unpark(run);
    this.armTimeout(run);
    this.track(input, run, this.turns.get(run.token)?.dirs ?? input.sessionDirs ?? []);
    return this.handle(run, events);
  }

  private armTimeout(run: ClaudeRunLike): void {
    const previous = this.runTimers.get(run.token);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    this.runTimers.set(
      run.token,
      setTimeout(
        () => {
          this.abortRun(run);
        },
        this.options.runTimeoutMs ?? 30 * 60_000,
      ),
    );
  }

  private continueIdle(
    run: ClaudeRunLike,
    input: ClaudeTurnInput,
    since: readonly ClaudePromptMessage[],
  ): ClaudeTurnHandle {
    const events = run.beginTurn();
    this.armTimeout(run);
    const dirs = this.turns.get(run.token)?.dirs ?? input.sessionDirs ?? [];
    this.track(input, run, dirs);
    run.sendUserMessage(renderClaudeTurn(since, input.request.tools ?? []));
    return this.handle(run, events);
  }

  private track(input: ClaudeTurnInput, run: ClaudeRunLike, dirs: readonly string[]): void {
    const previous = this.turns.get(run.token);
    const now = (this.options.now ?? Date.now)();
    this.turns.set(run.token, {
      owner: input.owner,
      model: input.model,
      messages: input.request.messages,
      tools: input.request.tools ?? [],
      dirs,
      said: "",
      started: previous?.started ?? now,
      since: now,
      told: digestKey(turnKey(input.owner, input.model, input.request.messages)),
      ...(input.irMessages === undefined ? {} : { ir: input.irMessages }),
      ...(input.answer === undefined ? {} : { answerTool: input.answer }),
    });
  }

  /** A turn's handle, whose answer the caller takes once its events end. */
  private handle(run: ClaudeRunLike, events: AsyncGenerator<ClaudeStreamEvent>): ClaudeTurnHandle {
    return {
      run,
      events,
      takeAnswer: () => {
        const state = this.turns.get(run.token);
        if (state?.answer === undefined) {
          return null;
        }
        const answer = state.answer;
        state.answer = undefined;
        return answer;
      },
    };
  }

  /** The answer tool's call: the answer when it fits, why not for the model to call again. */
  private acceptAnswer(state: TurnState, argumentsJson: string): ClaudeToolCallAnswer {
    const tool = state.answerTool;
    if (tool === undefined) {
      return { status: 404, body: { error: "no answer tool for this run" } };
    }
    const why = tool.validate(argumentsJson);
    if (why === null) {
      state.answer = argumentsJson;
      return {
        status: 200,
        body: { content: [{ type: "text", text: "Answer received." }], is_error: false },
      };
    }
    return {
      status: 200,
      body: {
        content: [
          {
            type: "text",
            text: `The input doesn't fit the schema: ${why}\nCall the tool again with input that fits.`,
          },
        ],
        is_error: true,
      },
    };
  }

  /** What the bridge has running, for `/v1/myna/claude-runs`. */
  public describeRuns(): ClaudeRunsInfo {
    const idle = new Set([...this.idle.values()].map((entry) => entry.run));
    const runs: ClaudeRunInfo[] = [];
    for (const [token, run] of this.runs) {
      const state = this.turns.get(token);
      if (state === undefined) {
        continue;
      }
      runs.push({
        pid: run.pid,
        model: state.model,
        account: state.owner,
        state: runState(run, idle, this.parked),
        since: state.since,
        started: state.started,
      });
    }
    runs.sort((left, right) => left.started - right.started);
    return {
      object: "claude-runs",
      runs,
      live: this.room.live,
      most: this.room.most,
      mostWhy: this.room.why,
      idleMost: this.options.idleMost ?? 6,
      idleForMs: this.options.idleMs ?? 60 * 60_000,
    };
  }

  private forget(run: ClaudeRunLike): void {
    this.runs.delete(run.token);
    this.turns.delete(run.token);
    this.callLines.delete(run.token);
    const release = this.releases.get(run.token);
    this.releases.delete(run.token);
    release?.(this.aborted.delete(run.token));
    const timeout = this.runTimers.get(run.token);
    if (timeout !== undefined) {
      clearTimeout(timeout);
      this.runTimers.delete(run.token);
    }
    this.unpark(run);
    for (const [callId, owner] of this.calls) {
      if (owner === run) {
        this.calls.delete(callId);
      }
    }
    for (const [key, entry] of this.idle) {
      if (entry.run === run) {
        clearTimeout(entry.timer);
        this.idle.delete(key);
      }
    }
  }

  private abortRun(run: ClaudeRunLike): void {
    if (!run.running) {
      return;
    }
    this.aborted.add(run.token);
    this.room.leave();
    run.abort();
  }

  private unpark(run: ClaudeRunLike): void {
    const parked = this.parked.get(run.token);
    if (parked === undefined) {
      return;
    }
    clearTimeout(parked.timer);
    this.parked.delete(run.token);
  }

  private park(run: ClaudeRunLike): void {
    this.unpark(run);
    this.noteCallLines(run);
    const at = (this.options.now ?? Date.now)();
    const timer = setTimeout(
      () => {
        this.parked.delete(run.token);
        this.abortRun(run);
      },
      this.options.parkMs ?? 5 * 60_000,
    );
    this.parked.set(run.token, { at, timer });
    while (this.parked.size > (this.options.parkedMost ?? 16)) {
      const oldest = [...this.parked.entries()].sort((left, right) => left[1].at - right[1].at)[0];
      if (oldest === undefined) {
        break;
      }
      clearTimeout(oldest[1].timer);
      this.parked.delete(oldest[0]);
      const parkedRun = this.runs.get(oldest[0]);
      if (parkedRun !== undefined) {
        this.abortRun(parkedRun);
      }
    }
    void this.oversized(run, 3);
  }

  /** Keeps the session line each of this turn's tool calls was made in, for a branch. */
  private noteCallLines(run: ClaudeRunLike): void {
    const state = this.turns.get(run.token);
    if (state === undefined || run.sessionId === "" || state.dirs.length === 0) {
      return;
    }
    const lines = this.callLines.get(run.token) ?? new Map<string, CallLine>();
    let seq = 0;
    for (const line of lines.values()) {
      seq = Math.max(seq, line.seq);
    }
    for (const id of run.callsMade) {
      const uuid = run.callUuid?.(id);
      if (uuid === undefined || uuid === "") {
        continue;
      }
      seq += 1;
      lines.set(id, {
        uuid,
        seq,
        told: state.told,
        session: run.sessionId,
        dirs: state.dirs,
      });
    }
    if (lines.size > 0) {
      this.callLines.set(run.token, lines);
    }
  }

  private evictForRoom(): boolean {
    const idle = [...this.idle.entries()].sort((left, right) => left[1].at - right[1].at)[0];
    if (idle !== undefined) {
      this.letGo(idle[0], idle[1]);
      return true;
    }
    const now = (this.options.now ?? Date.now)();
    const parked = [...this.parked.entries()]
      .filter(([, entry]) => now - entry.at >= (this.options.parkMs ?? 5 * 60_000))
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (parked === undefined) {
      return false;
    }
    const run = this.runs.get(parked[0]);
    if (run === undefined) {
      return false;
    }
    this.unpark(run);
    this.abortRun(run);
    return true;
  }

  private async isOverBudget(run: ClaudeRunLike, share: number): Promise<boolean> {
    const budget = claudeRunBudget(this.options.memoryLimitBytes ?? 0);
    return oversizedRun(run.pid, budget, share, this.options.rssReader);
  }

  private async oversized(run: ClaudeRunLike, share: number): Promise<void> {
    if (!(await this.isOverBudget(run, share))) {
      return;
    }
    const state = this.turns.get(run.token);
    if (state !== undefined && run.sessionId !== "" && state.dirs.length > 0) {
      const reply: ClaudePromptMessage = {
        role: "assistant",
        parts: [{ kind: "text", text: state.said }],
      };
      const key = digestKey(turnKey(state.owner, state.model, [...state.messages, reply]));
      this.shelf.put(run.sessionId, state.dirs, key);
    }
    this.abortRun(run);
  }

  private async resumeWithResults(input: ClaudeTurnInput): Promise<ClaudeRunLike | null> {
    const results = toolResultsAfterLastReply(input.request.messages);
    if (results.length === 0) {
      return null;
    }
    let found: ClaudeRunLike | null = null;
    for (const result of results) {
      const run = this.calls.get(result.callId);
      if (run === undefined) {
        continue;
      }
      found = run;
      if (run.deliverToolResult(result.callId, result)) {
        this.calls.delete(result.callId);
      }
    }
    return found;
  }

  /**
   * The conversation as it goes on from a run whose session still has it,
   * when no run took this request's tool results: another request answered
   * the calls first, and the run went on with that one. The session is cut
   * after the reply that made the calls, so the request's own run reads the
   * prefix Anthropic cached and is told only the results and what came
   * after. Null when no run made them, its conversation isn't this one, or
   * the cut can't be made: then a new Claude Code is told the whole
   * conversation, as myna falls back.
   */
  private async branchedResume(input: ClaudeTurnInput): Promise<Resume | null> {
    if (input.cacheMarks !== undefined) {
      return null;
    }
    const branch = branchRequest(input);
    if (branch === null) {
      return null;
    }
    const from = this.branchLine(branch.calls, branch.told);
    if (from === null || from.dirs.length === 0) {
      return null;
    }
    try {
      const session = await cutSession(from.dirs, from.session, from.uuid);
      return { session, dirs: from.dirs, since: branch.since };
    } catch {
      // a branch that can't be cut is a new Claude Code told the whole
      // conversation, as myna falls back to
      return null;
    }
  }

  /** The newest call among those a branch answers, made in the conversation it goes on from. */
  private branchLine(calls: readonly string[], told: string): CallLine | null {
    let from: CallLine | null = null;
    for (const [token, lines] of this.callLines) {
      const run = this.runs.get(token);
      if (run === undefined || !run.running || run.sessionId === "") {
        continue;
      }
      for (const id of calls) {
        const line = lines.get(id);
        if (line === undefined || line.told !== told || (from !== null && line.seq <= from.seq)) {
          continue;
        }
        from = line;
      }
    }
    return from;
  }

  private takeIdle(key: string): ClaudeRunLike | null {
    const entry = this.idle.get(key);
    if (entry === undefined) {
      return null;
    }
    clearTimeout(entry.timer);
    this.idle.delete(key);
    return entry.run;
  }

  /**
   * A run whose conversation the client sent back with earlier images taken
   * out: the run already saw them, and told the conversation anew it would
   * write all of it to the prompt cache again.
   */
  private takeLooseIdle(input: ClaudeTurnInput): ClaudeRunLike | null {
    if (input.irMessages === undefined) {
      return null;
    }
    for (const [key, entry] of this.idle) {
      if (entry.ir !== undefined && lostMedia(entry.ir, input.irMessages)) {
        clearTimeout(entry.timer);
        this.idle.delete(key);
        return entry.run;
      }
    }
    return null;
  }

  private async replay(
    input: ClaudeTurnInput,
    conversation: Conversation | null,
  ): Promise<Resume | null> {
    if (
      conversation === null ||
      input.sessionDirs === undefined ||
      input.sessionDirs.length === 0
    ) {
      return null;
    }
    const replayed = await writeReplaySession({
      dirs: input.sessionDirs,
      work: input.cwd,
      model: input.model,
      messages: input.request.messages,
    });
    return replayed === null
      ? null
      : { session: replayed.session, dirs: replayed.dirs, since: replayed.since };
  }

  private listen(run: ClaudeRunLike): void {
    run.setEventListener((event) => {
      if (event.kind === "toolCall") {
        this.calls.set(event.id, run);
        return;
      }
      const state = this.turns.get(run.token);
      if (state === undefined) {
        return;
      }
      if (event.kind === "text") {
        state.said += event.text;
        return;
      }
      if (event.kind !== "stop") {
        return;
      }
      if (event.stop === "tool_use") {
        this.park(run);
        return;
      }
      if (event.stop === "end_turn" || event.stop === "stop") {
        void this.keep(run, state);
      }
    });
  }

  private keep(run: ClaudeRunLike, state: TurnState): void {
    if (!run.running) {
      return;
    }
    const reply: ClaudePromptMessage = {
      role: "assistant",
      parts: [{ kind: "text", text: state.said }],
    };
    const key = digestKey(turnKey(state.owner, state.model, [...state.messages, reply]));
    const entry: IdleEntry = {
      run,
      key,
      at: (this.options.now ?? Date.now)(),
      dirs: state.dirs,
      ...(state.ir === undefined ? {} : { ir: state.ir }),
      timer: setTimeout(
        () => {
          this.letGo(key);
        },
        this.options.idleMs ?? 60 * 60_000,
      ),
    };
    this.idle.delete(key);
    this.idle.set(key, entry);
    this.room.nudge();
    while (this.idle.size > (this.options.idleMost ?? 6)) {
      const oldest = [...this.idle.values()].sort((left, right) => left.at - right.at)[0];
      if (oldest === undefined) {
        break;
      }
      this.letGo(oldest.key, oldest);
    }
    void this.checkKept(run, key);
  }

  /**
   * A run kept for its conversation's next turn is let go when it holds more
   * than a kept run may: a process that grew over days was what took the
   * machine's memory. The next turn resumes its session in a new one.
   */
  private async checkKept(run: ClaudeRunLike, key: string): Promise<void> {
    if (!(await this.isOverBudget(run, 2))) {
      return;
    }
    const entry = this.idle.get(key);
    if (entry?.run === run) {
      this.letGo(key, entry);
    }
  }

  /** Lets a kept run go: its session is shelved for the conversation's next turn. */
  private letGo(key: string, entry = this.idle.get(key)): void {
    if (entry === undefined) {
      return;
    }
    clearTimeout(entry.timer);
    this.idle.delete(key);
    const session = entry.run.sessionId;
    if (session !== "" && entry.dirs.length > 0) {
      this.shelf.put(session, entry.dirs, key);
    }
    this.abortRun(entry.run);
  }

  private async resolveBinary(): Promise<string> {
    if (this.options.resolveBinary !== undefined) {
      return this.options.resolveBinary();
    }
    return findClaudeBinary({ env: process.env });
  }
}

function runState(
  run: ClaudeRunLike,
  idle: ReadonlySet<ClaudeRunLike>,
  parked: ReadonlyMap<string, unknown>,
): ClaudeRunInfo["state"] {
  if (idle.has(run)) {
    return "idle";
  }
  return parked.has(run.token) ? "tools" : "answering";
}

/** Where the turn to answer now begins: after the last reply that calls no tool. */
function currentTurnStart(messages: readonly ClaudePromptMessage[]): number {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message !== undefined && message.role === "assistant" && !callsTool(message)) {
      return at + 1;
    }
  }
  return 0;
}

/** The conversation key a kept run waits at, and the messages the next turn starts with. */
/** What a request's trailing tool calls answer: the calls, and the messages that follow them. */
function branchRequest(input: ClaudeTurnInput): {
  calls: string[];
  told: string;
  since: readonly ClaudePromptMessage[];
} | null {
  const messages = input.request.messages;
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role !== "assistant") {
    end -= 1;
  }
  if (end === 0 || end === messages.length) {
    return null;
  }
  let start = end;
  while (start > 0 && messages[start - 1]?.role === "assistant") {
    start -= 1;
  }
  const calls: string[] = [];
  for (const message of messages.slice(start, end)) {
    for (const part of message.parts) {
      if (part.kind === "toolCall") {
        calls.push(part.id);
      }
    }
  }
  if (calls.length === 0) {
    return null;
  }
  return {
    calls,
    told: digestKey(turnKey(input.owner, input.model, messages.slice(0, start))),
    since: messages.slice(end),
  };
}

function conversationKey(input: ClaudeTurnInput): Conversation | null {
  const messages = input.request.messages;
  if (messages.length === 0 || messages[messages.length - 1]?.role === "assistant") {
    return null;
  }
  const split = currentTurnStart(messages);
  if (split === 0) {
    return null;
  }
  return {
    key: digestKey(turnKey(input.owner, input.model, messages.slice(0, split))),
    since: messages.slice(split),
  };
}

function digestKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toolResultsAfterLastReply(
  messages: readonly ClaudePromptMessage[],
): Array<{ callId: string; text: string; isError?: boolean }> {
  let at = messages.length - 1;
  while (at >= 0 && messages[at]?.role !== "assistant") {
    at -= 1;
  }
  const results: Array<{ callId: string; text: string; isError?: boolean }> = [];
  for (const message of messages.slice(at + 1)) {
    for (const part of message.parts) {
      if (part.kind === "toolResult") {
        results.push({ callId: part.callId, text: part.text, isError: part.isError });
      }
    }
  }
  return results;
}
