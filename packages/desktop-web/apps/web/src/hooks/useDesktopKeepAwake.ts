// FILE: useDesktopKeepAwake.ts
// Purpose: The desktop "keep this computer awake" preference for remote access.
// Layer: Web hook over the desktop bridge
// Depends on: desktopBridge.keepAwake (absent in plain browsers and older desktop builds).

import type { DesktopKeepAwakeState } from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { NEOLIX_KEEP_AWAKE_UI_ENABLED } from "~/neolixFeatures";

export interface DesktopKeepAwake {
  /** Null until the bridge answers, and always null where there is no bridge. */
  readonly state: DesktopKeepAwakeState | null;
  readonly setEnabled: (enabled: boolean) => Promise<void>;
}

export function useDesktopKeepAwake(): DesktopKeepAwake {
  const [state, setState] = useState<DesktopKeepAwakeState | null>(null);

  useEffect(() => {
    // Neox 无 keep-awake 服务：不读取 desktopBridge.keepAwake。
    if (!NEOLIX_KEEP_AWAKE_UI_ENABLED) return;
    const bridge = window.desktopBridge?.keepAwake;
    if (!bridge) return;
    let cancelled = false;
    void bridge.getState().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (enabled: boolean) => {
    const bridge = window.desktopBridge?.keepAwake;
    if (!bridge) return;
    setState((current) => (current ? { ...current, enabled } : current));
    try {
      setState(await bridge.setEnabled(enabled));
    } catch (error) {
      setState((current) => (current ? { ...current, enabled: !enabled } : current));
      throw error;
    }
  }, []);

  return { state, setEnabled };
}

/** Tell the desktop main process whether the owner allows remote connections. */
export function reportRemoteAccessAllowed(allowed: boolean): void {
  void window.desktopBridge?.keepAwake?.setRemoteAccessAllowed(allowed).catch(() => {});
}
