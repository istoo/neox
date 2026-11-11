// FILE: motionPreference.ts
// Purpose: A tiny external store for Settings' Reduce motion switch. Leaf primitives
//          (streaming text, the ASCII field) read it without requiring the settings
//          provider, so they stay renderable in isolation. The system media query is
//          still honored by useReduceMotion; this only adds the forced setting.
// Layer: Web appearance state
// Exports: setForcedReduceMotion, useReduceMotion

import { useSyncExternalStore } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";

let forcedReduceMotion = false;
const listeners = new Set<() => void>();

export function setForcedReduceMotion(value: boolean) {
  if (forcedReduceMotion === value) return;
  forcedReduceMotion = value;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when the user asked for it in Settings or the OS asks for it. */
export function useReduceMotion(): boolean {
  const systemReduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const forced = useSyncExternalStore(
    subscribe,
    () => forcedReduceMotion,
    () => false,
  );
  return systemReduceMotion || forced;
}
