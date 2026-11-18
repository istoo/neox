// FILE: wsTransportEvents.ts
// Purpose: Publish renderer-local WebSocket transport state changes to UI runtimes.
// Layer: Client runtime transport utility
// Exports: event helpers used by wsNativeApi and terminal runtime recovery.

import type { ThreadId, WsCompatibilityError } from "@synara/contracts";

export type WsTransportState = "connecting" | "open" | "closed" | "incompatible" | "disposed";

export const SYNARA_WS_TRANSPORT_STATE_EVENT = "synara:ws-transport-state";
export const SYNARA_WS_COMPATIBILITY_ISSUE_EVENT = "synara:ws-compatibility-issue";

let latestCompatibilityIssue: WsCompatibilityError | null = null;
let latestTransportState: WsTransportState | null = null;

const transportStateListeners = new Set<(state: WsTransportState) => void>();
const compatibilityIssueListeners = new Set<(issue: WsCompatibilityError | null) => void>();

export function readLatestWsTransportState(): WsTransportState | null {
  return latestTransportState;
}

const turnSettlements = new Map<symbol, ThreadId>();
const settlementListeners = new Set<() => void>();
let settlingThreadIds: ReadonlySet<ThreadId> = new Set();

export function getWsSettlingThreadIds(): ReadonlySet<ThreadId> {
  return settlingThreadIds;
}

export function subscribeWsTurnSettlements(listener: () => void): () => void {
  settlementListeners.add(listener);
  return () => {
    settlementListeners.delete(listener);
  };
}

/** Retains pending UI state across navigation until the original send has a verdict. */
export function trackWsTurnSettlement(threadId: ThreadId): () => void {
  const token = Symbol();
  const notify = () => {
    settlingThreadIds = new Set(turnSettlements.values());
    for (const listener of settlementListeners) {
      try {
        listener();
      } catch {
        // UI listeners must not turn an uncertain send into a reported failure.
      }
    }
  };
  turnSettlements.set(token, threadId);
  notify();
  return () => {
    if (turnSettlements.delete(token)) notify();
  };
}

export interface WsTransportStateEventDetail {
  state: WsTransportState;
}

export interface WsCompatibilityIssueEventDetail {
  issue: WsCompatibilityError | null;
}

// Emits a renderer-local event without leaking transport internals into UI code.
export function emitWsTransportState(state: WsTransportState): void {
  latestTransportState = state;
  for (const listener of transportStateListeners) {
    try {
      listener(state);
    } catch {
      // A listener must not break the transport it observes.
    }
  }
}

// Subscribes to the shared transport state event. Returns an idempotent cleanup.
export function addWsTransportStateListener(
  listener: (state: WsTransportState) => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (options?.replayCurrent && latestTransportState) {
    listener(latestTransportState);
  }
  transportStateListeners.add(listener);
  return () => {
    transportStateListeners.delete(listener);
  };
}

export function readLatestWsCompatibilityIssue(): WsCompatibilityError | null {
  return latestCompatibilityIssue;
}

export function emitWsCompatibilityIssue(issue: WsCompatibilityError | null): void {
  latestCompatibilityIssue = issue;
  for (const listener of compatibilityIssueListeners) {
    try {
      listener(issue);
    } catch {
      // A listener must not break the transport it observes.
    }
  }
}

export function addWsCompatibilityIssueListener(
  listener: (issue: WsCompatibilityError | null) => void,
  options?: { readonly replayCurrent?: boolean },
): () => void {
  if (options?.replayCurrent) listener(latestCompatibilityIssue);
  compatibilityIssueListeners.add(listener);
  return () => {
    compatibilityIssueListeners.delete(listener);
  };
}
