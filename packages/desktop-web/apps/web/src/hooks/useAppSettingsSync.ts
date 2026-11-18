// FILE: useAppSettingsSync.ts
// Purpose: Keeps the daemon's copy of this app's settings current, so the host's
//   settings sync carries them to other computers, and applies what a sync
//   brings in. The app's settings live in localStorage where the daemon cannot
//   read them, so the daemon is told instead.
// Layer: Web settings hook

import { useEffect, useRef } from "react";

import { appSettingsUpdatedAt, useAppSettings } from "~/appSettings";
import { neolixAppSettingsApi } from "~/lib/neolixAppSettingsApi";
import { patchedSettingsSince, toSettingsPatch } from "~/lib/appSettingsSync.logic";

/** A typed burst of setting writes becomes one export. */
const PUSH_DEBOUNCE_MS = 1_500;

export function useAppSettingsSync(): void {
  const { settings, defaults, updateSettings } = useAppSettings();
  const applied = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const push = () =>
      neolixAppSettingsApi
        .export(settings as unknown as Record<string, unknown>)
        .catch(() => undefined);

    if (!applied.current) {
      // The first push also seeds a daemon that has no copy yet, but adopt what
      // the CLI patched while this app was closed first: this app's settings
      // must not overwrite a newer change it has not seen.
      applied.current = true;
      void (async () => {
        try {
          const copy = await neolixAppSettingsApi.get();
          if (cancelled || !copy.supportsSync) return;
          const adopted = patchedSettingsSince(
            copy.settings,
            copy.patchedAt,
            appSettingsUpdatedAt(),
          );
          const patch = toSettingsPatch(adopted, defaults);
          if (Object.keys(patch).length > 0) {
            updateSettings(patch as Partial<typeof settings>);
            return;
          }
        } catch {
          // No copy yet, or a host without the sync surface: this app's
          // settings are what it gets.
        }
        if (!cancelled) await push();
      })();
      return () => {
        cancelled = true;
      };
    }

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(push, PUSH_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [defaults, settings, updateSettings]);

  useEffect(() => {
    return neolixAppSettingsApi.subscribe((event) => {
      const patch = toSettingsPatch(event.settings, defaults);
      if (Object.keys(patch).length > 0) updateSettings(patch as Partial<typeof settings>);
    });
  }, [defaults, updateSettings]);
}
