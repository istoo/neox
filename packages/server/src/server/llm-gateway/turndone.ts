/**
 * A turn's end, for the notification that an agent is done (myna's
 * turndone.go). The gateway sees requests, not turns: a turn is the requests
 * one agent's session sends from the user's prompt to its last reply. A reply
 * that called no tool, followed by nothing more for a quiet period, ends it.
 *
 * Only turns that ran at least `turnDoneSeconds` are reported. A request Neolix
 * itself makes, a subagent's, and a request that named no session are not the
 * turn's (see the middleware in `turn-middleware.ts`).
 */

export interface TurnInfo {
  agent: string;
  session: string;
}

export interface TurnEnd extends TurnInfo {
  tookMs: number;
  at: string;
}

interface TurnState {
  start: number;
  last: number;
  going: number;
  info: TurnInfo;
  timer: ReturnType<typeof setTimeout> | null;
}

export function turnKey(agent: string, session: string): string {
  return `${agent}\u0000${session}`;
}

/** How long after a reply that called no tool nothing more may come. */
export const TURN_QUIET_MS = 4_000;
/** A session with nothing for this long starts its next turn over. */
export const TURN_STALE_MS = 30 * 60_000;

export interface TurnTrackerOptions {
  /** How long a turn must run to be reported, read as it ends; 0 turns it off. */
  thresholdSeconds: () => number;
  quietMs?: number;
  staleMs?: number;
  now?: () => number;
}

/**
 * Follows each conversation's turns and calls every listener once per turn
 * that ran long enough. Timers are unref'd so a pending turn never holds the
 * process open.
 */
export class TurnTracker {
  private readonly states = new Map<string, TurnState>();
  private readonly listeners = new Set<(end: TurnEnd) => void>();
  private readonly quietMs: number;
  private readonly staleMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TurnTrackerOptions) {
    this.quietMs = options.quietMs ?? TURN_QUIET_MS;
    this.staleMs = options.staleMs ?? TURN_STALE_MS;
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: (end: TurnEnd) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * A request of a turn starting; not tracked when the setting is off. `at`
   * is when the request arrived, which may be before its body was read.
   */
  begin(key: string, info: TurnInfo, at?: number): void {
    if (this.options.thresholdSeconds() <= 0) {
      return;
    }
    const now = this.now();
    for (const [staleKey, state] of this.states) {
      if (state.going === 0 && now - state.last > this.staleMs) {
        this.clear(staleKey);
      }
    }
    const state = this.states.get(key);
    if (state === undefined) {
      this.states.set(key, { start: at ?? now, last: now, going: 1, info, timer: null });
      return;
    }
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.going += 1;
    state.last = now;
  }

  /**
   * A request of a turn ending; `final` when its reply went whole to the agent
   * and called no tool. The turn is done once nothing more comes for the quiet
   * period, and reported only if it ran at least the threshold.
   */
  end(key: string, final: boolean): void {
    const state = this.states.get(key);
    if (state === undefined) {
      return;
    }
    state.going = Math.max(state.going - 1, 0);
    state.last = this.now();
    if (state.going > 0 || !final) {
      return;
    }
    const thresholdMs = this.options.thresholdSeconds() * 1_000;
    state.timer = setTimeout(() => {
      const current = this.states.get(key);
      if (current !== state) {
        return;
      }
      this.states.delete(key);
      const tookMs = state.last - state.start;
      if (thresholdMs > 0 && tookMs >= thresholdMs) {
        const end: TurnEnd = { ...state.info, tookMs, at: new Date(this.now()).toISOString() };
        for (const listener of this.listeners) {
          try {
            listener(end);
          } catch {
            // A listener that throws does not take the gateway down.
          }
        }
      }
    }, this.quietMs);
    unrefTimer(state.timer);
  }

  /** Forgets every turn; the daemon calls it on shutdown. */
  stop(): void {
    for (const key of this.states.keys()) {
      this.clear(key);
    }
    this.listeners.clear();
  }

  private clear(key: string): void {
    const state = this.states.get(key);
    if (state?.timer !== null && state?.timer !== undefined) {
      clearTimeout(state.timer);
    }
    this.states.delete(key);
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void };
  handle.unref?.();
}

const TOOL_VALUE_MARKS = [
  '"tool_use"',
  '"tool_calls"',
  '"function_call"',
  '"custom_tool_call"',
  '"local_shell_call"',
  '"shell_call"',
  '"apply_patch_call"',
  '"computer_call"',
  '"mcp_approval_request"',
];

const CUT_PATTERNS = [
  /"stop_reason"\s*:\s*"max_tokens"/,
  /"stop_reason"\s*:\s*"model_context_window_exceeded"/,
  /"finish_reason"\s*:\s*"length"/,
  /"finishReason"\s*:\s*"MAX_TOKENS"/,
  /"type"\s*:\s*"response\.(?:failed|incomplete|cancelled)"/,
  /"type"\s*:\s*"error"/,
];

/**
 * Reads a reply as it goes to the agent, in any of the wire formats, for the
 * two facts a turn needs: whether it asked the agent to run a tool, and whether
 * it ended unfinished. Keeps the tail of the stream so a mark split across
 * chunks still matches.
 */
export class ReplyScan {
  private tail = "";
  sawTool = false;
  cut = false;

  add(chunk: unknown): void {
    if (this.sawTool && this.cut) {
      return;
    }
    const text = chunkText(chunk);
    if (text.length === 0) {
      return;
    }
    const buffer = this.tail + text;
    this.sawTool = this.sawTool || toolIn(buffer);
    this.cut = this.cut || CUT_PATTERNS.some((pattern) => pattern.test(buffer));
    this.tail = buffer.slice(-512);
  }

  /** Whether the reply ends its turn: it went whole and called no tool. */
  get final(): boolean {
    return !this.sawTool && !this.cut;
  }
}

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }
  return "";
}

function toolIn(buffer: string): boolean {
  for (const mark of TOOL_VALUE_MARKS) {
    if (new RegExp(`:\\s*${escapeRegExp(mark)}`).test(buffer)) {
      return true;
    }
  }
  // Gemini's function call is a key (`"functionCall": {`), not a value.
  return /"functionCall"\s*:/.test(buffer);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
