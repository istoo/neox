import { isElectronRuntime } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

export interface DesktopUpdatePackageManager {
  manager: string;
  name: string;
  package: string | null;
  command: string;
  message: string;
}

export interface DesktopBlockedUpdate {
  version: string;
  error: string;
  policy: boolean;
  at: string;
}

export interface DesktopAppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
  /** myna's packaged.go: the package manager that owns this install. */
  packageManager?: DesktopUpdatePackageManager;
  /** myna's blocked.go: a version this computer refused to run. */
  blockedUpdate?: DesktopBlockedUpdate;
}

export interface DesktopAppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

export interface DesktopRuntimeInfo {
  appVersion: string | null;
  runningUnderARM64Translation: boolean;
}

export type DesktopReleaseChannel = "stable" | "beta";
export type DesktopAppUpdateCheckIntent = "automatic" | "manual";

export interface LocalDaemonUpdateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalDaemonVersionResult {
  version: string | null;
  error: string | null;
}

const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/istoo/neox/releases/download";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumberOr(defaultValue: number, value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

export function shouldShowDesktopUpdateSection(): boolean {
  return isWeb && isElectronRuntime();
}

export function parseLocalDaemonVersionResult(raw: unknown): LocalDaemonVersionResult {
  if (!isRecord(raw)) {
    return { version: null, error: "Unexpected response from version check." };
  }

  return {
    version: toStringOrNull(raw.version),
    error: toStringOrNull(raw.error),
  };
}

export async function getLocalDaemonVersion(): Promise<LocalDaemonVersionResult> {
  const result = await invokeDesktopCommand<unknown>("get_local_daemon_version");
  return parseLocalDaemonVersionResult(result);
}

export function parseDesktopRuntimeInfo(raw: unknown): DesktopRuntimeInfo {
  if (!isRecord(raw)) {
    return {
      appVersion: null,
      runningUnderARM64Translation: false,
    };
  }

  return {
    appVersion: toStringOrNull(raw.appVersion),
    runningUnderARM64Translation: raw.runningUnderARM64Translation === true,
  };
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo> {
  const result = await invokeDesktopCommand<unknown>("desktop_get_runtime_info");
  return parseDesktopRuntimeInfo(result);
}

export async function checkDesktopAppUpdate({
  releaseChannel,
  intent,
  autoDownload,
  mirror,
}: {
  releaseChannel: DesktopReleaseChannel;
  intent: DesktopAppUpdateCheckIntent;
  /** Download a found update by itself; false leaves it for the install click. */
  autoDownload?: boolean;
  /** Prefix for GitHub release downloads; "" for none. */
  mirror?: string;
}): Promise<DesktopAppUpdateCheckResult> {
  const result = await invokeDesktopCommand<unknown>("check_app_update", {
    releaseChannel,
    intent,
    ...(autoDownload === undefined ? {} : { autoDownload }),
    ...(mirror === undefined ? {} : { mirror }),
  });
  if (!isRecord(result)) {
    throw new Error("Unexpected response while checking desktop updates.");
  }

  return {
    hasUpdate: result.hasUpdate === true,
    readyToInstall: result.readyToInstall === true,
    currentVersion: toStringOrNull(result.currentVersion),
    latestVersion: toStringOrNull(result.latestVersion),
    body: toStringOrNull(result.body),
    date: toStringOrNull(result.date),
    errorMessage: toStringOrNull(result.errorMessage),
    ...parsePackageManager(result.packageManager),
    ...parseBlockedUpdate(result.blockedUpdate),
  };
}

function parsePackageManager(value: unknown): {
  packageManager?: DesktopUpdatePackageManager;
} {
  if (!isRecord(value)) {
    return {};
  }
  return {
    packageManager: {
      manager: toStringOrEmpty(value.manager),
      name: toStringOrEmpty(value.name),
      package: toStringOrNull(value.package),
      command: toStringOrEmpty(value.command),
      message: toStringOrEmpty(value.message),
    },
  };
}

function parseBlockedUpdate(value: unknown): { blockedUpdate?: DesktopBlockedUpdate } {
  if (!isRecord(value)) {
    return {};
  }
  return {
    blockedUpdate: {
      version: toStringOrEmpty(value.version),
      error: toStringOrEmpty(value.error),
      policy: value.policy === true,
      at: toStringOrEmpty(value.at),
    },
  };
}

export async function installDesktopAppUpdate({
  releaseChannel,
}: {
  releaseChannel: DesktopReleaseChannel;
}): Promise<DesktopAppUpdateInstallResult> {
  const result = await invokeDesktopCommand<unknown>("install_app_update", { releaseChannel });
  if (!isRecord(result)) {
    throw new Error("Unexpected response while installing desktop update.");
  }

  return {
    installed: result.installed === true,
    version: toStringOrNull(result.version),
    message: toStringOrNull(result.message) ?? i18n.t("desktop.updates.status.installed"),
  };
}

export async function runLocalDaemonUpdate(): Promise<LocalDaemonUpdateResult> {
  const result = await invokeDesktopCommand<unknown>("run_local_daemon_update");
  if (!isRecord(result)) {
    throw new Error("Unexpected response while updating local daemon.");
  }

  return {
    exitCode: toNumberOr(1, result.exitCode),
    stdout: toStringOrEmpty(result.stdout),
    stderr: toStringOrEmpty(result.stderr),
  };
}

export function normalizeVersionForComparison(version: string | null | undefined): string | null {
  const value = version?.trim();
  if (!value) {
    return null;
  }

  return value.replace(/^v/i, "");
}

export function isVersionMismatch(
  appVersion: string | null | undefined,
  daemonVersion: string | null | undefined,
): boolean {
  const app = normalizeVersionForComparison(appVersion);
  const daemon = normalizeVersionForComparison(daemonVersion);

  if (!app || !daemon) {
    return false;
  }

  return app !== daemon;
}

export function formatVersionWithPrefix(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) {
    return "\u2014";
  }

  return value.startsWith("v") ? value : `v${value}`;
}

export function buildMacAppleSiliconDownloadUrl(version: string | null | undefined): string | null {
  const normalizedVersion = normalizeVersionForComparison(version);
  if (!normalizedVersion) {
    return null;
  }

  // Matches packages/desktop/electron-builder.yml mac.artifactName "Neox-${version}-${arch}".
  return `${RELEASE_DOWNLOAD_BASE_URL}/v${normalizedVersion}/Neox-${normalizedVersion}-arm64.dmg`;
}

export function buildDaemonUpdateDiagnostics(result: LocalDaemonUpdateResult): string {
  const stdout = result.stdout.length > 0 ? result.stdout : "(empty)";
  const stderr = result.stderr.length > 0 ? result.stderr : "(empty)";

  return [`Exit code: ${result.exitCode}`, "", "STDOUT:", stdout, "", "STDERR:", stderr].join("\n");
}
