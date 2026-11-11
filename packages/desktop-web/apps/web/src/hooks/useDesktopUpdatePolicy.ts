// FILE: useDesktopUpdatePolicy.ts
// Purpose: Honour the shell's automatic-update preferences from the web renderer.
//          The shell stores the policy and exposes check/download/install; the
//          interval and the "only while nothing is running" rule live here,
//          because the old renderer owned them and this UI replaces it.
// Layer: Root coordinator hook

import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DesktopUpdateState } from "@synara/contracts";

import { useStore } from "../store";
import { createAllThreadsSelector } from "../storeSelectors";
import {
  DESKTOP_SHELL_SETTINGS_QUERY_KEY,
  desktopShellAvailable,
  getDesktopShellSettings,
} from "../components/settings/desktopShellSettings";

/** The old updater's floor: checking more often than this is noise. */
const MINIMUM_CHECK_MINUTES = 30;

export function useDesktopUpdatePolicy(): void {
  const available = desktopShellAvailable();
  const settingsQuery = useQuery({
    queryKey: DESKTOP_SHELL_SETTINGS_QUERY_KEY,
    queryFn: getDesktopShellSettings,
    enabled: available,
    staleTime: 60_000,
  });
  const autoCheckUpdates = settingsQuery.data?.autoCheckUpdates === true;
  const updateCheckMinutes = settingsQuery.data?.updateCheckMinutes;
  const autoDownloadUpdates = settingsQuery.data?.autoDownloadUpdates === true;
  const autoRestartOnUpdate = settingsQuery.data?.autoRestartOnUpdate === true;

  const selectAllThreads = useMemo(createAllThreadsSelector, []);
  const threads = useStore(selectAllThreads);
  const anyThreadRunning = useMemo(
    () => threads.some((thread) => thread.session?.status === "running"),
    [threads],
  );
  const installRequestedRef = useRef(false);

  useEffect(() => {
    if (!available || !autoCheckUpdates) return;
    const bridge = window.desktopBridge;
    if (!bridge?.checkForUpdates) return;
    const minutes = Math.max(MINIMUM_CHECK_MINUTES, updateCheckMinutes ?? 360);
    const runCheck = () => {
      void bridge
        .checkForUpdates()
        .then(async (state) => {
          if (state.status !== "available" || !autoDownloadUpdates) return;
          await bridge.downloadUpdate?.().catch(() => undefined);
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(runCheck, minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [available, autoCheckUpdates, autoDownloadUpdates, updateCheckMinutes]);

  useEffect(() => {
    if (!available || !autoRestartOnUpdate || anyThreadRunning) return;
    const bridge = window.desktopBridge;
    if (!bridge?.onUpdateState || !bridge.installUpdate) return;
    const installWhenReady = (state: DesktopUpdateState | null) => {
      if (!state || state.status !== "downloaded" || installRequestedRef.current) return;
      installRequestedRef.current = true;
      void bridge.installUpdate?.().catch(() => {
        installRequestedRef.current = false;
      });
    };
    void bridge.getUpdateState?.().then(installWhenReady, () => undefined);
    return bridge.onUpdateState(installWhenReady);
  }, [available, anyThreadRunning, autoRestartOnUpdate]);
}
