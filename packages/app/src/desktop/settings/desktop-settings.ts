import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  useDesktopIpcErrorReporter,
  useDesktopIpcQueryErrorToast,
} from "@/desktop/hooks/desktop-ipc-error";
import type { ReleaseChannel } from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";

const DESKTOP_SETTINGS_QUERY_KEY = ["desktop-settings"] as const;

export interface DesktopSettings {
  releaseChannel: ReleaseChannel;
  notifications: {
    playSound: boolean;
  };
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  preventSleep: PreventSleepMode;
  launchAtLogin: boolean;
  dockVisible: boolean;
  confirmQuit: boolean;
  /** Ask for a newer version by itself, as myna does unless NoAutoUpdate. */
  autoCheckUpdates: boolean;
  /** Minutes between those checks: myna's UpdateEvery choices. */
  updateCheckMinutes: number;
  /** Download a found update by itself, as myna does unless NoAutoDownload. */
  autoDownloadUpdates: boolean;
  /** Restart into an automatically downloaded update once nothing is running. */
  autoRestartOnUpdate: boolean;
  /** Prefix for GitHub release downloads, as myna's UpdateMirror; "" for none. */
  updateMirror: string;
  /** What a tray click does, as myna's Tray. */
  tray: TrayClickAction;
  /** Global shortcut that opens the window, as myna's PanelShortcut; "" for none. */
  panelShortcut: string;
  /** Allowance cards and totals beside the tray icon, as myna's TrayUsages. */
  trayUsages: string[];
  /** Minutes between menu-bar allowance refreshes (myna's TrayUsageEvery). */
  trayUsageEvery: number;
  trayNoLogos: boolean;
  trayNoBird: boolean;
  trayNoNumber: boolean;
  trayPace: boolean;
  trayNoCost: boolean;
  /** Window ids a card's menu-bar rows show, by account id. */
  trayWindows: Record<string, string[]>;
  /** How the Usage page reads percents and costs, mirrored for tray-only launches. */
  trayDisplayAs: "used" | "remaining";
  trayCurrency: "usd" | "cny";
  trayNumberUnits: "compact" | "wan";
  trayCnyPerUsd: number;
  /** myna's Lightweight mode: a closed window frees its memory; off keeps it hidden. */
  lightweightMode: boolean;
  /** myna's Update button: the header's update callout when one is out. */
  noUpdatePill: boolean;
}

/** Neolix has no separate quick panel; "panel" toggles the main window. */
export type TrayClickAction = "window" | "panel";

export type PreventSleepMode = "off" | "on" | "display";

export interface DesktopSettingsPatch {
  releaseChannel?: ReleaseChannel;
  notifications?: Partial<DesktopSettings["notifications"]>;
  daemon?: Partial<DesktopSettings["daemon"]>;
  preventSleep?: PreventSleepMode;
  launchAtLogin?: boolean;
  dockVisible?: boolean;
  confirmQuit?: boolean;
  autoCheckUpdates?: boolean;
  updateCheckMinutes?: number;
  autoDownloadUpdates?: boolean;
  autoRestartOnUpdate?: boolean;
  updateMirror?: string;
  tray?: TrayClickAction;
  panelShortcut?: string;
  trayUsages?: string[];
  trayUsageEvery?: number;
  trayNoLogos?: boolean;
  trayNoBird?: boolean;
  trayNoNumber?: boolean;
  trayPace?: boolean;
  trayNoCost?: boolean;
  trayWindows?: Record<string, string[]>;
  trayDisplayAs?: "used" | "remaining";
  trayCurrency?: "usd" | "cny";
  trayNumberUnits?: "compact" | "wan";
  trayCnyPerUsd?: number;
  lightweightMode?: boolean;
  noUpdatePill?: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  preventSleep: "off",
  launchAtLogin: false,
  dockVisible: true,
  confirmQuit: false,
  autoCheckUpdates: true,
  updateCheckMinutes: 360,
  autoDownloadUpdates: true,
  autoRestartOnUpdate: false,
  updateMirror: "",
  tray: "window",
  panelShortcut: "",
  trayUsages: [],
  trayUsageEvery: 3,
  trayNoLogos: false,
  trayNoBird: false,
  trayNoNumber: false,
  trayPace: false,
  trayNoCost: false,
  trayWindows: {},
  trayDisplayAs: "used",
  trayCurrency: "usd",
  trayNumberUnits: "compact",
  trayCnyPerUsd: 7.2,
  lightweightMode: true,
  noUpdatePill: false,
};

/** myna's TRAY_EVERY: the minutes the menu-bar refresh offers. */
export const TRAY_USAGE_EVERIES = [1, 3, 5, 10, 30] as const;

/** myna's UpdateEveries, in minutes. */
export const UPDATE_CHECK_MINUTES = [30, 60, 360, 1440] as const;

export function useDesktopSettings(): {
  settings: DesktopSettings;
  isLoading: boolean;
  isSaving: boolean;
  error: unknown;
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
} {
  const queryClient = useQueryClient();
  const reportError = useDesktopIpcErrorReporter();
  const {
    data,
    isPending,
    error: loadError,
  } = useQuery<DesktopSettings, Error>({
    queryKey: DESKTOP_SETTINGS_QUERY_KEY,
    queryFn: loadDesktopSettings,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  useDesktopIpcQueryErrorToast({
    error: loadError,
    message: i18n.t("desktop.settings.loadFailed"),
    logLabel: "[DesktopSettings] Failed to load settings",
  });

  const { mutateAsync: saveDesktopSettings, isPending: isSaving } = useMutation<
    DesktopSettings,
    Error,
    DesktopSettingsPatch,
    DesktopSettingsMutationContext
  >({
    mutationFn: updatePersistedDesktopSettings,
    onMutate: (updates) => {
      const previous =
        queryClient.getQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY) ??
        DEFAULT_DESKTOP_SETTINGS;
      queryClient.setQueryData<DesktopSettings>(
        DESKTOP_SETTINGS_QUERY_KEY,
        mergeDesktopSettings(previous, updates),
      );
      return { previous };
    },
    onSuccess: (persisted) => {
      queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, persisted);
    },
    onError: (saveError, _updates, context) => {
      if (context) {
        queryClient.setQueryData<DesktopSettings>(DESKTOP_SETTINGS_QUERY_KEY, context.previous);
      }
      reportError({
        error: saveError,
        message: i18n.t("desktop.settings.saveFailed"),
        logLabel: "[DesktopSettings] Failed to save settings",
      });
    },
  });

  const updateSettings = useCallback(
    async (updates: DesktopSettingsPatch) => {
      if (!getIsElectron()) {
        return;
      }

      await saveDesktopSettings(updates);
    },
    [saveDesktopSettings],
  );

  return {
    settings: data ?? DEFAULT_DESKTOP_SETTINGS,
    isLoading: isPending,
    isSaving,
    error: loadError ?? null,
    updateSettings,
  };
}

interface DesktopSettingsMutationContext {
  previous: DesktopSettings;
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(await invokeDesktopCommand<unknown>("get_desktop_settings"));
}

export async function updatePersistedDesktopSettings(
  updates: DesktopSettingsPatch,
): Promise<DesktopSettings> {
  if (!getIsElectron()) {
    return DEFAULT_DESKTOP_SETTINGS;
  }
  return parseDesktopSettings(
    await invokeDesktopCommand<unknown>("patch_desktop_settings", normalizePatch(updates)),
  );
}

export async function migrateLegacyDesktopSettings(input: {
  manageBuiltInDaemon?: boolean;
  releaseChannel?: ReleaseChannel;
}): Promise<void> {
  if (!getIsElectron()) {
    return;
  }
  await invokeDesktopCommand("migrate_legacy_desktop_settings", input);
}

function parseDesktopSettings(raw: unknown): DesktopSettings {
  const record = isRecord(raw) ? raw : {};
  const notifications = isRecord(record.notifications) ? record.notifications : {};
  const daemon = isRecord(record.daemon) ? record.daemon : {};

  return {
    releaseChannel: record.releaseChannel === "beta" ? "beta" : "stable",
    notifications: {
      playSound:
        typeof notifications.playSound === "boolean"
          ? notifications.playSound
          : DEFAULT_DESKTOP_SETTINGS.notifications.playSound,
    },
    daemon: {
      manageBuiltInDaemon:
        typeof daemon.manageBuiltInDaemon === "boolean"
          ? daemon.manageBuiltInDaemon
          : DEFAULT_DESKTOP_SETTINGS.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit:
        typeof daemon.keepRunningAfterQuit === "boolean"
          ? daemon.keepRunningAfterQuit
          : DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit,
    },
    preventSleep:
      record.preventSleep === "on" || record.preventSleep === "display"
        ? record.preventSleep
        : "off",
    launchAtLogin:
      typeof record.launchAtLogin === "boolean"
        ? record.launchAtLogin
        : DEFAULT_DESKTOP_SETTINGS.launchAtLogin,
    dockVisible:
      typeof record.dockVisible === "boolean"
        ? record.dockVisible
        : DEFAULT_DESKTOP_SETTINGS.dockVisible,
    confirmQuit:
      typeof record.confirmQuit === "boolean"
        ? record.confirmQuit
        : DEFAULT_DESKTOP_SETTINGS.confirmQuit,
    autoCheckUpdates:
      typeof record.autoCheckUpdates === "boolean"
        ? record.autoCheckUpdates
        : DEFAULT_DESKTOP_SETTINGS.autoCheckUpdates,
    updateCheckMinutes: parseUpdateCheckMinutes(record.updateCheckMinutes),
    autoDownloadUpdates:
      typeof record.autoDownloadUpdates === "boolean"
        ? record.autoDownloadUpdates
        : DEFAULT_DESKTOP_SETTINGS.autoDownloadUpdates,
    autoRestartOnUpdate:
      typeof record.autoRestartOnUpdate === "boolean"
        ? record.autoRestartOnUpdate
        : DEFAULT_DESKTOP_SETTINGS.autoRestartOnUpdate,
    updateMirror: typeof record.updateMirror === "string" ? record.updateMirror : "",
    tray: record.tray === "panel" ? "panel" : "window",
    panelShortcut: typeof record.panelShortcut === "string" ? record.panelShortcut : "",
    trayUsages: parseTrayUsages(record.trayUsages),
    trayUsageEvery: parseTrayEvery(record.trayUsageEvery),
    trayNoLogos: record.trayNoLogos === true,
    trayNoBird: record.trayNoBird === true,
    trayNoNumber: record.trayNoNumber === true,
    trayPace: record.trayPace === true,
    trayNoCost: record.trayNoCost === true,
    trayWindows: parseTrayWindows(record.trayWindows),
    ...parseTrayDisplay(record),
    lightweightMode: record.lightweightMode !== false,
    noUpdatePill: record.noUpdatePill === true,
  };
}

function parseTrayUsages(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
    : [];
}

/** The Usage page's display preferences, mirrored for a tray-only launch. */
function parseTrayDisplay(record: Record<string, unknown>): {
  trayDisplayAs: "used" | "remaining";
  trayCurrency: "usd" | "cny";
  trayNumberUnits: "compact" | "wan";
  trayCnyPerUsd: number;
} {
  return {
    trayDisplayAs: record.trayDisplayAs === "remaining" ? "remaining" : "used",
    trayCurrency: record.trayCurrency === "cny" ? "cny" : "usd",
    trayNumberUnits: record.trayNumberUnits === "wan" ? "wan" : "compact",
    trayCnyPerUsd:
      typeof record.trayCnyPerUsd === "number" && record.trayCnyPerUsd > 0
        ? record.trayCnyPerUsd
        : DEFAULT_DESKTOP_SETTINGS.trayCnyPerUsd,
  };
}

function parseTrayEvery(value: unknown): number {
  return typeof value === "number" && (TRAY_USAGE_EVERIES as readonly number[]).includes(value)
    ? value
    : DEFAULT_DESKTOP_SETTINGS.trayUsageEvery;
}

function parseTrayWindows(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }
  const windows: Record<string, string[]> = {};
  for (const [account, kinds] of Object.entries(value)) {
    if (!Array.isArray(kinds)) continue;
    const ids = kinds.filter((kind): kind is string => typeof kind === "string" && kind !== "");
    if (ids.length > 0) {
      windows[account] = ids;
    }
  }
  return windows;
}

function mergeDesktopSettings(
  current: DesktopSettings,
  updates: DesktopSettingsPatch,
): DesktopSettings {
  const merged: DesktopSettings = {
    ...current,
    notifications: { ...current.notifications, ...updates.notifications },
    daemon: { ...current.daemon, ...updates.daemon },
  };
  const target = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== "notifications" && key !== "daemon") {
      target[key] = value;
    }
  }
  return merged;
}

function parseUpdateCheckMinutes(value: unknown): number {
  return typeof value === "number" && (UPDATE_CHECK_MINUTES as readonly number[]).includes(value)
    ? value
    : DEFAULT_DESKTOP_SETTINGS.updateCheckMinutes;
}

function normalizePatch(updates: DesktopSettingsPatch): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      patch[key] = value;
    }
  }
  return patch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
