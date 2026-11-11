// FILE: useAccessibilityAppearance.ts
// Purpose: Projects the accessibility switches (Colorblind mode, Reduce motion) onto the
//          document root. CSS keys off the data attributes so every surface follows without
//          each component reading settings. The system prefers-reduced-motion media query
//          still applies on its own; this only lets the user force the same reduction.
// Layer: Web appearance state hook
// Exports: useAccessibilityAppearance

import { useEffect } from "react";

import { useAppSettings } from "../appSettings";
import { setForcedReduceMotion } from "../lib/motionPreference";

export function useAccessibilityAppearance() {
  const { settings } = useAppSettings();

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-reduce-motion", settings.reduceMotion);
    root.toggleAttribute("data-colorblind", settings.colorblindMode);
    setForcedReduceMotion(settings.reduceMotion);

    return () => {
      root.removeAttribute("data-reduce-motion");
      root.removeAttribute("data-colorblind");
      setForcedReduceMotion(false);
    };
  }, [settings.colorblindMode, settings.reduceMotion]);
}
