import { readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import {
  resolveNeolixHome,
  startDaemonInstance,
  DaemonInstanceError,
  stopDaemonInstance,
  readDaemonInstance,
  isSameDaemonInstance,
  readLocalCredentialForTarget,
  type DaemonInstance,
} from "@neolix/server/daemon-control";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import {
  getBundledCliShimPath,
  getCliInstallStatus,
  installCli,
  uninstallCli,
} from "../integrations/cli-install/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import {
  ExternalCliCommandError,
  runExternalCliJsonCommand,
  runExternalCliTextCommand,
  spawnDetachedExternalCli,
} from "./cli/external.js";
import { resolveExternalCliEntrypoint } from "./cli/entrypoints.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import {
  applySystemPreferences,
  disableAutostartForUninstall,
  reportAgentActivity,
} from "../system/preferences.js";
import {
  applyTraySettings,
  refreshTrayUsage,
  setTrayLanguage,
  setTrayUsage,
} from "../system/tray-manager.js";
import { listSystemFonts } from "../system/fonts.js";
import { daemonWebSocketTarget, type TrayUsageDaemonTarget } from "../system/tray-usage-poller.js";
import {
  addOmarchyWidget,
  isOmarchy,
  isOmarchyWidgetInstalled,
  removeOmarchyWidget,
} from "../system/omarchy-widget.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { describeSandbox } from "../diagnostics/sandbox.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { getDesktopUpdaterDiagnostics } from "../diagnostics/updater.js";
import {
  deleteLegacySkillSelection,
  readLegacySkillSelection,
} from "../integrations/legacy-skill-selection.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
let ownedLaunch: { home: string; instance: DaemonInstance } | null = null;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  ownedByDesktop: boolean;
  startedAt: string | null;
  error: string | null;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getNeolixHome(): string {
  return resolveNeolixHome(process.env);
}

/** The desktop-managed daemon's state directory, for sidecars that read its credential. */
export function resolveDesktopNeolixHome(): string {
  return getNeolixHome();
}

function logFilePath(): string {
  return path.join(getNeolixHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  if (!ownedLaunch) return false;
  try {
    const lock = JSON.parse(readFileSync(path.join(ownedLaunch.home, "neolix.pid"), "utf8"));
    return isSameDaemonInstance(lock, ownedLaunch.instance) && isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await stopDesktopDaemon(reason);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function statusFromDaemonProbe(
  payload: Record<string, unknown>,
  home: string,
): DesktopDaemonStatus {
  const local = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
  const processAlive = local === "running" || local === "not_ready";
  let status: DesktopDaemonState = "stopped";
  if (local === "not_ready") status = "starting";
  if (local === "running") status = "running";
  return {
    serverId: typeof payload.serverId === "string" ? payload.serverId : "",
    status,
    listen: typeof payload.listen === "string" ? payload.listen : null,
    hostname:
      status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
    pid: processAlive && typeof payload.pid === "number" ? payload.pid : null,
    home,
    version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
    desktopManaged: payload.desktopManaged === true,
    startedAt: typeof payload.startedAt === "string" ? payload.startedAt : null,
    ownedByDesktop: Boolean(
      ownedLaunch &&
      ownedLaunch.home === home &&
      payload.pid === ownedLaunch.instance.pid &&
      payload.startedAt === ownedLaunch.instance.startedAt,
    ),
    error: null,
  };
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getNeolixHome();

  try {
    // The app polls this while no local daemon runs. Answer that case in-process,
    // since launching the CLI once per poll keeps spawning processes while idle.
    if (!(await readDaemonInstance(home))) {
      return statusFromDaemonProbe({ localDaemon: "stopped" }, home);
    }

    const payload = (await runExternalCliJsonCommand([
      "daemon",
      "status",
      "--home",
      home,
      "--json",
    ])) as Record<string, unknown>;
    return statusFromDaemonProbe(payload, home);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus failed", { error: errorMessage });
    return {
      serverId: "",
      status: "errored",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      ownedByDesktop: false,
      startedAt: null,
      error: errorMessage,
    };
  }
}

/**
 * Where the menu-bar poller connects: the local daemon's listen address and,
 * for a desktop-managed one, its credential. Null while no daemon runs.
 */
export async function resolveTrayUsageTarget(): Promise<TrayUsageDaemonTarget | null> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running" || status.listen === null) {
    return null;
  }
  const target = daemonWebSocketTarget(status.listen);
  if (target === null) {
    return null;
  }
  const instance = await readDaemonInstance(getNeolixHome());
  return {
    ...target,
    credential: instance?.desktopManaged
      ? readLocalCredentialForTarget(getNeolixHome(), status.listen)
      : null,
  };
}

/** A login launch opens no window; start the daemon the app manages itself. */
export async function startDesktopDaemonFromTray(): Promise<void> {
  const settings = await getDesktopSettingsStore().get();
  if (!settings.daemon.manageBuiltInDaemon) {
    return;
  }
  await startDaemon();
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  if (!current.ownedByDesktop) return false;
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running" || current.status === "starting") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveDesktopAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else {
      return current;
    }
  }

  const home = getNeolixHome();
  const invocation = createNodeEntrypointInvocation({
    entrypoint: resolveDaemonRunnerEntrypoint(),
    argvMode: "node-script",
    args: [],
    baseEnv: process.env,
  });
  try {
    await startDaemonInstance({
      home,
      timeoutMs: 30_000,
      ...invocation,
      env: { ...invocation.env, NEOLIX_CLI: getBundledCliShimPath() },
      mode: "managed",
      desktopManaged: true,
      onAcquired: (instance) => {
        ownedLaunch = { home, instance };
      },
    });
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) throw error;
  }
  return resolveDesktopDaemonStatus();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
  confirmedInstance?: { pid: number; startedAt: string },
): Promise<DesktopDaemonStatus> {
  const home = getNeolixHome();
  const instance = await readDaemonInstance(home);
  const owned = Boolean(
    instance &&
    ownedLaunch &&
    ownedLaunch.home === home &&
    isSameDaemonInstance(instance, ownedLaunch.instance),
  );
  const explicit =
    reason === "manual_ipc" &&
    confirmedInstance &&
    instance &&
    instance.pid === confirmedInstance.pid &&
    instance.startedAt === confirmedInstance.startedAt;
  if (confirmedInstance && !explicit)
    throw new Error(
      "Daemon changed since confirmation; inspect its current home and PID before stopping it.",
    );
  if (!instance || (!owned && !explicit)) return resolveDesktopDaemonStatus();
  const keepTerminals = keepsTerminalsOnStop(reason, process.platform);
  logDesktopDaemonLifecycle("stopping captured supervisor", {
    reason,
    pid: instance.pid,
    owned,
    keepTerminals,
  });
  await stopCapturedDaemon({ home, instance, reason, keepTerminals });
  if (owned) ownedLaunch = null;
  return resolveDesktopDaemonStatus();
}

export interface StopCapturedDaemonInput {
  home: string;
  instance: DaemonInstance;
  reason: DesktopDaemonStopReason;
  keepTerminals: boolean;
  stopInstance?: typeof stopDaemonInstance;
  runCliJson?: typeof runExternalCliJsonCommand;
  log?: typeof logDesktopDaemonLifecycle;
}

/** Stops the supervisor desktop captured, keeping its terminals when asked and supported. */
export async function stopCapturedDaemon(input: StopCapturedDaemonInput): Promise<void> {
  const stopInstance = input.stopInstance ?? stopDaemonInstance;
  const runCliJson = input.runCliJson ?? runExternalCliJsonCommand;
  const logLifecycle = input.log ?? logDesktopDaemonLifecycle;
  const stop = (keep: boolean) =>
    stopInstance(input.home, {
      instance: input.instance,
      timeoutMs: 15_000,
      keepTerminals: keep,
      requestShutdown: async (ready) => {
        await runCliJson([
          "daemon",
          "stop",
          "--host",
          ready.listen,
          ...(keep ? ["--keep-terminals"] : []),
          "--json",
        ]);
      },
    });
  try {
    await stop(input.keepTerminals);
  } catch (error) {
    // The CLI refuses a keep stop before sending anything when the daemon predates the feature;
    // that daemon closes terminals on every stop, as every upgrade did before.
    if (
      !input.keepTerminals ||
      !(error instanceof ExternalCliCommandError) ||
      error.code !== "TERMINALS_KEEP_UNSUPPORTED"
    ) {
      throw error;
    }
    const version = typeof error.error?.version === "string" ? error.error.version : "unknown";
    logLifecycle(`daemon v${version} cannot keep terminals; stopping it and closing them`, {
      reason: input.reason,
      pid: input.instance.pid,
    });
    await stop(false);
  }
}

/**
 * Whether a desktop stop keeps the daemon's terminals running for the daemon that replaces it.
 * Only when one comes straight back (an app update, a version-mismatch restart), and never on
 * Windows: a surviving terminal worker runs Neolix.exe and would lock the install folder the
 * update replaces. Quit, Settings, host removal and manual stops close terminals.
 */
export function keepsTerminalsOnStop(
  reason: DesktopDaemonStopReason,
  platform: NodeJS.Platform,
): boolean {
  if (platform === "win32") return false;
  return reason === "app_update" || reason === "version_mismatch";
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await runExternalCliJsonCommand(["daemon", "restart", "--home", getNeolixHome(), "--json"]);
  return resolveDesktopDaemonStatus();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status", "--home", getNeolixHome()]);
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  const settingsHandlers = createDesktopSettingsCommandHandlers({
    settingsStore: getDesktopSettingsStore(),
  });
  const patchDesktopSettings = settingsHandlers.patch_desktop_settings;
  settingsHandlers.patch_desktop_settings = async (args) => {
    const settings = (await patchDesktopSettings(args)) as DesktopSettings;
    applySystemPreferences(settings);
    applyTraySettings(settings);
    refreshTrayUsage();
    return settings;
  };
  return {
    ...settingsHandlers,
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    desktop_local_credential: async (args) => {
      const instance = await readDaemonInstance(getNeolixHome());
      if (!instance?.desktopManaged || typeof args?.listen !== "string") return null;
      return readLocalCredentialForTarget(getNeolixHome(), args.listen);
    },
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) =>
      stopDesktopDaemon(
        parseDesktopDaemonStopReason(args),
        typeof args?.pid === "number" && typeof args.startedAt === "string"
          ? { pid: args.pid, startedAt: args.startedAt }
          : undefined,
      ),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_sandbox_diagnostics: () =>
      describeSandbox({
        disabled: app.commandLine.hasSwitch("no-sandbox"),
        launcherReason: process.env.NEOLIX_DESKTOP_SANDBOX_REASON,
      }),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_update_diagnostics: () => getDesktopUpdaterDiagnostics(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    // The renderer sees the sessions and the gateway trace; awake.ts decides
    // whether that keeps the computer up (myna awake.go:61 Keep).
    desktop_report_agent_activity: (args) => {
      reportAgentActivity(args?.busy === true);
      return null;
    },
    // myna gui/api.go `/api/fonts`: the appearance page's font list.
    desktop_list_system_fonts: (args) => listSystemFonts({ refresh: args?.refresh === true }),
    // myna omarchy/widget.go: the bar icon, only where Omarchy runs.
    // The renderer knows the Settings language; the tray table lives in this
    // process (myna's trayWords), so only the code crosses.
    desktop_set_tray_language: (args) => {
      if (typeof args?.language === "string") {
        setTrayLanguage(args.language);
        // Keep it on disk: a login launch builds the menu before any renderer
        // exists, so the push alone would not survive the next start.
        void getDesktopSettingsStore()
          .patch({ language: args.language })
          .catch(() => undefined);
      }
      return null;
    },
    // The renderer reads the allowances (it holds the quota RPC); the menu bar
    // text and Windows' number are drawn in this process (myna traynumber.go).
    desktop_set_tray_usage: (args) => {
      if (typeof args?.label === "string" && typeof args?.tooltip === "string") {
        setTrayUsage({
          label: args.label,
          tooltip: args.tooltip,
          // Omitted leaves the mark the main process drew; null clears it.
          ...(typeof args.logoDataUrl === "string" || args.logoDataUrl === null
            ? { logoDataUrl: args.logoDataUrl as string | null }
            : {}),
        });
      }
      return null;
    },
    // The renderer's Usage preferences, kept so a tray-only launch reads the
    // menu bar the same way; the poller picks them up on its next tick.
    desktop_set_tray_display: async (args) => {
      await getDesktopSettingsStore()
        .patch({
          ...(args?.displayAs === "used" || args?.displayAs === "remaining"
            ? { trayDisplayAs: args.displayAs }
            : {}),
          ...(args?.currency === "usd" || args?.currency === "cny"
            ? { trayCurrency: args.currency }
            : {}),
          ...(args?.numberUnits === "compact" || args?.numberUnits === "wan"
            ? { trayNumberUnits: args.numberUnits }
            : {}),
          ...(typeof args?.cnyPerUsd === "number" && args.cnyPerUsd > 0
            ? { trayCnyPerUsd: args.cnyPerUsd }
            : {}),
        })
        .catch(() => undefined);
      refreshTrayUsage();
      return null;
    },
    desktop_omarchy_widget_status: () => ({
      supported: isOmarchy(),
      enabled: isOmarchyWidgetInstalled(),
    }),
    desktop_set_omarchy_widget: async (args) => {
      if (args?.enabled === true) {
        await addOmarchyWidget(process.env.APPIMAGE?.trim() || app.getPath("exe"));
      } else {
        await removeOmarchyWidget();
      }
      return { supported: isOmarchy(), enabled: isOmarchyWidgetInstalled() };
    },
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => await openLocalTransportSession(args),
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
        ...(typeof (args as { autoDownload?: unknown } | null)?.autoDownload === "boolean"
          ? { autoDownload: (args as { autoDownload: boolean }).autoDownload }
          : {}),
        ...(typeof (args as { mirror?: unknown } | null)?.mirror === "string"
          ? { mirror: (args as { mirror: string }).mirror }
          : {}),
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon("app_update");
        },
      );
    },
    // myna's Settings › Uninstall (gui/uninstall.go): agents first, then the
    // system's record, then the files — the app's own folder only after it quits.
    desktop_uninstall: async () => {
      const dataPath = getNeolixHome();
      // The bundled CLI's absolute path, never PATH (the settings could name
      // another neolix). Missing, the user is told what to remove by hand.
      try {
        resolveExternalCliEntrypoint();
      } catch (error) {
        await disableAutostartForUninstall().catch(() => undefined);
        throw new Error(
          `Neox's bundled CLI could not be found: ${
            error instanceof Error ? error.message : String(error)
          }. Opening at login is off now; quit Neox and delete ${dataPath} yourself.`,
          { cause: error },
        );
      }

      try {
        await runExternalCliTextCommand(["uninstall", "--yes", "--keep-data"]);
      } catch (error) {
        // The CLI disconnects what it can before it reports a problem; the
        // desktop still turns the login item off and schedules the rest.
        log.warn("[uninstall] agent disconnect step reported a problem", error);
      }
      await disableAutostartForUninstall();
      try {
        spawnDetachedExternalCli(["uninstall", "--yes", "--data-after", String(process.pid)]);
      } catch (error) {
        throw new Error(
          `Neox could not start its cleanup: ${
            error instanceof Error ? error.message : String(error)
          }. Opening at login is off now; quit Neox, then delete ${dataPath} yourself.`,
          { cause: error },
        );
      }
      setTimeout(() => app.quit(), 200);
      return { scheduled: true };
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    uninstall_cli: () => uninstallCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    read_legacy_skill_selection: () => readLegacySkillSelection(),
    delete_legacy_skill_selection: () => deleteLegacySkillSelection(),
  };
}

export function registerDaemonManager(): void {
  const handlers = createDaemonCommandHandlers();

  ipcMain.handle(
    "neolix:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}
