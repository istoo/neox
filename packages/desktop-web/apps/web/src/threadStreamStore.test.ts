// FILE: threadStreamStore.test.ts
// Purpose: Proves a tail diff from the bridge and a whole thread snapshot land the same detail
// in the web store, so the stream can send events instead of re-sending the thread.

import {
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { diffThreadEvents } from "@synara/shared/threadStreamEvents";
import { applyOrchestrationEvents } from "./storeEventReducer";
import { syncServerThreadDetailHotPath } from "./storeProjection";
import type { AppState } from "./storeState";
import {
  makeActivity,
  makeReadModelThread,
  makeState,
  makeThread,
  threadsOf,
} from "./storeTestFixtures";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";

type ReadModelThread = OrchestrationReadModel["threads"][number];

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:05:00.000Z";

function session(updatedAt: string) {
  return {
    threadId: THREAD_ID,
    status: "running" as const,
    providerName: "codex" as const,
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: TurnId.makeUnsafe("turn-1"),
    lastError: null,
    updatedAt,
  };
}

function latestTurn(assistantMessageId: string | null) {
  return {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "running" as const,
    requestedAt: T0,
    startedAt: T0,
    completedAt: null,
    assistantMessageId:
      assistantMessageId === null ? null : MessageId.makeUnsafe(assistantMessageId),
  };
}

function message(id: string, role: "user" | "assistant", text: string, at: string) {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    turnId: role === "assistant" ? TurnId.makeUnsafe("turn-1") : null,
    streaming: false,
    source: "native" as const,
    createdAt: at,
    updatedAt: at,
  };
}

/** The fields the bridge's fold always sets on a thread shell. */
function thread(overrides: Partial<ReadModelThread>): ReadModelThread {
  return makeReadModelThread({
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-1"),
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    createdAt: T0,
    updatedAt: T0,
    session: session(T0),
    latestTurn: latestTurn(null),
    latestUserMessageAt: T0,
    latestHumanMessageAt: T0,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  });
}

function baseState(previous: ReadModelThread): AppState {
  const empty = makeState(makeThread({ id: THREAD_ID }));
  return syncServerThreadDetailHotPath(empty, previous, 10);
}

function applyEvents(state: AppState, events: ReturnType<typeof diffThreadEvents>): AppState {
  if (events === null) throw new Error("Expected stream events");
  return applyOrchestrationEvents(
    state,
    events.map((event, index) => ({ ...event, sequence: 100 + index })),
  );
}

describe("thread stream events match a thread snapshot", () => {
  it("lands the same detail while a turn streams and its tool finishes", () => {
    const started = makeActivity({
      id: "tool-1",
      kind: "tool.started",
      createdAt: T0,
      sequence: 1,
      turnId: "turn-1",
    });
    const previous = thread({
      messages: [message("m1", "user", "hello", T0), message("m2", "assistant", "par", T0)],
      activities: [started],
      latestTurn: latestTurn("m2"),
    });
    const next = thread({
      updatedAt: T1,
      session: session(T1),
      messages: [
        message("m1", "user", "hello", T0),
        { ...message("m2", "assistant", "partial reply", T1), createdAt: T0 },
      ],
      activities: [
        started,
        makeActivity({
          id: "tool-2",
          kind: "tool.completed",
          createdAt: T1,
          sequence: 2,
          turnId: "turn-1",
        }),
      ],
      latestTurn: latestTurn("m2"),
    });

    let sequence = 100;
    const events = diffThreadEvents({
      previous: previous as unknown as OrchestrationThread,
      next: next as unknown as OrchestrationThread,
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
    const before = baseState(previous);
    const viaEvents = applyEvents(before, events);
    const viaSnapshot = syncServerThreadDetailHotPath(before, next, 10);
    // Applying any event materializes this derived signal as a boolean; a snapshot leaves it
    // absent when the server did not send it. Both read as "no actionable plan".
    const detail = (state: AppState) => {
      const thread = threadsOf(state)[0]!;
      return { ...thread, hasActionableProposedPlan: thread.hasActionableProposedPlan ?? false };
    };
    expect(detail(viaEvents)).toEqual(detail(viaSnapshot));
  });

  it("emits a proposed-plan upsert for a new plan", () => {
    const previous = thread({ messages: [message("m1", "user", "hello", T0)] });
    const next = thread({
      updatedAt: T1,
      session: session(T1),
      messages: [message("m1", "user", "hello", T0)],
      proposedPlans: [
        {
          id: OrchestrationProposedPlanId.makeUnsafe("plan-1"),
          turnId: TurnId.makeUnsafe("turn-1"),
          planMarkdown: "Do the thing",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: T1,
          updatedAt: T1,
        },
      ],
    });
    let sequence = 100;
    const events = diffThreadEvents({
      previous: previous as unknown as OrchestrationThread,
      next: next as unknown as OrchestrationThread,
      nextSequence: () => {
        sequence += 1;
        return sequence;
      },
    });
    expect(events?.map((event) => event.type)).toContain("thread.proposed-plan-upserted");
  });

  it("refuses to express a removed message", () => {
    const previous = thread({
      messages: [message("m1", "user", "hello", T0), message("m2", "assistant", "hi", T0)],
      latestTurn: latestTurn("m2"),
    });
    const next = thread({ messages: [message("m2", "assistant", "hi", T0)] });
    expect(
      diffThreadEvents({
        previous: previous as unknown as OrchestrationThread,
        next: next as unknown as OrchestrationThread,
        nextSequence: () => 1,
      }),
    ).toBeNull();
  });

  it("refuses to express a reordered activity list", () => {
    const first = makeActivity({ id: "a1", sequence: 1, createdAt: T0 });
    const second = makeActivity({ id: "a2", sequence: 2, createdAt: T0 });
    const previous = thread({ activities: [first, second] });
    const next = thread({ activities: [second, first] });
    expect(
      diffThreadEvents({
        previous: previous as unknown as OrchestrationThread,
        next: next as unknown as OrchestrationThread,
        nextSequence: () => 1,
      }),
    ).toBeNull();
  });

  it("names events with strictly increasing sequences", () => {
    const previous = thread({ messages: [] });
    const next = thread({
      updatedAt: T1,
      session: session(T1),
      messages: [message("m1", "assistant", "one", T1), message("m2", "assistant", "two", T1)],
      latestTurn: latestTurn("m2"),
    });
    let sequence = 100;
    const events =
      diffThreadEvents({
        previous: previous as unknown as OrchestrationThread,
        next: next as unknown as OrchestrationThread,
        nextSequence: () => {
          sequence += 1;
          return sequence;
        },
      }) ?? [];
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual(sequences.toSorted((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(events.every((event) => event.eventId.length > 0)).toBe(true);
    expect(events.every((event) => event.aggregateId === THREAD_ID)).toBe(true);
  });
});
