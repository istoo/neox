import {
  rolloutManifestSchema,
  shouldAdmitAppUpdate,
  type AppReleaseChannel,
  type AppUpdateCheckIntent,
} from "./app-update-rollout.js";

export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string;
  latestVersion: string;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
  /** Present when a package manager owns this install and must do the update. */
  packageManager?: UpdatePackageManager;
  /** Present when this computer refused the offered version to start it. */
  blockedUpdate?: UpdateBlockedNote;
  /** This build cannot replace itself; the user downloads the offered version. */
  manualInstall?: true;
}

/** myna update/packaged.go: the manager that installed this build, and its command. */
export interface UpdatePackageManager {
  manager: string;
  name: string;
  package: string | null;
  command: string;
  message: string;
}

/** myna update/blocked.go: a version this computer refused to run. */
export interface UpdateBlockedNote {
  version: string;
  error: string;
  policy: boolean;
  at: string;
}

export interface AppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

export interface RuntimeUpdateInfo {
  version: string;
  releaseNotes?: unknown;
  releaseDate?: unknown;
  rolloutHours?: unknown;
}

export interface RuntimeUpdateCheckResult {
  isUpdateAvailable: boolean;
  updateInfo: RuntimeUpdateInfo;
}

export interface AppUpdateRuntimeConfiguration {
  releaseChannel: AppReleaseChannel;
  /** Download a found update by itself; absent keeps the runtime's default. */
  autoDownload?: boolean;
  /** Prefix for GitHub release downloads; absent keeps the current one. */
  mirror?: string;
  shouldAdmitUpdate(info: RuntimeUpdateInfo): boolean | Promise<boolean>;
  onUpdateAvailable(info: RuntimeUpdateInfo): void;
  onUpdateDownloaded(info: RuntimeUpdateInfo): void;
  onError(error: unknown): void;
}

export interface AppUpdateInstallRequest {
  targetVersion: string;
  isSilent: boolean;
  isForceRunAfter: boolean;
}

export interface AppUpdateRuntime {
  configure(input: AppUpdateRuntimeConfiguration): void;
  checkForUpdates(): Promise<RuntimeUpdateCheckResult | null>;
  downloadUpdate(targetVersion: string): Promise<unknown>;
  quitAndInstall(input: AppUpdateInstallRequest): void;
}

export interface AppUpdateService {
  checkForAppUpdate(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    intent: AppUpdateCheckIntent;
    autoDownload?: boolean;
    mirror?: string;
  }): Promise<AppUpdateCheckResult>;
  downloadAndInstallUpdate(
    input: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      /** Prefix for GitHub release downloads; absent keeps the current one. */
      mirror?: string;
    },
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult>;
  installUpdateOnQuit(input: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    signal: AbortSignal;
  }): Promise<boolean>;
}

export interface AppUpdateServiceDeps {
  runtime: AppUpdateRuntime;
  isPackaged(): boolean;
  now(): number;
  bucket(): Promise<number>;
  reportCheckError?(error: unknown): void;
  reportRuntimeError?(error: unknown): void;
  reportInstallError?(message: string): void;
  /** The package manager that installed this build, if one did. */
  packaged?(): UpdatePackageManager | null;
  /** The note recorded for a version this computer refused, if any. */
  blocked?(version: string): UpdateBlockedNote | null;
  /** Records a refused version; called only for application-control refusals. */
  noteBlocked?(version: string, error: unknown): void;
  /**
   * Whether this build can only be updated by downloading the release by hand
   * (an unsigned macOS app: Squirrel.Mac refuses updates without a Developer ID).
   * Checks still run, but nothing is downloaded or installed.
   */
  manualInstall?(): boolean;
}

export const MANUAL_INSTALL_MESSAGE =
  "This build can't install updates by itself. Download the new version from the release page.";

function buildCheckResult(input: {
  currentVersion: string;
  hasUpdate: boolean;
  readyToInstall: boolean;
  info?: RuntimeUpdateInfo | null;
  errorMessage?: string | null;
  packageManager?: UpdatePackageManager;
  blockedUpdate?: UpdateBlockedNote;
  manualInstall?: boolean;
}): AppUpdateCheckResult {
  const { currentVersion, hasUpdate, readyToInstall, info, errorMessage = null } = input;

  return {
    hasUpdate,
    readyToInstall,
    currentVersion,
    latestVersion: info?.version ?? currentVersion,
    body: typeof info?.releaseNotes === "string" ? info.releaseNotes : null,
    date: typeof info?.releaseDate === "string" ? info.releaseDate : null,
    errorMessage,
    ...(input.packageManager === undefined ? {} : { packageManager: input.packageManager }),
    ...(input.blockedUpdate === undefined ? {} : { blockedUpdate: input.blockedUpdate }),
    ...(input.manualInstall === true && hasUpdate ? { manualInstall: true as const } : {}),
  };
}

async function performQuitAndInstall(
  runtime: AppUpdateRuntime,
  {
    targetVersion,
    onBeforeQuit,
    restart,
  }: {
    targetVersion: string;
    onBeforeQuit?: () => Promise<void>;
    restart: boolean;
  },
): Promise<void> {
  if (onBeforeQuit) await onBeforeQuit();
  runtime.quitAndInstall({
    targetVersion,
    isSilent: !restart,
    isForceRunAfter: restart,
  });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function buildDeferredInstallResult(currentVersion: string): AppUpdateInstallResult {
  return {
    installed: false,
    version: currentVersion,
    message: "Update validation timed out. The update will be installed later.",
  };
}

export function createAppUpdateService(deps: AppUpdateServiceDeps): AppUpdateService {
  let cachedUpdateInfo: RuntimeUpdateInfo | null = null;
  let downloadedUpdateVersion: string | null = null;
  let configuredReleaseChannel: AppReleaseChannel | null = null;
  let preparationError: { version: string; message: string } | null = null;
  let preparingUpdateVersion: string | null = null;
  let checkQueue: Promise<void> = Promise.resolve();

  function isReadyToInstallVersion(version: string): boolean {
    return downloadedUpdateVersion === version;
  }

  function clearUpdateState(): void {
    cachedUpdateInfo = null;
    downloadedUpdateVersion = null;
    preparationError = null;
    preparingUpdateVersion = null;
  }

  function buildPreviouslyAdmittedUpdateResult(
    currentVersion: string,
    checkedInfo: RuntimeUpdateInfo,
    manualInstall: boolean,
  ): AppUpdateCheckResult | null {
    const info = cachedUpdateInfo;
    if (!info || info.version === currentVersion || info.version !== checkedInfo.version) {
      return null;
    }

    return buildCheckResult({
      currentVersion,
      hasUpdate: true,
      readyToInstall: isReadyToInstallVersion(info.version),
      info,
      errorMessage: preparationError?.version === info.version ? preparationError.message : null,
      manualInstall,
    });
  }

  function configureRuntime(
    releaseChannel: AppReleaseChannel,
    intent: AppUpdateCheckIntent,
    autoDownload: boolean | undefined,
    mirror: string | undefined,
  ): void {
    if (configuredReleaseChannel !== releaseChannel) {
      clearUpdateState();
      configuredReleaseChannel = releaseChannel;
    }

    deps.runtime.configure({
      releaseChannel,
      ...(autoDownload === undefined ? {} : { autoDownload }),
      ...(mirror === undefined ? {} : { mirror }),
      shouldAdmitUpdate: async (info) => {
        const parsed = rolloutManifestSchema.parse(info);
        return shouldAdmitAppUpdate({
          channel: releaseChannel,
          intent,
          rolloutHours: parsed.rolloutHours,
          releaseDate: parsed.releaseDate,
          now: deps.now(),
          bucket: await deps.bucket(),
        });
      },
      onUpdateAvailable(info) {
        const alreadyReady = downloadedUpdateVersion === info.version;
        cachedUpdateInfo = info;
        downloadedUpdateVersion = alreadyReady ? info.version : null;
        if (!alreadyReady && preparingUpdateVersion === null) {
          preparingUpdateVersion = info.version;
        }
      },
      onUpdateDownloaded(info) {
        // A superseded download can finish after a newer manifest check. Keep
        // the validated manifest as the install target in that case.
        cachedUpdateInfo ??= info;
        downloadedUpdateVersion = info.version;
        if (preparingUpdateVersion === info.version) {
          preparingUpdateVersion = null;
        }
        if (preparationError?.version === info.version) {
          preparationError = null;
        }
      },
      onError(error) {
        if (preparingUpdateVersion) {
          deps.noteBlocked?.(preparingUpdateVersion, error);
          preparationError = {
            version: preparingUpdateVersion,
            message: getErrorMessage(error),
          };
          preparingUpdateVersion = null;
        }
        deps.reportRuntimeError?.(error);
      },
    });
  }

  function runCheckExclusively<T>(check: () => Promise<T>): Promise<T> {
    const result = checkQueue.then(check, check);
    checkQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function checkForAppUpdate({
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
    if (!deps.isPackaged()) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
      });
    }

    // A package manager's install is the manager's to update (packaged.go).
    const packageManager = deps.packaged?.() ?? null;
    if (packageManager) {
      return buildCheckResult({
        currentVersion,
        hasUpdate: false,
        readyToInstall: false,
        packageManager,
      });
    }

    return runCheckExclusively(async () => {
      const manualInstall = deps.manualInstall?.() === true;
      // Nothing is downloaded for a build that can't install it.
      configureRuntime(releaseChannel, intent, manualInstall ? false : autoDownload, mirror);

      try {
        const result = await deps.runtime.checkForUpdates();
        if (!result || !result.updateInfo) {
          clearUpdateState();
          return buildCheckResult({
            currentVersion,
            hasUpdate: false,
            readyToInstall: false,
          });
        }

        if (!result.isUpdateAvailable) {
          const admittedUpdate = buildPreviouslyAdmittedUpdateResult(
            currentVersion,
            result.updateInfo,
            manualInstall,
          );
          if (admittedUpdate) {
            return admittedUpdate;
          }

          clearUpdateState();
          return buildCheckResult({
            currentVersion,
            hasUpdate: false,
            readyToInstall: false,
          });
        }

        const info = result.updateInfo;
        const latestVersion = info.version;
        const hasUpdate = latestVersion !== currentVersion;

        if (hasUpdate) {
          // A version this computer refused to start is not offered again
          // (blocked.go ReadBlocked).
          const blockedUpdate = deps.blocked?.(latestVersion) ?? null;
          if (blockedUpdate) {
            return buildCheckResult({
              currentVersion,
              hasUpdate: false,
              readyToInstall: false,
              blockedUpdate,
            });
          }
          cachedUpdateInfo = info;
          const errorMessage =
            preparationError?.version === latestVersion ? preparationError.message : null;
          if (!errorMessage) {
            preparationError = null;
          }
          return buildCheckResult({
            currentVersion,
            hasUpdate: true,
            readyToInstall: isReadyToInstallVersion(latestVersion),
            info,
            errorMessage,
            manualInstall,
          });
        }

        clearUpdateState();
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
        });
      } catch (error) {
        deps.reportCheckError?.(error);
        return buildCheckResult({
          currentVersion,
          hasUpdate: false,
          readyToInstall: false,
          errorMessage: getErrorMessage(error),
        });
      }
    });
  }

  async function downloadAndInstallUpdate(
    {
      currentVersion,
      releaseChannel,
      mirror,
    }: {
      currentVersion: string;
      releaseChannel: AppReleaseChannel;
      mirror?: string;
    },
    onBeforeQuit?: () => Promise<void>,
  ): Promise<AppUpdateInstallResult> {
    if (!deps.isPackaged()) {
      return {
        installed: false,
        version: currentVersion,
        message: "Auto-update is not available in development mode.",
      };
    }

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "manual",
      ...(mirror === undefined ? {} : { mirror }),
    });
    if (!check.hasUpdate) {
      return {
        installed: false,
        version: currentVersion,
        message: check.errorMessage ?? "No update available.",
      };
    }
    if (check.manualInstall) {
      return { installed: false, version: currentVersion, message: MANUAL_INSTALL_MESSAGE };
    }

    return installCachedUpdate(currentVersion, { onBeforeQuit, restart: true });
  }

  async function ensureUpdateDownloaded(
    readyVersion: string,
    signal?: AbortSignal,
  ): Promise<"ready" | "aborted" | "superseded"> {
    while (!isReadyToInstallVersion(readyVersion)) {
      if (signal?.aborted) return "aborted";
      if (cachedUpdateInfo?.version !== readyVersion) return "superseded";

      const attemptedVersion: string = preparingUpdateVersion ?? readyVersion;
      preparingUpdateVersion ??= readyVersion;
      try {
        await deps.runtime.downloadUpdate(attemptedVersion);
      } catch (error) {
        if (
          attemptedVersion !== readyVersion &&
          cachedUpdateInfo?.version === readyVersion &&
          !signal?.aborted
        ) {
          continue;
        }
        throw error;
      }

      // electron-updater can return an older, already-running download. Its
      // event clears that version, then the next iteration starts the newly
      // validated release instead of treating the stale artifact as ready.
      if (attemptedVersion === readyVersion && !isReadyToInstallVersion(readyVersion)) {
        downloadedUpdateVersion = readyVersion;
        preparingUpdateVersion = null;
      }
    }

    return signal?.aborted ? "aborted" : "ready";
  }

  async function installCachedUpdate(
    currentVersion: string,
    {
      onBeforeQuit,
      signal,
      restart,
    }: {
      onBeforeQuit?: () => Promise<void>;
      signal?: AbortSignal;
      restart: boolean;
    },
  ): Promise<AppUpdateInstallResult> {
    if (!cachedUpdateInfo) {
      return {
        installed: false,
        version: currentVersion,
        message: "No update available. Check for updates first.",
      };
    }

    const readyVersion = cachedUpdateInfo.version;
    if (signal?.aborted) {
      return buildDeferredInstallResult(currentVersion);
    }

    if (isReadyToInstallVersion(readyVersion)) {
      await performQuitAndInstall(deps.runtime, {
        targetVersion: readyVersion,
        onBeforeQuit,
        restart,
      });
      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    }

    try {
      const preparation = await ensureUpdateDownloaded(readyVersion, signal);
      if (preparation === "aborted") {
        return buildDeferredInstallResult(currentVersion);
      }
      if (preparation === "superseded") {
        return {
          installed: false,
          version: currentVersion,
          message: "A newer update was found and will be installed later.",
        };
      }
      await performQuitAndInstall(deps.runtime, {
        targetVersion: readyVersion,
        onBeforeQuit,
        restart,
      });

      return {
        installed: true,
        version: readyVersion,
        message: "Update downloaded. The app will restart shortly.",
      };
    } catch (error) {
      deps.noteBlocked?.(readyVersion, error);
      const message = error instanceof Error ? error.message : String(error);
      deps.reportInstallError?.(message);
      return {
        installed: false,
        version: currentVersion,
        message: `Update failed: ${message}`,
      };
    }
  }

  async function installUpdateOnQuit({
    currentVersion,
    releaseChannel,
    signal,
  }: {
    currentVersion: string;
    releaseChannel: AppReleaseChannel;
    signal: AbortSignal;
  }): Promise<boolean> {
    if (!deps.isPackaged() || !downloadedUpdateVersion) {
      return false;
    }

    const check = await checkForAppUpdate({
      currentVersion,
      releaseChannel,
      intent: "automatic",
    });
    if (signal.aborted || !check.hasUpdate) {
      return false;
    }

    const result = await installCachedUpdate(currentVersion, { signal, restart: false });
    return result.installed;
  }

  return {
    checkForAppUpdate,
    downloadAndInstallUpdate,
    installUpdateOnQuit,
  };
}
