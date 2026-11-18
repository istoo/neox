// FILE: useThreadAttentionClear.ts
// Purpose: Clear the viewed agent's Neox attention mark on the same triggers the old app used:
//          entering the agent (and returning to the window), focusing the composer, sending a
//          prompt, and leaving the agent or the thread. Best effort: the mark is advisory and a
//          failed clear must never block the composer or navigation.
// Layer: Web app hook

import { useCallback, useEffect, useRef } from "react";

import { readNativeApi } from "~/nativeApi";
import {
  shouldClearThreadAttention,
  type ThreadAttentionClearTrigger,
} from "~/threadAttentionClear.logic";

function documentIsVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export interface ThreadAttentionClearController {
  readonly clearOnInputFocus: () => void;
  readonly clearOnPromptSend: () => void;
}

export function useThreadAttentionClear({
  threadId,
  isFocused,
  hasPendingPermission = false,
}: {
  threadId: string | null;
  /** False for an inactive split pane; the app treats a blurred agent as left. */
  isFocused: boolean;
  /** A pending approval/question is the attention; merely viewing must not clear it. */
  hasPendingPermission?: boolean;
}): ThreadAttentionClearController {
  const visibleRef = useRef(documentIsVisible());

  const clear = useCallback(
    (trigger: ThreadAttentionClearTrigger) => {
      if (
        !shouldClearThreadAttention({
          threadId,
          isDocumentVisible: visibleRef.current,
          trigger,
          hasPendingPermission,
        })
      ) {
        return;
      }
      void readNativeApi()
        ?.neolix?.attention.clearAgent({ threadId: threadId! })
        .catch(() => {});
    },
    [hasPendingPermission, threadId],
  );

  // The daemon keeps the mark until the agent changes; return to a focused window clears it
  // the same way the app's `focus-entry` does after backgrounding.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const update = () => {
      const visible = documentIsVisible();
      const wasVisible = visibleRef.current;
      visibleRef.current = visible;
      if (!wasVisible && visible) clear("focus-entry");
    };
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [clear]);

  useEffect(() => {
    if (isFocused) {
      clear("focus-entry");
      return;
    }
    clear("agent-blur");
  }, [clear, isFocused]);

  // Leaving the agent (thread route change or unmount) clears with the old thread id.
  useEffect(() => () => clear("agent-blur"), [clear]);

  return {
    clearOnInputFocus: useCallback(() => clear("input-focus"), [clear]),
    clearOnPromptSend: useCallback(() => clear("prompt-send"), [clear]),
  };
}
