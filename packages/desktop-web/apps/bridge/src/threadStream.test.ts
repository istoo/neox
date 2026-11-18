import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  FetchAgentTimelineOptions,
  FetchAgentTimelinePayload,
} from "../../../../client/dist/daemon-client.js";
import { ThreadStream, diffThreadEvents, type ThreadEntriesUpdate } from "./threadStream.ts";
import { toThreadTimeline, type NeolixAgent, type NeolixTimelineEntry } from "./translate.ts";

const AGENT_ID = "agent-1";
const THREAD_ID = "agent-1";
const agent = { id: AGENT_ID, status: "running" } as unknown as NeolixAgent;

function entry(
  item: Record<string, unknown> & { type: string },
  seq: number,
  seqEnd = seq,
): NeolixTimelineEntry {
  return {
    provider: "claude",
    item,
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    seqStart: seq,
    seqEnd,
    sourceSeqRanges: [{ startSeq: seq, endSeq: seqEnd }],
    collapsed: [],
  } as unknown as NeolixTimelineEntry;
}

function payload(
  entries: readonly NeolixTimelineEntry[],
  overrides: Partial<FetchAgentTimelinePayload> = {},
): FetchAgentTimelinePayload {
  return {
    requestId: "r",
    agentId: AGENT_ID,
    agent: null,
    direction: "after",
    projection: "projected",
    epoch: "epoch-1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: 100, nextSeq: 101 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    entries: [...entries],
    error: null,
    ...overrides,
  } as FetchAgentTimelinePayload;
}

class FakeTimeline {
  readonly calls: FetchAgentTimelineOptions[] = [];
  tail: NeolixTimelineEntry[] = [];
  after: NeolixTimelineEntry[] = [];
  afterOverrides: Partial<FetchAgentTimelinePayload> = {};
  tailError: string | null = null;

  async fetchAgentTimeline(
    _agentId: string,
    options: FetchAgentTimelineOptions = {},
  ): Promise<FetchAgentTimelinePayload> {
    this.calls.push(options);
    if (options.direction === "after") {
      return payload(this.after, { direction: "after", ...this.afterOverrides });
    }
    return payload(this.tail, {
      direction: "tail",
      ...(this.tailError === null ? {} : { error: this.tailError }),
    });
  }

  afterCalls(): FetchAgentTimelineOptions[] {
    return this.calls.filter((call) => call.direction === "after");
  }

  tailCalls(): FetchAgentTimelineOptions[] {
    return this.calls.filter((call) => call.direction === "tail");
  }
}

/** Earlier turns, as a 50-row thread's full read returns them. */
function history(): NeolixTimelineEntry[] {
  const rows: NeolixTimelineEntry[] = [];
  for (let turn = 0; turn < 5; turn += 1) {
    const base = turn * 10 + 1;
    rows.push(entry({ type: "user_message", text: `prompt ${turn}`, messageId: `u${turn}` }, base));
    for (let row = 1; row < 10; row += 1) {
      rows.push(
        entry(
          { type: "assistant_message", text: `reply ${turn}`, messageId: `a${turn}` },
          base + row,
        ),
      );
    }
  }
  return rows;
}

const currentTurn = [
  entry({ type: "user_message", text: "fix it", messageId: "u-current" }, 51),
  entry({ type: "assistant_message", text: "working", messageId: "a-current" }, 52),
  entry({ type: "tool_call", name: "shell", callId: "call-1", status: "running", detail: {} }, 53),
];

const settledTurn = [
  currentTurn[0]!,
  currentTurn[1]!,
  entry(
    { type: "tool_call", name: "shell", callId: "call-1", status: "completed", detail: {} },
    53,
    54,
  ),
];

describe("thread stream", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches up only the current turn and folds to the same thread", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tail = [...history(), ...currentTurn];
    client.after = [...currentTurn];
    const stream = new ThreadStream(client, { log: () => undefined, refreshMs: 120 });
    const updates: ThreadEntriesUpdate[] = [];
    stream.watch(THREAD_ID, (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.tailCalls()).toHaveLength(1);

    // A burst inside one coalescing window: one catch-up, not five reads.
    for (let index = 0; index < 5; index += 1) stream.invalidate(THREAD_ID);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.afterCalls()).toHaveLength(1);
    expect(client.afterCalls()[0]).toMatchObject({
      direction: "after",
      limit: 0,
      projection: "projected",
      cursor: { epoch: "epoch-1", seq: 50 },
    });

    // The current turn's tool finished; the projection rewrites the row it opened at (53).
    client.after = [...settledTurn];
    stream.invalidate(THREAD_ID);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.afterCalls()).toHaveLength(2);
    const incremental = updates.at(-1)!;
    expect(incremental.full).toBe(false);
    expect(incremental.entries).toHaveLength(history().length + settledTurn.length);

    client.tail = [...history(), ...settledTurn];
    const full = await stream.readFull(THREAD_ID);
    expect(incremental.entries).toEqual(full);
    expect(toThreadTimeline(agent, incremental.entries)).toEqual(toThreadTimeline(agent, full));
    // The catch-up carried the three current-turn rows, not the whole thread.
    expect(client.after).toHaveLength(3);
    expect(full.length).toBeGreaterThan(3);
  });

  it("reconciles the whole thread when the projection resets the cursor", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tail = [...history(), ...currentTurn];
    client.after = [...settledTurn];
    client.afterOverrides = { reset: true, staleCursor: true, gap: true };
    const stream = new ThreadStream(client, { log: () => undefined, refreshMs: 120 });
    const updates: ThreadEntriesUpdate[] = [];
    stream.watch(THREAD_ID, (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(0);

    client.tail = [...history(), ...settledTurn];
    stream.invalidate(THREAD_ID);
    await vi.advanceTimersByTimeAsync(120);

    expect(client.afterCalls()).toHaveLength(1);
    expect(client.tailCalls()).toHaveLength(2);
    expect(updates.at(-1)?.full).toBe(true);
    expect(updates.at(-1)?.entries).toEqual(client.tail);
  });

  it("re-reads the whole thread when the epoch changed", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tail = [...history(), ...currentTurn];
    client.afterOverrides = { epoch: "epoch-2" };
    const stream = new ThreadStream(client, { log: () => undefined, refreshMs: 120 });
    const updates: ThreadEntriesUpdate[] = [];
    stream.watch(THREAD_ID, (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(0);

    stream.invalidate(THREAD_ID);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.tailCalls()).toHaveLength(2);
    expect(updates.at(-1)?.full).toBe(true);
  });

  it("reconciles immediately when the agent stops running", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tail = [...history(), ...currentTurn];
    const stream = new ThreadStream(client, { log: () => undefined, refreshMs: 120 });
    stream.watch(THREAD_ID, () => undefined);
    await vi.advanceTimersByTimeAsync(0);

    stream.invalidate(THREAD_ID);
    stream.reconcile(THREAD_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.afterCalls()).toHaveLength(0);
    expect(client.tailCalls()).toHaveLength(2);
  });

  it("keeps the old whole-thread read behind the switch", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tail = [...history(), ...currentTurn];
    const stream = new ThreadStream(client, {
      log: () => undefined,
      refreshMs: 120,
      fullRefresh: true,
    });
    const updates: ThreadEntriesUpdate[] = [];
    stream.watch(THREAD_ID, (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(0);
    stream.invalidate(THREAD_ID);
    await vi.advanceTimersByTimeAsync(120);
    expect(client.afterCalls()).toHaveLength(0);
    expect(client.tailCalls()).toHaveLength(2);
    expect(updates.at(-1)?.full).toBe(true);
  });

  it("drops a failed read instead of publishing a broken snapshot", async () => {
    vi.useFakeTimers();
    const client = new FakeTimeline();
    client.tailError = "timeline unavailable";
    const logs: string[] = [];
    const stream = new ThreadStream(client, { log: (line) => logs.push(line), refreshMs: 120 });
    const updates: ThreadEntriesUpdate[] = [];
    stream.watch(THREAD_ID, (update) => updates.push(update));
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveLength(0);
    expect(logs[0]).toContain("timeline unavailable");
  });
});

function threadFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    projectId: "p1",
    title: "Thread",
    messages: [],
    activities: [],
    proposedPlans: [],
    session: { threadId: "agent-1", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as import("@synara/contracts").OrchestrationThread;
}

function messageFixture(id: string, text: string, createdAt: string, updatedAt = createdAt) {
  return {
    id,
    role: "assistant",
    text,
    turnId: null,
    streaming: false,
    source: "native",
    createdAt,
    updatedAt,
  };
}

describe("thread event diff", () => {
  it("describes appends and a session change as events", () => {
    const previous = threadFixture({
      messages: [messageFixture("m1", "a", "2026-01-01T00:00:00.000Z")],
    });
    const next = threadFixture({
      updatedAt: "2026-01-01T00:01:00.000Z",
      session: {
        threadId: "agent-1",
        status: "running",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
      messages: [
        messageFixture("m1", "a", "2026-01-01T00:00:00.000Z"),
        messageFixture("m2", "b", "2026-01-01T00:01:00.000Z"),
      ],
      activities: [
        {
          id: "a1",
          tone: "tool",
          kind: "tool.started",
          summary: "Tool",
          payload: {},
          turnId: null,
          sequence: 1,
          createdAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });
    let sequence = 0;
    const events = diffThreadEvents({
      previous,
      next,
      nextSequence: () => {
        sequence += 1;
        return sequence;
      },
    });
    expect(events?.map((event) => event.type)).toEqual([
      "thread.session-set",
      "thread.message-sent",
      "thread.activity-appended",
    ]);
    expect(events?.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("asks for a snapshot when an existing message changes its creation time", () => {
    const previous = threadFixture({
      messages: [messageFixture("m1", "a", "2026-01-01T00:00:00.000Z")],
    });
    const next = threadFixture({
      messages: [messageFixture("m1", "b", "2026-01-02T00:00:00.000Z")],
    });
    expect(diffThreadEvents({ previous, next, nextSequence: () => 1 })).toBeNull();
  });

  it("asks for a snapshot when an activity disappears", () => {
    const activity = {
      id: "a1",
      tone: "tool",
      kind: "tool.started",
      summary: "Tool",
      payload: {},
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const previous = threadFixture({ activities: [activity] });
    const next = threadFixture({ activities: [] });
    expect(diffThreadEvents({ previous, next, nextSequence: () => 1 })).toBeNull();
  });

  it("asks for a snapshot when a session is cleared", () => {
    const previous = threadFixture();
    const next = threadFixture({ session: null });
    expect(diffThreadEvents({ previous, next, nextSequence: () => 1 })).toBeNull();
  });

  it("asks for a snapshot when the thread moves its clock backwards", () => {
    const previous = threadFixture({ updatedAt: "2026-01-02T00:00:00.000Z" });
    const next = threadFixture({ updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(diffThreadEvents({ previous, next, nextSequence: () => 1 })).toBeNull();
  });
});
