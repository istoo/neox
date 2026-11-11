import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AppReleaseChannel } from "../features/auto-updater.js";
import type { TrayClickAction } from "../system/tray.js";

/** Which renderer the desktop shell loads. `native` is the existing RN/Expo app. */
export type DesktopUiMode = "native" | "web";

export interface DesktopSettings {
  /** Graphics switch: the RN desktop app by default, the forked web UI when selected. */
  uiMode: DesktopUiMode;
  releaseChannel: AppReleaseChannel;
  notifications: {
    playSound: boolean;
  };
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  /** `off`, keep the computer awake, or keep its screen awake too. */
  preventSleep: PreventSleepMode;
  /** The new desktop UI's "keep this computer awake while remote access is allowed". */
  keepAwakeEnabled: boolean;
  launchAtLogin: boolean;
  /** macOS only; other platforms ignore it. */
  dockVisible: boolean;
  /** Ask before quitting, as myna's "Ask before quitting" does. */
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
  /** What a tray click does, as myna's Tray: "window" or "panel". */
  tray: TrayClickAction;
  /** Global shortcut that opens the window, as myna's PanelShortcut; "" for none. */
  panelShortcut: string;
  /**
   * The Settings language the renderer last pushed, so a login launch builds
   * the tray menu before any window exists; "" follows the system locale.
   */
  language: string;
  /** Allowance cards (account ids) and totals (`usage:today`, `usage:7d`) beside the tray icon. */
  trayUsages: string[];
  /** Minutes between menu-bar allowance refreshes; myna's 3 unless told. */
  trayUsageEvery: number;
  /** Leave each subscription's logo out of the menu bar (macOS). */
  trayNoLogos: boolean;
  /** Leave Neolix's icon out of the menu bar, the allowances alone (macOS). */
  trayNoBird: boolean;
  /** Keep Neolix's icon instead of the first allowance's figure (Windows). */
  trayNoNumber: boolean;
  /** Show each window's Pace number beside its figure. */
  trayPace: boolean;
  /** Leave what requests cost out of the menu bar's tooltip. */
  trayNoCost: boolean;
  /** Window ids a card's menu-bar rows show, by account id; none shows every window. */
  trayWindows: Record<string, string[]>;
  /**
   * How the renderer reads percents (usage.preferences.displayAs), mirrored so
   * a tray-only launch shows what the reader last chose.
   */
  trayDisplayAs: "used" | "remaining";
  /** The Usage page's currency and number units, mirrored for the same reason. */
  trayCurrency: "usd" | "cny";
  trayNumberUnits: "compact" | "wan";
  /** The last dollar-to-yuan rate the renderer saw; myna's fixed one before it. */
  trayCnyPerUsd: number;
  /** myna's Lightweight mode: a closed window frees its memory; off keeps it hidden. */
  lightweightMode: boolean;
  /** myna's Update button: the header's update callout when one is out. */
  noUpdatePill: boolean;
  /** Appearance › App icon: which assets/app-icons variant the Dock and windows show. */
  appIcon: DesktopAppIconName;
}

export const DESKTOP_APP_ICON_NAMES = ["default", "icon", "dark", "beta"] as const;
export type DesktopAppIconName = (typeof DESKTOP_APP_ICON_NAMES)[number];

export type PreventSleepMode = "off" | "on" | "display";

interface DesktopSettingsPatch {
  uiMode?: DesktopUiMode;
  releaseChannel?: AppReleaseChannel;
  notifications?: Partial<DesktopSettings["notifications"]>;
  daemon?: Partial<DesktopSettings["daemon"]>;
  preventSleep?: PreventSleepMode;
  keepAwakeEnabled?: boolean;
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
  language?: string;
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
  appIcon?: DesktopAppIconName;
}

export interface DesktopSettingsStore {
  get(): Promise<DesktopSettings>;
  patch(patch: unknown): Promise<DesktopSettings>;
  migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  uiMode: "web",
  releaseChannel: "stable",
  notifications: {
    playSound: true,
  },
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  preventSleep: "off",
  keepAwakeEnabled: false,
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
  language: "",
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
  appIcon: "default",
};

/** myna's TRAY_EVERY: the minutes Settings offers between menu-bar reads. */
export const TRAY_USAGE_EVERIES = [1, 3, 5, 10, 30] as const;

/** myna's UpdateEveries, in minutes. */
export const UPDATE_CHECK_MINUTES = [30, 60, 360, 1440] as const;

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

const ReleaseChannelSchema = z.enum(["stable", "beta"]);
const UiModeSchema = z.enum(["native", "web"]);

const NotificationsSchema = z
  .looseObject({
    playSound: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.notifications.playSound),
  })
  .catch(() => ({ ...DEFAULT_DESKTOP_SETTINGS.notifications }));

const DaemonSchema = z
  .looseObject({
    manageBuiltInDaemon: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.daemon.manageBuiltInDaemon),
    keepRunningAfterQuit: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit),
  })
  .catch(() => ({ ...DEFAULT_DESKTOP_SETTINGS.daemon }));

const PreventSleepSchema = z
  .enum(["off", "on", "display"])
  .catch(DEFAULT_DESKTOP_SETTINGS.preventSleep);

const DesktopSettingsSchema = z
  .looseObject({
    uiMode: UiModeSchema.catch(DEFAULT_DESKTOP_SETTINGS.uiMode),
    releaseChannel: ReleaseChannelSchema.catch(DEFAULT_DESKTOP_SETTINGS.releaseChannel),
    notifications: NotificationsSchema,
    daemon: DaemonSchema,
    preventSleep: PreventSleepSchema,
    keepAwakeEnabled: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.keepAwakeEnabled),
    launchAtLogin: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.launchAtLogin),
    dockVisible: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.dockVisible),
    confirmQuit: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.confirmQuit),
    autoCheckUpdates: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.autoCheckUpdates),
    updateCheckMinutes: z
      .number()
      .refine((value) => (UPDATE_CHECK_MINUTES as readonly number[]).includes(value))
      .catch(DEFAULT_DESKTOP_SETTINGS.updateCheckMinutes),
    autoDownloadUpdates: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.autoDownloadUpdates),
    autoRestartOnUpdate: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.autoRestartOnUpdate),
    updateMirror: z.string().catch(DEFAULT_DESKTOP_SETTINGS.updateMirror),
    tray: z.enum(["window", "panel"]).catch(DEFAULT_DESKTOP_SETTINGS.tray),
    panelShortcut: z.string().catch(DEFAULT_DESKTOP_SETTINGS.panelShortcut),
    language: z.string().catch(DEFAULT_DESKTOP_SETTINGS.language),
    trayUsages: z.array(z.string()).catch([]),
    trayUsageEvery: z
      .number()
      .refine((value) => (TRAY_USAGE_EVERIES as readonly number[]).includes(value))
      .catch(DEFAULT_DESKTOP_SETTINGS.trayUsageEvery),
    trayNoLogos: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.trayNoLogos),
    trayNoBird: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.trayNoBird),
    trayNoNumber: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.trayNoNumber),
    trayPace: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.trayPace),
    trayNoCost: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.trayNoCost),
    trayWindows: z.record(z.string(), z.array(z.string())).catch({}),
    trayDisplayAs: z.enum(["used", "remaining"]).catch(DEFAULT_DESKTOP_SETTINGS.trayDisplayAs),
    trayCurrency: z.enum(["usd", "cny"]).catch(DEFAULT_DESKTOP_SETTINGS.trayCurrency),
    trayNumberUnits: z.enum(["compact", "wan"]).catch(DEFAULT_DESKTOP_SETTINGS.trayNumberUnits),
    trayCnyPerUsd: z.number().positive().catch(DEFAULT_DESKTOP_SETTINGS.trayCnyPerUsd),
    lightweightMode: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.lightweightMode),
    noUpdatePill: z.boolean().catch(DEFAULT_DESKTOP_SETTINGS.noUpdatePill),
    appIcon: z.enum(DESKTOP_APP_ICON_NAMES).catch(DEFAULT_DESKTOP_SETTINGS.appIcon),
  })
  .catch(() => buildDefaultSettings());

const MigrationsSchema = z
  .looseObject({
    legacyRendererSettingsImported: z.boolean().catch(false),
    daemonStopOnQuitDefaultApplied: z.boolean().catch(false),
    webRendererDefaultApplied: z.boolean().catch(false),
  })
  .catch(() => ({
    legacyRendererSettingsImported: false,
    daemonStopOnQuitDefaultApplied: false,
    webRendererDefaultApplied: false,
  }));

const PersistedDocumentSchema = z
  .looseObject({
    version: z.literal(1).catch(1),
    settings: DesktopSettingsSchema,
    migrations: MigrationsSchema,
  })
  .catch(() => buildDefaultDocument());

type StoredDesktopSettings = z.output<typeof DesktopSettingsSchema>;
type PersistedDesktopSettingsDocument = z.output<typeof PersistedDocumentSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceReleaseChannel(value: unknown): AppReleaseChannel | null {
  const result = ReleaseChannelSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceUiMode(value: unknown): DesktopUiMode | null {
  const result = UiModeSchema.safeParse(value);
  return result.success ? result.data : null;
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function buildDefaultSettings(): StoredDesktopSettings {
  return {
    uiMode: DEFAULT_DESKTOP_SETTINGS.uiMode,
    releaseChannel: DEFAULT_DESKTOP_SETTINGS.releaseChannel,
    notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications },
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
    preventSleep: DEFAULT_DESKTOP_SETTINGS.preventSleep,
    keepAwakeEnabled: DEFAULT_DESKTOP_SETTINGS.keepAwakeEnabled,
    launchAtLogin: DEFAULT_DESKTOP_SETTINGS.launchAtLogin,
    dockVisible: DEFAULT_DESKTOP_SETTINGS.dockVisible,
    confirmQuit: DEFAULT_DESKTOP_SETTINGS.confirmQuit,
    autoCheckUpdates: DEFAULT_DESKTOP_SETTINGS.autoCheckUpdates,
    updateCheckMinutes: DEFAULT_DESKTOP_SETTINGS.updateCheckMinutes,
    autoDownloadUpdates: DEFAULT_DESKTOP_SETTINGS.autoDownloadUpdates,
    autoRestartOnUpdate: DEFAULT_DESKTOP_SETTINGS.autoRestartOnUpdate,
    updateMirror: DEFAULT_DESKTOP_SETTINGS.updateMirror,
    tray: DEFAULT_DESKTOP_SETTINGS.tray,
    panelShortcut: DEFAULT_DESKTOP_SETTINGS.panelShortcut,
    language: DEFAULT_DESKTOP_SETTINGS.language,
    trayUsages: [...DEFAULT_DESKTOP_SETTINGS.trayUsages],
    trayUsageEvery: DEFAULT_DESKTOP_SETTINGS.trayUsageEvery,
    trayNoLogos: DEFAULT_DESKTOP_SETTINGS.trayNoLogos,
    trayNoBird: DEFAULT_DESKTOP_SETTINGS.trayNoBird,
    trayNoNumber: DEFAULT_DESKTOP_SETTINGS.trayNoNumber,
    trayPace: DEFAULT_DESKTOP_SETTINGS.trayPace,
    trayNoCost: DEFAULT_DESKTOP_SETTINGS.trayNoCost,
    trayWindows: {},
    trayDisplayAs: DEFAULT_DESKTOP_SETTINGS.trayDisplayAs,
    trayCurrency: DEFAULT_DESKTOP_SETTINGS.trayCurrency,
    trayNumberUnits: DEFAULT_DESKTOP_SETTINGS.trayNumberUnits,
    trayCnyPerUsd: DEFAULT_DESKTOP_SETTINGS.trayCnyPerUsd,
    lightweightMode: DEFAULT_DESKTOP_SETTINGS.lightweightMode,
    noUpdatePill: DEFAULT_DESKTOP_SETTINGS.noUpdatePill,
    appIcon: DEFAULT_DESKTOP_SETTINGS.appIcon,
  };
}

function buildDefaultDocument(): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: buildDefaultSettings(),
    migrations: {
      legacyRendererSettingsImported: false,
      daemonStopOnQuitDefaultApplied: true,
      webRendererDefaultApplied: true,
    },
  };
}

function toDesktopSettings(stored: StoredDesktopSettings): DesktopSettings {
  return {
    uiMode: stored.uiMode,
    releaseChannel: stored.releaseChannel,
    notifications: { playSound: stored.notifications.playSound },
    daemon: {
      manageBuiltInDaemon: stored.daemon.manageBuiltInDaemon,
      keepRunningAfterQuit: stored.daemon.keepRunningAfterQuit,
    },
    preventSleep: stored.preventSleep,
    keepAwakeEnabled: stored.keepAwakeEnabled,
    launchAtLogin: stored.launchAtLogin,
    dockVisible: stored.dockVisible,
    confirmQuit: stored.confirmQuit,
    autoCheckUpdates: stored.autoCheckUpdates,
    updateCheckMinutes: stored.updateCheckMinutes,
    autoDownloadUpdates: stored.autoDownloadUpdates,
    autoRestartOnUpdate: stored.autoRestartOnUpdate,
    updateMirror: stored.updateMirror,
    tray: stored.tray,
    panelShortcut: stored.panelShortcut,
    language: stored.language,
    trayUsages: [...stored.trayUsages],
    trayUsageEvery: stored.trayUsageEvery,
    trayNoLogos: stored.trayNoLogos,
    trayNoBird: stored.trayNoBird,
    trayNoNumber: stored.trayNoNumber,
    trayPace: stored.trayPace,
    trayNoCost: stored.trayNoCost,
    trayWindows: Object.fromEntries(
      Object.entries(stored.trayWindows).map(([account, windows]) => [account, [...windows]]),
    ),
    trayDisplayAs: stored.trayDisplayAs,
    trayCurrency: stored.trayCurrency,
    trayNumberUnits: stored.trayNumberUnits,
    trayCnyPerUsd: stored.trayCnyPerUsd,
    lightweightMode: stored.lightweightMode,
    noUpdatePill: stored.noUpdatePill,
    appIcon: stored.appIcon,
  };
}

function coerceDesktopSettingsPatch(input: unknown): DesktopSettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const uiMode = coerceUiMode(input.uiMode);
  if (uiMode) {
    patch.uiMode = uiMode;
  }
  const releaseChannel = coerceReleaseChannel(input.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  if (isRecord(input.notifications)) {
    const playSound = coerceBoolean(input.notifications.playSound);
    if (playSound !== null) {
      patch.notifications = { playSound };
    }
  }

  if (isRecord(input.daemon)) {
    const daemonPatch: Partial<DesktopSettings["daemon"]> = {};
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      daemonPatch.manageBuiltInDaemon = manageBuiltInDaemon;
    }
    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      daemonPatch.keepRunningAfterQuit = keepRunningAfterQuit;
    }
    if (Object.keys(daemonPatch).length > 0) {
      patch.daemon = daemonPatch;
    }
  }

  const preventSleep = input.preventSleep;
  if (preventSleep === "off" || preventSleep === "on" || preventSleep === "display") {
    patch.preventSleep = preventSleep;
  }

  const keepAwakeEnabled = coerceBoolean(input.keepAwakeEnabled);
  if (keepAwakeEnabled !== null) {
    patch.keepAwakeEnabled = keepAwakeEnabled;
  }

  const launchAtLogin = coerceBoolean(input.launchAtLogin);
  if (launchAtLogin !== null) {
    patch.launchAtLogin = launchAtLogin;
  }

  const dockVisible = coerceBoolean(input.dockVisible);
  if (dockVisible !== null) {
    patch.dockVisible = dockVisible;
  }

  const confirmQuit = coerceBoolean(input.confirmQuit);
  if (confirmQuit !== null) {
    patch.confirmQuit = confirmQuit;
  }

  return { ...patch, ...coerceUpdatePatch(input) };
}

/** The update rows, apart so the patch coercion stays readable. */
function coerceUpdatePatch(input: Record<string, unknown>): DesktopSettingsPatch {
  const patch: DesktopSettingsPatch = {};
  const autoCheckUpdates = coerceBoolean(input.autoCheckUpdates);
  if (autoCheckUpdates !== null) {
    patch.autoCheckUpdates = autoCheckUpdates;
  }
  const updateCheckMinutes = input.updateCheckMinutes;
  if (
    typeof updateCheckMinutes === "number" &&
    (UPDATE_CHECK_MINUTES as readonly number[]).includes(updateCheckMinutes)
  ) {
    patch.updateCheckMinutes = updateCheckMinutes;
  }
  const autoDownloadUpdates = coerceBoolean(input.autoDownloadUpdates);
  if (autoDownloadUpdates !== null) {
    patch.autoDownloadUpdates = autoDownloadUpdates;
  }
  const autoRestartOnUpdate = coerceBoolean(input.autoRestartOnUpdate);
  if (autoRestartOnUpdate !== null) {
    patch.autoRestartOnUpdate = autoRestartOnUpdate;
  }
  if (typeof input.updateMirror === "string") {
    patch.updateMirror = input.updateMirror.trim();
  }
  if (input.tray === "window" || input.tray === "panel") {
    patch.tray = input.tray;
  }
  if (typeof input.panelShortcut === "string") {
    patch.panelShortcut = input.panelShortcut.trim();
  }
  if (typeof input.language === "string") {
    patch.language = input.language.trim();
  }
  if (Array.isArray(input.trayUsages)) {
    patch.trayUsages = normalizeTrayUsages(input.trayUsages);
  }
  if (
    typeof input.trayUsageEvery === "number" &&
    (TRAY_USAGE_EVERIES as readonly number[]).includes(input.trayUsageEvery)
  ) {
    patch.trayUsageEvery = input.trayUsageEvery;
  }
  for (const key of [
    "trayNoLogos",
    "trayNoBird",
    "trayNoNumber",
    "trayPace",
    "trayNoCost",
    "lightweightMode",
    "noUpdatePill",
  ] as const) {
    const value = coerceBoolean(input[key]);
    if (value !== null) {
      patch[key] = value;
    }
  }
  if (isRecord(input.trayWindows)) {
    patch.trayWindows = normalizeTrayWindows(input.trayWindows);
  }
  return { ...patch, ...coerceTrayDisplayPatch(input) };
}

/** The renderer's Usage display preferences, mirrored for tray-only launches. */
function coerceTrayDisplayPatch(input: Record<string, unknown>): DesktopSettingsPatch {
  const patch: DesktopSettingsPatch = {};
  if (input.trayDisplayAs === "used" || input.trayDisplayAs === "remaining") {
    patch.trayDisplayAs = input.trayDisplayAs;
  }
  if (input.trayCurrency === "usd" || input.trayCurrency === "cny") {
    patch.trayCurrency = input.trayCurrency;
  }
  if (input.trayNumberUnits === "compact" || input.trayNumberUnits === "wan") {
    patch.trayNumberUnits = input.trayNumberUnits;
  }
  if ((DESKTOP_APP_ICON_NAMES as readonly unknown[]).includes(input.appIcon)) {
    patch.appIcon = input.appIcon as DesktopAppIconName;
  }
  if (
    typeof input.trayCnyPerUsd === "number" &&
    Number.isFinite(input.trayCnyPerUsd) &&
    input.trayCnyPerUsd > 0
  ) {
    patch.trayCnyPerUsd = input.trayCnyPerUsd;
  }
  return patch;
}

/** myna drops blanks and repeats, keeping the order the reader picked. */
function normalizeTrayUsages(value: unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeTrayWindows(value: Record<string, unknown>): Record<string, string[]> {
  const windows: Record<string, string[]> = {};
  for (const [account, kinds] of Object.entries(value)) {
    if (!Array.isArray(kinds)) continue;
    const ids = kinds.filter((kind): kind is string => typeof kind === "string" && kind !== "");
    if (ids.length > 0) {
      windows[account] = [...new Set(ids)];
    }
  }
  return windows;
}

function pickDesktopSettingsFromLegacyRendererSettings(
  legacySettings: unknown,
): DesktopSettingsPatch {
  if (!isRecord(legacySettings)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const releaseChannel = coerceReleaseChannel(legacySettings.releaseChannel);
  if (releaseChannel) {
    patch.releaseChannel = releaseChannel;
  }

  const manageBuiltInDaemon = coerceBoolean(legacySettings.manageBuiltInDaemon);
  if (manageBuiltInDaemon !== null) {
    patch.daemon = { manageBuiltInDaemon };
  }

  return patch;
}

function mergeDesktopSettings(
  current: StoredDesktopSettings,
  patch: DesktopSettingsPatch,
): StoredDesktopSettings {
  const merged: StoredDesktopSettings = {
    ...current,
    notifications: { ...current.notifications, ...patch.notifications },
    daemon: { ...current.daemon, ...patch.daemon },
  };
  // Every other field is replaced whole when the patch names it; nested ones
  // were merged above.
  const target = merged as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && key !== "notifications" && key !== "daemon") {
      target[key] = value;
    }
  }
  return merged;
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.releaseChannel !== undefined || patch.daemon?.manageBuiltInDaemon !== undefined;
}

function coerceDocument(input: unknown): PersistedDesktopSettingsDocument {
  return applyWebRendererDefault(
    applyDaemonStopOnQuitDefault(PersistedDocumentSchema.parse(input)),
  );
}

function applyDaemonStopOnQuitDefault(
  document: PersistedDesktopSettingsDocument,
): PersistedDesktopSettingsDocument {
  if (document.migrations.daemonStopOnQuitDefaultApplied) {
    return document;
  }

  return {
    ...document,
    settings: {
      ...document.settings,
      daemon: {
        ...document.settings.daemon,
        keepRunningAfterQuit: DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit,
      },
    },
    migrations: { ...document.migrations, daemonStopOnQuitDefaultApplied: true },
  };
}

/**
 * The web renderer became the default. A saved "native" cannot tell an explicit choice from the
 * old default that was written on first launch, so every profile moves to "web" once; the menu's
 * native option stays as the way back, and that choice then sticks.
 * COMPAT(webRendererDefault): added in v0.16.0, remove after 2027-05-09 together with the native
 * renderer option.
 */
function applyWebRendererDefault(
  document: PersistedDesktopSettingsDocument,
): PersistedDesktopSettingsDocument {
  if (document.migrations.webRendererDefaultApplied) {
    return document;
  }
  return {
    ...document,
    settings: { ...document.settings, uiMode: "web" },
    migrations: { ...document.migrations, webRendererDefaultApplied: true },
  };
}

export function createDesktopSettingsStore({
  userDataPath,
}: {
  userDataPath: string;
}): DesktopSettingsStore {
  const filePath = path.join(userDataPath, DESKTOP_SETTINGS_FILENAME);
  let cachedDocument: PersistedDesktopSettingsDocument | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persistDocument(document: PersistedDesktopSettingsDocument): Promise<void> {
    const write = async () => {
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
      cachedDocument = document;
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  async function loadDocument(): Promise<PersistedDesktopSettingsDocument> {
    if (cachedDocument) {
      return cachedDocument;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
    const document = coerceDocument(JSON.parse(raw));
    cachedDocument = document;
    return document;
  }

  async function initializeLegacyRendererMigration(): Promise<PersistedDesktopSettingsDocument> {
    try {
      return await loadDocument();
    } catch {
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
  }

  return {
    async get(): Promise<DesktopSettings> {
      const document = await loadDocument();
      return toDesktopSettings(document.settings);
    },

    async patch(patch: unknown): Promise<DesktopSettings> {
      const current = await loadDocument();
      const coercedPatch = coerceDesktopSettingsPatch(patch);
      const next = mergeDesktopSettings(current.settings, coercedPatch);
      await persistDocument({
        ...current,
        settings: next,
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported:
            current.migrations.legacyRendererSettingsImported ||
            hasLegacyRendererOwnedPatch(coercedPatch),
        },
      });
      return toDesktopSettings(next);
    },

    async migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      const current = await initializeLegacyRendererMigration();
      if (current.migrations.legacyRendererSettingsImported) {
        return toDesktopSettings(current.settings);
      }

      const next = mergeDesktopSettings(
        current.settings,
        pickDesktopSettingsFromLegacyRendererSettings(legacySettings),
      );
      await persistDocument({
        ...current,
        settings: next,
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported: true,
        },
      });
      return toDesktopSettings(next);
    },
  };
}
