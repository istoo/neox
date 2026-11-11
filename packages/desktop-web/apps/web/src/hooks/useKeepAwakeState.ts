// FILE: useKeepAwakeState.ts
// Purpose: Live keep-awake state. The Neox desktop bridge owns it when present;
//          plain browser/server builds keep the original WebSocket push.
// Layer: Web hooks
// Exports: useKeepAwakeState

import type { DesktopKeepAwakeState, ServerKeepAwakeState } from "@synara/contracts";
import { useEffect, useState } from "react";
import { NEOLIX_KEEP_AWAKE_UI_ENABLED } from "~/neolixFeatures";
import { onServerKeepAwakeUpdated } from "../wsNativeApi";

const DESKTOP_POLL_MS = 5_000;

function toServerState(state: DesktopKeepAwakeState): ServerKeepAwakeState {
  return {
    available: true,
    mode: state.enabled ? "always" : "off",
    active: state.active,
    error: null,
  };
}

/**
 * Returns the latest keep-awake state, or `null` until the first answer.
 * Callers hide keep-awake UI while `null` or `available === false`.
 */
export function useKeepAwakeState(): ServerKeepAwakeState | null {
  const desktop = typeof window === "undefined" ? undefined : window.desktopBridge?.keepAwake;
  const [state, setState] = useState<ServerKeepAwakeState | null>(null);

  useEffect(() => {
    if (!NEOLIX_KEEP_AWAKE_UI_ENABLED) return;
    if (desktop) {
      let cancelled = false;
      const read = () => {
        void desktop.getState().then(
          (next) => {
            if (!cancelled) setState(toServerState(next));
          },
          () => {},
        );
      };
      read();
      // The bridge has no push channel for this preference; a slow poll keeps
      // the settings row in step with the tray/native side.
      const timer = window.setInterval(read, DESKTOP_POLL_MS);
      return () => {
        cancelled = true;
        window.clearInterval(timer);
      };
    }
    return onServerKeepAwakeUpdated((payload) => setState(payload.keepAwake));
  }, [desktop]);

  return NEOLIX_KEEP_AWAKE_UI_ENABLED ? state : null;
}
