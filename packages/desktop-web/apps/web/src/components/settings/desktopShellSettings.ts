// FILE: desktopShellSettings.ts
// Purpose: Read and write the Electron shell's own settings through its generic
//          command channel (`neolixDesktop.invoke`). Browser-only builds have no
//          channel, so every caller gates on `desktopShellAvailable()`.
// Layer: Settings model
// Exports: shell settings types, availability check, and the query/mutation hook.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { toastManager } from "~/components/ui/toast";
import { t } from "~/i18n";

export const DESKTOP_SHELL_SETTINGS_QUERY_KEY = ["neolix-desktop-settings"] as const;

export type DesktopTrayClick = "window" | "panel";
export type DesktopPreventSleepMode = "off" | "on" | "display";
export type DesktopReleaseChannel = "stable" | "beta";
export type DesktopTrayDisplayAs = "used" | "remaining";
export type DesktopTrayCurrency = "usd" | "cny";
export type DesktopTrayNumberUnits = "compact" | "wan";

/** The subset of the shell's settings these helpers read. Unknown fields pass through. */
export interface DesktopShellSettings {
  readonly releaseChannel: DesktopReleaseChannel;
  readonly notifications: { readonly playSound: boolean };
  readonly daemon: {
    readonly manageBuiltInDaemon: boolean;
    readonly keepRunningAfterQuit: boolean;
  };
  readonly preventSleep: DesktopPreventSleepMode;
  readonly launchAtLogin: boolean;
  readonly dockVisible: boolean;
  readonly confirmQuit: boolean;
  readonly lightweightMode: boolean;
  readonly tray: DesktopTrayClick;
  readonly panelShortcut: string;
  readonly autoCheckUpdates: boolean;
  readonly updateCheckMinutes: number;
  readonly autoDownloadUpdates: boolean;
  readonly autoRestartOnUpdate: boolean;
  readonly updateMirror: string;
  readonly noUpdatePill: boolean;
  readonly trayUsages: ReadonlyArray<string>;
  readonly trayUsageEvery: number;
  readonly trayNoLogos: boolean;
  readonly trayNoBird: boolean;
  readonly trayNoNumber: boolean;
  readonly trayPace: boolean;
  readonly trayNoCost: boolean;
  readonly trayWindows: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly trayDisplayAs: DesktopTrayDisplayAs;
  readonly trayCurrency: DesktopTrayCurrency;
  readonly trayNumberUnits: DesktopTrayNumberUnits;
}

type DesktopShellInvoke = NonNullable<Window["neolixDesktop"]>["invoke"];

function shellInvoke(): DesktopShellInvoke | null {
  if (typeof window === "undefined") return null;
  const invoke = window.neolixDesktop?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

export function desktopShellAvailable(): boolean {
  return shellInvoke() !== null;
}

export function desktopShellPlatform(): string {
  if (typeof window === "undefined") return "";
  return window.neolixDesktop?.platform ?? "";
}

export function getDesktopShellSettings(): Promise<DesktopShellSettings> {
  const invoke = shellInvoke();
  if (!invoke) return Promise.reject(new Error("The desktop shell is unavailable."));
  return invoke<DesktopShellSettings>("get_desktop_settings");
}

/** Runs another of the shell's own commands (`desktop_daemon_status`, `install_cli`, …). */
export function invokeDesktopShellCommand<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const invoke = shellInvoke();
  if (!invoke) return Promise.reject(new Error("The desktop shell is unavailable."));
  return invoke<T>(command, args ?? {});
}

export function patchDesktopShellSettings(
  patch: Record<string, unknown>,
): Promise<DesktopShellSettings> {
  const invoke = shellInvoke();
  if (!invoke) return Promise.reject(new Error("The desktop shell is unavailable."));
  return invoke<DesktopShellSettings>("patch_desktop_settings", patch);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesktopShellSettings(active: boolean) {
  const available = desktopShellAvailable();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: DESKTOP_SHELL_SETTINGS_QUERY_KEY,
    queryFn: getDesktopShellSettings,
    enabled: active && available,
    staleTime: 5_000,
  });
  const mutation = useMutation({
    mutationFn: patchDesktopShellSettings,
    onSuccess: (saved) => {
      queryClient.setQueryData(DESKTOP_SHELL_SETTINGS_QUERY_KEY, saved);
    },
  });

  const patch = useCallback(
    async (next: Record<string, unknown>): Promise<boolean> => {
      try {
        const saved = await mutation.mutateAsync(next);
        queryClient.setQueryData(DESKTOP_SHELL_SETTINGS_QUERY_KEY, saved);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:desktopSettingSaveFailed"),
          description: messageOf(error),
        });
        return false;
      }
    },
    [mutation, queryClient],
  );

  return {
    available,
    settings: query.data,
    isLoading: query.isLoading,
    saving: mutation.isPending,
    patch,
  };
}
