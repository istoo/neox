// FILE: gatewayViewPreferences.logic.ts
// Purpose: Remember the request-detail tab and the SSE reading the reader picked.
//          Both are web-only preferences kept in localStorage; a missing or
//          unreadable store falls back to the same defaults the app uses.

export type HistoryBodyTab = "request" | "response" | "upstream" | "prompt" | "reply";
export type SseView = "reply" | "events" | "raw";

const HISTORY_TAB_KEY = "neolix.gatewayHistoryTab";
const SSE_VIEW_KEY = "neolix.sseView";

const HISTORY_TABS: readonly HistoryBodyTab[] = [
  "request",
  "response",
  "upstream",
  "prompt",
  "reply",
];

export function parseHistoryBodyTab(value: string | null | undefined): HistoryBodyTab {
  return HISTORY_TABS.find((tab) => tab === value) ?? "request";
}

/**
 * The reading a stream opens on: the kept one when it is still offered, else
 * Events. Reply is dropped for a stream that spells no reply.
 */
export function resolveSseView(saved: string | null | undefined, hasReply: boolean): SseView {
  if (saved === "reply" && hasReply) {
    return "reply";
  }
  if (saved === "events" || saved === "raw") {
    return saved;
  }
  return "events";
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadHistoryBodyTab(): HistoryBodyTab {
  try {
    return parseHistoryBodyTab(storage()?.getItem(HISTORY_TAB_KEY));
  } catch {
    return "request";
  }
}

export function saveHistoryBodyTab(tab: HistoryBodyTab): void {
  try {
    storage()?.setItem(HISTORY_TAB_KEY, tab);
  } catch {
    // Storage can be unavailable (private windows, cleared data); the tab still works.
  }
}

export function initialSseView(hasReply: boolean): SseView {
  try {
    return resolveSseView(storage()?.getItem(SSE_VIEW_KEY), hasReply);
  } catch {
    return "events";
  }
}

export function saveSseView(view: SseView): void {
  try {
    storage()?.setItem(SSE_VIEW_KEY, view);
  } catch {
    // Storage can be unavailable (private windows, cleared data); the view still works.
  }
}
