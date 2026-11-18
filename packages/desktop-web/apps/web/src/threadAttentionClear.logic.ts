// FILE: threadAttentionClear.logic.ts
// Purpose: The visibility/trigger rule behind clearing an agent's Neox attention mark. The app
//          clears on focus entry, composer focus, prompt send, and leaving the agent; a
//          permission request is never cleared by merely viewing it because the decision is
//          still pending (the daemon owns that distinction, so the web surface only has the
//          trigger timings to match).
// Layer: Web app logic

export type ThreadAttentionClearTrigger =
  | "focus-entry"
  | "input-focus"
  | "prompt-send"
  | "agent-blur";

export interface ShouldClearThreadAttentionInput {
  readonly threadId: string | null | undefined;
  readonly isDocumentVisible: boolean;
  readonly trigger: ThreadAttentionClearTrigger;
  /** Focus-entry is suppressed after an attention that arrived while already viewing. */
  readonly hasDeferredFocusEntryClear?: boolean;
  /** A pending approval or question is the attention; viewing it must not mark it read. */
  readonly hasPendingPermission?: boolean;
}

export function shouldClearThreadAttention(input: ShouldClearThreadAttentionInput): boolean {
  if (!input.threadId?.trim()) return false;
  if (!input.isDocumentVisible) return false;
  if (input.hasPendingPermission === true) return false;
  if (input.trigger === "focus-entry" && input.hasDeferredFocusEntryClear === true) return false;
  return true;
}
