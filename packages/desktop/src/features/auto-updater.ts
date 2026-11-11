import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, session } from "electron";
import { UUID } from "builder-util-runtime";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import {
  createAppUpdateService,
  MANUAL_INSTALL_MESSAGE,
  type AppUpdateCheckResult,
  type AppUpdateInstallRequest,
  type AppUpdateInstallResult,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service.js";
import { mirroredDownloadUrl } from "./update-mirror.js";
import {
  isReleaseDownloadPackage,
  packagedBy,
  packagedCommand,
  packagedName,
  packagedSentence,
  type Packaged,
} from "./package-manager.js";
import { isPolicyRefusal, noteBlockedUpdate, readBlockedUpdate } from "./update-blocked.js";
import { applyUpdateProxy } from "./update-proxy.js";
import type { UpdatePackageManager } from "./app-update-service.js";
import {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export {
  bucketFromStagingUserId,
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
  type AppUpdateCheckResult,
  type AppUpdateInstallResult,
};

let cachedStagingUserIdPromise: Promise<string> | null = null;

const UPDATE_CHANNEL_NOT_PUBLISHED_CODE = "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";

interface AppUpdateLogSink {
  info(message: string, details: object): void;
}

interface AppUpdateCheckLogDetails {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
}

interface AppUpdateCheckCompletedLogDetails extends AppUpdateCheckLogDetails {
  targetVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  errorMessage: string | null;
}

export function createAppUpdateLifecycleLogger(logger: AppUpdateLogSink) {
  return {
    checkStarted(details: AppUpdateCheckLogDetails): void {
      logger.info("[auto-updater] check started", details);
    },
    checkCompleted(details: AppUpdateCheckCompletedLogDetails): void {
      logger.info("[auto-updater] check completed", details);
    },
    updateAvailable(targetVersion: string): void {
      logger.info("[auto-updater] update available", { targetVersion });
    },
    updateDownloaded(targetVersion: string): void {
      logger.info("[auto-updater] update downloaded", { targetVersion });
    },
    downloadRequested(targetVersion: string): void {
      logger.info("[auto-updater] download requested", { targetVersion });
    },
    quitAndInstallRequested(details: AppUpdateInstallRequest): void {
      logger.info("[auto-updater] quitAndInstall requested", details);
    },
  };
}

const updateLifecycleLog = createAppUpdateLifecycleLogger(log);

function isUpdateChannelNotPublished(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === UPDATE_CHANNEL_NOT_PUBLISHED_CODE
  );
}

export function shouldAdmitToRollout(args: {
  channel: AppReleaseChannel;
  rolloutHours: number | undefined;
  releaseDate: string | undefined;
  now: number;
  bucket: number;
}): boolean {
  return shouldAdmitAppUpdate({ ...args, intent: "automatic" });
}

export async function resolveStagingUserId(filePath: string): Promise<string> {
  try {
    const id = (await readFile(filePath, "utf8")).trim();
    if (UUID.check(id)) {
      return id;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[auto-updater] Couldn't read staging user ID, creating a blank one: ${error}`);
    }
  }

  const id = UUID.v5(randomBytes(4096), UUID.OID);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, id);
  } catch (error) {
    console.warn(`[auto-updater] Couldn't write out staging user ID: ${error}`);
  }

  return id;
}

export function getStagingUserId(): Promise<string> {
  if (cachedStagingUserIdPromise == null) {
    cachedStagingUserIdPromise = resolveStagingUserId(
      path.join(app.getPath("userData"), ".updaterId"),
    );
  }
  return cachedStagingUserIdPromise;
}

export function shouldInstallAppUpdateOnQuit(input: {
  platform: NodeJS.Platform;
  isAppImage: boolean;
}): boolean {
  // AppImage's no-relaunch install path blocks while launching the replacement
  // binary, which can hang after the running file has already been replaced.
  return !(input.platform === "linux" && input.isAppImage);
}

let activeUpdateMirror = "";
let mirrorWatcherInstalled = false;

/**
 * Redirects GitHub release downloads through the mirror, if one is set. The
 * feed itself is not redirected, so the SHA-256 the update is checked
 * against is always GitHub's.
 */
function applyUpdateMirror(mirror: string | undefined): void {
  activeUpdateMirror = mirror ?? "";
  if (mirrorWatcherInstalled) {
    return;
  }
  mirrorWatcherInstalled = true;
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["https://github.com/*", "https://objects.githubusercontent.com/*"] },
    (details, callback) => {
      const redirectURL = mirroredDownloadUrl(activeUpdateMirror, details.url);
      callback(redirectURL === details.url ? {} : { redirectURL });
    },
  );
}

let cachedPackageManager: UpdatePackageManager | null | undefined;
let cachedInstalledPackage: Packaged | null | undefined;

/** The package that installed this binary; an AppImage replaces itself. */
function installedPackage(): Packaged | null {
  if (cachedInstalledPackage === undefined) {
    cachedInstalledPackage = process.env.APPIMAGE ? null : packagedBy(app.getPath("exe"));
  }
  return cachedInstalledPackage;
}

/**
 * myna's PackagedBy (update/packaged.go): a brew/AUR/nix install updates
 * through its manager, not through electron-updater. A .deb or .rpm from the
 * release page has no repository behind it (isReleaseDownloadPackage); it is a
 * manual install instead.
 */
export function detectPackageManager(): UpdatePackageManager | null {
  if (cachedPackageManager !== undefined) {
    return cachedPackageManager;
  }
  const packaged = installedPackage();
  cachedPackageManager =
    packaged && !isReleaseDownloadPackage(packaged)
      ? {
          manager: packaged.manager,
          name: packagedName(packaged),
          package: packaged.package ?? null,
          command: packagedCommand(packaged),
          message: packagedSentence(packaged),
        }
      : null;
  return cachedPackageManager;
}

/**
 * Release pages of the repo electron-builder.yml `publish` points the updater
 * feed at; keep the two in step.
 */
export const RELEASES_PAGE_URL = "https://github.com/istoo/neox/releases";

export function releasePageUrl(version: string | null): string {
  return version ? `${RELEASES_PAGE_URL}/tag/v${version.replace(/^v/i, "")}` : RELEASES_PAGE_URL;
}

/** Whether `codesign -dv` output names a Developer ID signing authority. */
export function isDeveloperIdSignature(codesignOutput: string): boolean {
  return /^Authority=Developer ID Application:/m.test(codesignOutput);
}

let cachedManualInstall: boolean | undefined;

/**
 * Squirrel.Mac only installs an update signed by the same Developer ID as the
 * running app, so an unsigned or ad-hoc signed macOS build can find updates
 * but never apply them. A Linux .deb/.rpm from the release page is updated by
 * installing the next one. Both offer the release page instead.
 */
export function detectManualInstall(): boolean {
  if (cachedManualInstall !== undefined) {
    return cachedManualInstall;
  }
  if (process.platform === "linux") {
    const packaged = installedPackage();
    cachedManualInstall = packaged !== null && isReleaseDownloadPackage(packaged);
    return cachedManualInstall;
  }
  if (process.platform !== "darwin") {
    cachedManualInstall = false;
    return false;
  }
  // .../Neox.app/Contents/MacOS/<exe> → .../Neox.app
  const bundlePath = path.resolve(app.getPath("exe"), "..", "..", "..");
  const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", bundlePath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  cachedManualInstall = !isDeveloperIdSignature(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (cachedManualInstall) {
    log.info("[auto-updater] no Developer ID signature; updates are offered as a download", {
      bundlePath,
    });
  }
  return cachedManualInstall;
}

/** The note for the refused version this check offered, if one was recorded. */
function blockedNoteFor(version: string) {
  const note = readBlockedUpdate(app.getPath("userData"), app.getVersion());
  if (!note || note.version !== version) {
    return null;
  }
  return {
    version: note.version,
    error: note.error,
    policy: note.policy === true,
    at: note.at,
  };
}

class ElectronAppUpdateRuntime implements AppUpdateRuntime {
  private configured = false;

  configure(input: AppUpdateRuntimeConfiguration): void {
    autoUpdater.autoDownload = input.autoDownload ?? true;
    applyUpdateMirror(input.mirror);
    // Downloads take the environment's proxy, else the system's (myna's proxied client).
    void applyUpdateProxy((config) => session.defaultSession.setProxy(config));
    autoUpdater.autoRunAppAfterInstall = true;
    // Neolix revalidates the current manifest before explicitly installing on quit.
    // Electron's built-in handler would install an older download without checking
    // whether a newer release has superseded it.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = input.releaseChannel === "beta";
    autoUpdater.channel = input.releaseChannel === "beta" ? "beta" : "latest";
    autoUpdater.allowDowngrade = false;
    autoUpdater.isUserWithinRollout = async (info) => {
      try {
        return await input.shouldAdmitUpdate(info as RuntimeUpdateInfo);
      } catch {
        return true;
      }
    };

    if (this.configured) return;
    this.configured = true;

    // electron-updater logs every emitted error before consumers can classify it.
    // Neolix reports genuine check, runtime, and install failures through the
    // callbacks below, so leave internal error logging disabled to avoid both
    // duplicate logs and expected missing-channel noise.
    const updaterLogger = autoUpdater.logger;
    autoUpdater.logger = {
      debug: updaterLogger?.debug ? (message) => updaterLogger.debug?.(message) : undefined,
      error: () => undefined,
      info: (message) => updaterLogger?.info(message),
      warn: (message) => updaterLogger?.warn(message),
    };

    autoUpdater.on("update-available", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateAvailable(updateInfo.version);
      input.onUpdateAvailable(updateInfo);
    });
    autoUpdater.on("update-downloaded", (info) => {
      const updateInfo = info as RuntimeUpdateInfo;
      updateLifecycleLog.updateDownloaded(updateInfo.version);
      input.onUpdateDownloaded(updateInfo);
    });
    autoUpdater.on("error", (error) => {
      if (isUpdateChannelNotPublished(error)) return;
      input.onError(error);
    });
  }

  async checkForUpdates(): Promise<RuntimeUpdateCheckResult | null> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return null;
      return {
        isUpdateAvailable: result.isUpdateAvailable,
        updateInfo: result.updateInfo as RuntimeUpdateInfo,
      };
    } catch (error) {
      if (isUpdateChannelNotPublished(error)) return null;
      throw error;
    }
  }

  downloadUpdate(targetVersion: string): Promise<unknown> {
    updateLifecycleLog.downloadRequested(targetVersion);
    return autoUpdater.downloadUpdate();
  }

  quitAndInstall({ targetVersion, isSilent, isForceRunAfter }: AppUpdateInstallRequest): void {
    autoUpdater.autoRunAppAfterInstall = isForceRunAfter;
    updateLifecycleLog.quitAndInstallRequested({
      targetVersion,
      isSilent,
      isForceRunAfter,
    });
    autoUpdater.quitAndInstall(isSilent, isForceRunAfter);
  }
}

const appUpdateService = createAppUpdateService({
  runtime: new ElectronAppUpdateRuntime(),
  isPackaged: () => app.isPackaged,
  now: () => Date.now(),
  bucket: async () => bucketFromStagingUserId(await getStagingUserId()),
  reportCheckError: (error) => {
    console.error("[auto-updater] Failed to check for updates:", error);
  },
  reportRuntimeError: (error) => {
    console.error("[auto-updater] Updater event failed:", error);
  },
  reportInstallError: (message) => {
    console.error("[auto-updater] Failed to download/install update:", message);
  },
  packaged: detectPackageManager,
  manualInstall: detectManualInstall,
  blocked: blockedNoteFor,
  // Only application control refusing the program is myna's "blocked": a
  // download or signature failure says nothing about the version itself.
  noteBlocked: (version, error) => {
    if (isPolicyRefusal(error)) {
      noteBlockedUpdate(app.getPath("userData"), version, error);
    }
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function checkForAppUpdate({
  currentVersion,
  releaseChannel,
  intent,
  autoDownload,
  mirror,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  intent: AppUpdateCheckIntent;
  autoDownload?: boolean;
  mirror?: string;
}): Promise<AppUpdateCheckResult> {
  updateLifecycleLog.checkStarted({ currentVersion, releaseChannel, intent });
  const result = await appUpdateService.checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent,
    ...(autoDownload === undefined ? {} : { autoDownload }),
    ...(mirror === undefined ? {} : { mirror }),
  });
  updateLifecycleLog.checkCompleted({
    currentVersion,
    targetVersion: result.latestVersion,
    releaseChannel,
    intent,
    hasUpdate: result.hasUpdate,
    readyToInstall: result.readyToInstall,
    errorMessage: result.errorMessage,
  });
  return result;
}

export async function downloadAndInstallUpdate(
  {
    currentVersion,
    releaseChannel,
    mirror,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    /** Prefix for GitHub release downloads; absent keeps the current one. */
    mirror?: string;
  },
  onBeforeQuit?: () => Promise<void>,
): Promise<AppUpdateInstallResult> {
  return appUpdateService.downloadAndInstallUpdate(
    {
      currentVersion,
      releaseChannel,
      ...(mirror === undefined ? {} : { mirror }),
    },
    onBeforeQuit,
  );
}

export interface AppUpdateDownloadResult {
  downloaded: boolean;
  version: string | null;
  message: string;
}

const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
let updateDownloadListenerInstalled = false;
const updateDownloadWaiters = new Set<(version: string) => void>();

/**
 * The web desktop UI asks for "download" and "install" separately. The update
 * service owns the download inside electron-updater, so this waits for its
 * `update-downloaded` event instead of starting a second transfer.
 */
function ensureUpdateDownloadListener(): void {
  if (updateDownloadListenerInstalled) {
    return;
  }
  updateDownloadListenerInstalled = true;
  autoUpdater.on("update-downloaded", (info) => {
    const version = (info as RuntimeUpdateInfo).version;
    // Each waiter removes itself, so iterate over a snapshot.
    for (const waiter of Array.from(updateDownloadWaiters)) {
      waiter(version);
    }
  });
}

export async function downloadAppUpdate({
  currentVersion,
  releaseChannel,
  timeoutMs = UPDATE_DOWNLOAD_TIMEOUT_MS,
  mirror,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  timeoutMs?: number;
  /** Prefix for GitHub release downloads; absent keeps the current one. */
  mirror?: string;
}): Promise<AppUpdateDownloadResult> {
  ensureUpdateDownloadListener();
  const result = await checkForAppUpdate({
    currentVersion,
    releaseChannel,
    intent: "manual",
    autoDownload: true,
    ...(mirror === undefined ? {} : { mirror }),
  });
  if (result.errorMessage !== null && !result.hasUpdate) {
    return { downloaded: false, version: null, message: result.errorMessage };
  }
  if (!result.hasUpdate) {
    return { downloaded: false, version: null, message: "Up to date." };
  }
  if (result.manualInstall) {
    // Nothing will download, so don't wait for an update-downloaded event.
    return { downloaded: false, version: null, message: MANUAL_INSTALL_MESSAGE };
  }
  if (result.readyToInstall) {
    return { downloaded: true, version: result.latestVersion, message: "" };
  }

  return new Promise((resolve) => waitForUpdateDownload(timeoutMs, resolve));
}

/** Settles once: on the next `update-downloaded` event, or after `timeoutMs`. */
function waitForUpdateDownload(
  timeoutMs: number,
  settle: (result: AppUpdateDownloadResult) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiter = (version: string | null): void => {
    clearTimeout(timer);
    updateDownloadWaiters.delete(waiter);
    settle(
      version === null
        ? {
            downloaded: false,
            version: null,
            message: "The update download is taking longer than expected.",
          }
        : { downloaded: true, version, message: "" },
    );
  };
  timer = setTimeout(() => waiter(null), timeoutMs);
  updateDownloadWaiters.add(waiter);
}

export async function installAppUpdateOnQuit({
  currentVersion,
  releaseChannel,
  signal,
}: {
  currentVersion: string;
  releaseChannel: AppReleaseChannel;
  signal: AbortSignal;
}): Promise<boolean> {
  if (
    !shouldInstallAppUpdateOnQuit({
      platform: process.platform,
      isAppImage: Boolean(process.env.APPIMAGE),
    })
  ) {
    return false;
  }

  return appUpdateService.installUpdateOnQuit({ currentVersion, releaseChannel, signal });
}
