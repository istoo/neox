import { useEffect, useRef } from "react";

import { appSettingsUpdatedAt, useAppSettings } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSettingsHostServerId } from "@/screens/settings/app/shared";
import { patchedSettingsSince } from "./app-settings-patches";

/**
 * Keeps the daemon's copy of the app's settings current, so the settings
 * part carries them to other computers, and applies what a sync brings in.
 * The app's settings live in AsyncStorage where the daemon can't read them
 * (myna's settings live in its own file), so the daemon is told instead.
 */
export function SyncAppSettingsBridge(): null {
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "sync");
  const { settings, updateSettings } = useAppSettings();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applied = useRef(false);

  useEffect(() => {
    if (!client || !supported) {
      return;
    }
    const push = () => {
      void client
        .exportSyncAppSettings(settings as unknown as Record<string, unknown>)
        .catch(() => undefined);
    };
    if (!applied.current) {
      // The first push also seeds a daemon that has no copy yet, but adopt
      // what the CLI patched while this app was closed first: this app's
      // settings must not overwrite a newer change it has not seen.
      applied.current = true;
      void (async () => {
        try {
          const copy = await client.getSyncAppSettings();
          const adopted = patchedSettingsSince(
            copy.settings,
            copy.patchedAt,
            await appSettingsUpdatedAt(),
          );
          if (Object.keys(adopted).length > 0) {
            await updateSettings(adopted as never);
            return;
          }
        } catch {
          // No copy yet, or a daemon that doesn't report patches: this app's
          // settings are what it gets.
        }
        push();
      })();
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(push, 1_500);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, [client, supported, settings, updateSettings]);

  useEffect(() => {
    if (!client || !supported) {
      return;
    }
    return client.subscribeRawMessages((message) => {
      if (message.type !== "sync.app_settings.apply") {
        return;
      }
      void updateSettings(message.payload.settings as never);
    });
  }, [client, supported, updateSettings]);

  return null;
}
