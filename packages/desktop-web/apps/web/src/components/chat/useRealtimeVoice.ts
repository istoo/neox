// FILE: useRealtimeVoice.ts
// Purpose: One shared realtime voice runtime for the composer, with thread-change cleanup,
//          localized error reporting, and the toggle/mute API the footer consumes.
// Layer: Chat composer hook
// Depends on: lib/realtimeVoice, the i18n instance, and the toast manager.

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useTranslation } from "~/i18n";
import {
  RealtimeVoiceRuntime,
  describeRealtimeVoiceError,
  type RealtimeVoiceSnapshot,
} from "../../lib/realtimeVoice";
import { toastManager } from "../ui/toast";

/** Voice belongs to the visible conversation; only one composer can hold the microphone. */
const runtime = new RealtimeVoiceRuntime();

function localizedVoiceError(error: unknown, t: (key: string) => string): string {
  const message = describeRealtimeVoiceError(error);
  if (message.includes("Microphone access was denied")) return t("chat:realtimeVoiceMicDenied");
  if (message.includes("No microphone was found")) return t("chat:realtimeVoiceNoMicrophone");
  if (message.includes("unavailable in this build")) return t("chat:realtimeVoiceUnavailable");
  return message;
}

export interface UseRealtimeVoiceResult {
  snapshot: RealtimeVoiceSnapshot;
  active: boolean;
  startOrStop: () => void;
  toggleMute: () => void;
}

export function useRealtimeVoice(options: {
  agentId: string | null;
  enabled: boolean;
}): UseRealtimeVoiceResult {
  const { agentId, enabled } = options;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );

  // Navigating to another conversation must release the microphone: the daemon's voice mode is
  // bound to one agent and would otherwise keep speaking into a thread nobody is watching.
  useEffect(() => {
    if (snapshot.agentId !== null && snapshot.agentId !== agentId) {
      void runtime.stop();
    }
  }, [agentId, snapshot.agentId]);

  // An approval or a closed pane removes the microphone affordance; release it too.
  useEffect(() => {
    if (!enabled && runtime.isActive()) {
      void runtime.stop();
    }
  }, [enabled]);

  useEffect(() => {
    if (!snapshot.error) return;
    toastManager.add({ type: "error", title: snapshot.error });
    runtime.clearError();
  }, [snapshot.error]);

  useEffect(() => {
    return () => {
      void runtime.stop();
    };
  }, []);

  const startOrStop = useCallback(() => {
    if (!enabled || !agentId) return;
    if (runtime.isActiveFor(agentId)) {
      void runtime.stop();
      return;
    }
    void runtime.start(agentId).catch((error: unknown) => {
      toastManager.add({ type: "error", title: localizedVoiceError(error, t) });
    });
  }, [agentId, enabled, t]);

  const toggleMute = useCallback(() => runtime.toggleMute(), []);

  return {
    snapshot,
    active: snapshot.phase !== "idle",
    startOrStop,
    toggleMute,
  };
}
