// Per-thread timeline cache and catch-up. Neox projects a thread's rows; the bridge used to
// re-read the whole thread after every burst of updates. This keeps the projected rows it
// already has and asks the daemon only for the rows of the current turn that moved, falling
// back to a whole read whenever the projection says the cache can no longer be trusted.
import type {
  FetchAgentTimelineOptions,
  FetchAgentTimelinePayload,
} from "../../../../client/dist/daemon-client.js";
import type { NeolixTimelineEntry } from "./translate.ts";

/** Coalesces bursts of streamed deltas into one catch-up per thread. */
const DEFAULT_THREAD_REFRESH_MS = 120;

export interface ThreadTimelineSource {
  fetchAgentTimeline(
    agentId: string,
    options?: FetchAgentTimelineOptions,
  ): Promise<FetchAgentTimelinePayload>;
}

export interface ThreadEntriesUpdate {
  readonly threadId: string;
  /** The thread's projected rows, oldest first. */
  readonly entries: readonly NeolixTimelineEntry[];
  /** True when the rows came from a whole-thread read rather than a catch-up. */
  readonly full: boolean;
}

export type ThreadEntriesListener = (update: ThreadEntriesUpdate) => void;

export interface ThreadStreamOptions {
  readonly log: (line: string) => void;
  /** Coalescing window; tests shrink it and fake timers advance it. */
  readonly refreshMs?: number;
  /** Escape hatch: re-read the whole thread on every refresh (the old behavior). */
  readonly fullRefresh?: boolean;
}

interface ThreadCache {
  epoch: string;
  rows: NeolixTimelineEntry[];
}

interface WatchedThread {
  readonly listeners: Set<ThreadEntriesListener>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function lastUserMessageIndex(rows: readonly NeolixTimelineEntry[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.item.type === "user_message") return index;
  }
  return -1;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Holds one projected-row cache per watched thread, coalesces update bursts, and merges each
 * catch-up into the cache. A catch-up starts at the row before the current turn's first row,
 * so the whole turn is re-projected: a tool lifecycle update rewrites the row the turn opened
 * with, and the projected entry may span rows both before and after the cursor.
 */
export class ThreadStream {
  private readonly cache = new Map<string, ThreadCache>();
  private readonly watched = new Map<string, WatchedThread>();
  private readonly refreshing = new Set<string>();
  private readonly pending = new Map<string, "incremental" | "full">();
  private readonly refreshMs: number;
  private readonly fullRefresh: boolean;

  constructor(
    private readonly client: ThreadTimelineSource,
    private readonly options: ThreadStreamOptions,
  ) {
    this.refreshMs = options.refreshMs ?? DEFAULT_THREAD_REFRESH_MS;
    this.fullRefresh = options.fullRefresh ?? process.env.NEOX_WEB_FULL_THREAD_REFRESH === "1";
  }

  /** Cached projected rows, when a read has produced any. */
  rows(threadId: string): readonly NeolixTimelineEntry[] | null {
    return this.cache.get(threadId)?.rows ?? null;
  }

  /**
   * Registers a listener and starts watching. The first listener triggers a refresh; later
   * listeners receive the current cache immediately and then the shared updates.
   */
  watch(threadId: string, listener: ThreadEntriesListener): () => void {
    let state = this.watched.get(threadId);
    if (!state) {
      state = { listeners: new Set(), timer: undefined };
      this.watched.set(threadId, state);
      state.listeners.add(listener);
      void this.run(threadId, false);
    } else {
      state.listeners.add(listener);
      // A failed first read leaves no cache; give the newcomer's arrival another chance.
      if (!this.cache.has(threadId)) void this.run(threadId, false);
    }
    return () => {
      const current = this.watched.get(threadId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      if (current.timer) clearTimeout(current.timer);
      this.watched.delete(threadId);
      this.cache.delete(threadId);
      this.pending.delete(threadId);
    };
  }

  /** A stream update landed; catch up once the burst settles. */
  invalidate(threadId: string): void {
    if (!this.watched.has(threadId)) return;
    const state = this.watched.get(threadId);
    if (!state || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.run(threadId, true);
    }, this.refreshMs);
  }

  /**
   * The agent stopped running: the whole thread may have settled rows the projection merged
   * differently, so reconcile instead of catching up.
   */
  reconcile(threadId: string): void {
    const state = this.watched.get(threadId);
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    void this.run(threadId, false);
  }

  /** Reads the whole thread now, seeding the cache for later catch-ups. */
  async readFull(threadId: string): Promise<readonly NeolixTimelineEntry[]> {
    return this.fetchWholeThread(threadId);
  }

  /** Drops the cached rows; a later watch starts from a whole read. */
  forget(threadId: string): void {
    this.cache.delete(threadId);
  }

  dispose(): void {
    for (const state of this.watched.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.watched.clear();
    this.cache.clear();
    this.refreshing.clear();
    this.pending.clear();
  }

  private async run(threadId: string, allowIncremental: boolean): Promise<void> {
    if (this.refreshing.has(threadId)) {
      this.pending.set(threadId, allowIncremental ? "incremental" : "full");
      return;
    }
    this.refreshing.add(threadId);
    try {
      const update = await this.load(threadId, allowIncremental);
      const listeners = this.watched.get(threadId)?.listeners;
      if (!update || !listeners) return;
      for (const listener of listeners) listener(update);
    } catch (error) {
      this.options.log(`thread ${threadId} refresh failed: ${describeError(error)}`);
    } finally {
      this.refreshing.delete(threadId);
      const next = this.pending.get(threadId);
      if (next !== undefined) {
        this.pending.delete(threadId);
        void this.run(threadId, next === "incremental");
      }
    }
  }

  private async load(
    threadId: string,
    allowIncremental: boolean,
  ): Promise<ThreadEntriesUpdate | null> {
    if (this.fullRefresh || !allowIncremental) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const cache = this.cache.get(threadId);
    if (!cache) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const anchorIndex = lastUserMessageIndex(cache.rows);
    if (anchorIndex < 0) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const anchor = cache.rows[anchorIndex];
    if (!anchor) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const payload = await this.client.fetchAgentTimeline(threadId, {
      direction: "after",
      cursor: { epoch: cache.epoch, seq: Math.max(0, anchor.seqStart - 1) },
      limit: 0,
      projection: "projected",
    });
    if (payload.error) throw new Error(payload.error);
    if (payload.reset || payload.staleCursor || payload.gap || payload.epoch !== cache.epoch) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const first = payload.entries[0];
    // A projected entry may span rows on both sides of the cursor, never start before the
    // turn: anything earlier means the projection was rebuilt and the cache is stale.
    if (first && first.seqStart < anchor.seqStart) {
      const entries = await this.fetchWholeThread(threadId);
      return { threadId, entries, full: true };
    }
    const rows = [...cache.rows.slice(0, anchorIndex), ...payload.entries];
    this.cache.set(threadId, { epoch: payload.epoch, rows });
    return { threadId, entries: rows, full: false };
  }

  private async fetchWholeThread(threadId: string): Promise<readonly NeolixTimelineEntry[]> {
    const payload = await this.client.fetchAgentTimeline(threadId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    if (payload.error) throw new Error(payload.error);
    const rows = [...payload.entries];
    this.cache.set(threadId, { epoch: payload.epoch, rows });
    return rows;
  }
}

export { diffThreadEvents } from "@synara/shared/threadStreamEvents";
