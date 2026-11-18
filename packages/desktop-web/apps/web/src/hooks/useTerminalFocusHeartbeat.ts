// FILE: useTerminalFocusHeartbeat.ts
// Purpose: Report the daemon-owned terminal the visible page actually has focused.
// Layer: Terminal focus bridge to the daemon's client heartbeat
// Exports: focus payload resolver plus the viewport hook.
//
// The daemon clears terminal attention only for a heartbeat whose appVisible is true
// and whose focusedTerminalId names a terminal it owns. The bridge resolves the
// (threadId, terminalId) pair against its live sessions, so this hook never sends a
// daemon id itself and cannot clear a sibling pane or another host by guessing one.

import type { TerminalFocusHeartbeatInput } from "@synara/contracts";
import { useEffect, useState, type RefObject } from "react";

import { readNativeApi } from "~/nativeApi";

export function resolveTerminalFocusHeartbeat(input: {
  threadId: string;
  terminalId: string;
  terminalFocused: boolean;
  terminalVisible: boolean;
  pageVisible: boolean;
  windowFocused: boolean;
}): TerminalFocusHeartbeatInput {
  const appVisible = input.pageVisible && input.windowFocused;
  const reportTerminal =
    input.terminalFocused && input.terminalVisible && input.pageVisible && input.windowFocused;
  return {
    threadId: input.threadId,
    appVisible,
    ...(reportTerminal ? { terminalId: input.terminalId } : {}),
  };
}

function heartbeatKey(payload: TerminalFocusHeartbeatInput): string {
  return `${payload.terminalId ?? ""}\u0000${payload.appVisible}`;
}

// A reload or crash can leave the daemon holding the previous page's focal terminal.
// The first terminal viewport clears that mark once, before it reports any real focus.
let startupFocusCleared = false;

// One pane at a time owns DOM focus. Only that viewport answers window/visibility
// transitions, so a previously focused sibling cannot overwrite the live focus with
// a stale "no terminal" heartbeat when the window comes back.
let focusedOwner: symbol | null = null;

export function useTerminalFocusHeartbeat(input: {
  containerRef: RefObject<HTMLElement | null>;
  threadId: string;
  terminalId: string;
  isVisible: boolean;
}): void {
  const { containerRef, isVisible, terminalId, threadId } = input;
  const [owner] = useState(() => Symbol("terminal-focus-owner"));

  useEffect(() => {
    const mount = containerRef.current;
    const focusHeartbeat = readNativeApi()?.terminal.focusHeartbeat;
    if (!mount || !focusHeartbeat) return;
    const ownsFocus = () => focusedOwner === owner;

    let terminalFocused = mount.contains(document.activeElement);
    if (terminalFocused && isVisible) focusedOwner = owner;
    let pageVisible = document.visibilityState === "visible";
    let windowFocused = document.hasFocus();
    let lastKey: string | null = null;
    let reportedFocus = false;

    if (!startupFocusCleared) {
      startupFocusCleared = true;
      const startupPayload = resolveTerminalFocusHeartbeat({
        threadId,
        terminalId,
        terminalFocused: false,
        terminalVisible: isVisible,
        pageVisible,
        windowFocused,
      });
      lastKey = heartbeatKey(startupPayload);
      void focusHeartbeat(startupPayload).catch(() => undefined);
    }

    const send = (payload: TerminalFocusHeartbeatInput) => {
      const key = heartbeatKey(payload);
      if (key === lastKey) return;
      // A terminal that never took focus must not establish client presence just
      // because its viewport mounted.
      if (lastKey === null && payload.terminalId === undefined) return;
      lastKey = key;
      reportedFocus = payload.terminalId !== undefined;
      void focusHeartbeat(payload).catch(() => undefined);
    };

    const report = () => {
      send(
        resolveTerminalFocusHeartbeat({
          threadId,
          terminalId,
          terminalFocused,
          terminalVisible: isVisible,
          pageVisible,
          windowFocused,
        }),
      );
    };

    const onFocusIn = () => {
      if (!isVisible) return;
      focusedOwner = owner;
      terminalFocused = true;
      report();
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && mount.contains(next)) return;
      const wasOwner = ownsFocus();
      terminalFocused = false;
      if (!wasOwner) return;
      report();
      focusedOwner = null;
    };
    const onWindowFocus = () => {
      windowFocused = true;
      if (!ownsFocus()) return;
      report();
    };
    const onWindowBlur = () => {
      windowFocused = false;
      if (!ownsFocus()) return;
      report();
    };
    const onVisibilityChange = () => {
      pageVisible = document.visibilityState === "visible";
      if (!ownsFocus()) return;
      report();
    };

    mount.addEventListener("focusin", onFocusIn);
    mount.addEventListener("focusout", onFocusOut);
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    report();

    return () => {
      mount.removeEventListener("focusin", onFocusIn);
      mount.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("focus", onWindowFocus);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Closing, hiding, or remounting the pane must not leave a focus mark that
      // keeps suppressing notifications for that terminal. A non-owner never had
      // the daemon's focus, so it must not overwrite the live pane's mark either.
      if (ownsFocus()) {
        if (reportedFocus) {
          void focusHeartbeat({
            threadId,
            appVisible: pageVisible && windowFocused,
          }).catch(() => undefined);
        }
        focusedOwner = null;
      }
    };
  }, [containerRef, isVisible, owner, terminalId, threadId]);
}
