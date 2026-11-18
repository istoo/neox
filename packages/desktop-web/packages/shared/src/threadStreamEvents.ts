// Thread stream event derivation shared by the bridge (which decides what to send) and the web
// tests (which prove the client store lands the same detail from events and from a snapshot).

import type { EventId, OrchestrationEvent, OrchestrationThread } from "@synara/contracts";

/** Fields a stream event cannot rewrite; a change in any of them needs a snapshot. */
const NON_EVENT_FIELDS = new Set([
  "messages",
  "activities",
  "proposedPlans",
  "session",
  "updatedAt",
]);

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Describes the next thread detail as stream events, or returns null when the change needs a
 * whole snapshot. Only tail appends and in-place updates are expressible: any removal or
 * reordering (a reverted turn, a shorter activity list, a plan that moved) returns null, and
 * the caller sends a snapshot instead.
 */
export function diffThreadEvents(input: {
  previous: OrchestrationThread | null;
  next: OrchestrationThread;
  nextSequence: () => number;
}): OrchestrationEvent[] | null {
  const { previous, next } = input;
  if (!previous || previous.id !== next.id) return null;
  // The event stream only moves `updatedAt` forward; a snapshot may also move it back.
  if (next.updatedAt < previous.updatedAt) return null;
  for (const key of Object.keys(next)) {
    if (NON_EVENT_FIELDS.has(key)) continue;
    if (
      !sameJson((previous as Record<string, unknown>)[key], (next as Record<string, unknown>)[key])
    )
      return null;
  }

  const messages = collectTailUpdates(
    previous.messages,
    next.messages,
    // A message's createdAt never changes; the web's merge keeps the stored one.
    (before, after) => before.createdAt === after.createdAt,
  );
  if (messages === null) return null;
  const activities = collectTailUpdates(previous.activities, next.activities);
  if (activities === null) return null;
  const plans = collectTailUpdates(previous.proposedPlans, next.proposedPlans);
  if (plans === null) return null;
  const sessionChanged = !sameJson(previous.session, next.session);
  if (!sessionChanged && previous.updatedAt !== next.updatedAt) return null;

  const base = (sequence: number) => ({
    sequence,
    eventId: `stream:${next.id}:${sequence}` as EventId,
    aggregateKind: "thread" as const,
    aggregateId: next.id,
    occurredAt: next.updatedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  });

  const events: OrchestrationEvent[] = [];
  if (sessionChanged) {
    // The stream can set a session but has no event that clears one.
    if (!next.session) return null;
    events.push({
      ...base(input.nextSequence()),
      type: "thread.session-set",
      payload: { threadId: next.id, session: next.session },
    });
  }
  for (const message of messages) {
    events.push({
      ...base(input.nextSequence()),
      type: "thread.message-sent",
      payload: {
        threadId: next.id,
        messageId: message.id,
        role: message.role,
        text: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.skills ? { skills: message.skills } : {}),
        ...(message.mentions ? { mentions: message.mentions } : {}),
        ...(message.dispatchMode ? { dispatchMode: message.dispatchMode } : {}),
        ...(message.dispatchOrigin ? { dispatchOrigin: message.dispatchOrigin } : {}),
        ...(message.startsNewTurn !== undefined ? { startsNewTurn: message.startsNewTurn } : {}),
        turnId: message.turnId,
        streaming: message.streaming,
        source: message.source,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }
  for (const activity of activities) {
    events.push({
      ...base(input.nextSequence()),
      type: "thread.activity-appended",
      payload: { threadId: next.id, activity },
    });
  }
  for (const proposedPlan of plans) {
    events.push({
      ...base(input.nextSequence()),
      type: "thread.proposed-plan-upserted",
      payload: { threadId: next.id, proposedPlan },
    });
  }
  return events;
}

/**
 * Items a stream can append or update in place, or null when the next list removed or
 * reordered an item. Changed existing items are returned too: an activity's payload and a
 * message's text can change at their existing position.
 */
function collectTailUpdates<T extends { readonly id: string }>(
  previous: readonly T[],
  next: readonly T[],
  acceptChange?: (before: T, after: T) => boolean,
): T[] | null {
  if (next.length < previous.length) return null;
  const updates: T[] = [];
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
    if (!before || !after || before.id !== after.id) return null;
    if (acceptChange && !acceptChange(before, after)) return null;
    if (!sameJson(before, after)) updates.push(after);
  }
  for (let index = previous.length; index < next.length; index += 1) {
    const after = next[index];
    if (after) updates.push(after);
  }
  return updates;
}
