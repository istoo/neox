// FILE: desktopUpdate.logic.ts
// Purpose: Maps desktop updater state into sidebar button actions and copy.
// Layer: Web UI state helper
// Depends on: Desktop update IPC contracts.

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@synara/contracts";

import { t } from "~/i18n";

export type DesktopUpdateButtonAction = "check" | "download" | "install" | "open-release" | "none";

/** An update this build can't install itself; the button opens the release page. */
function isManualDownloadOffer(state: DesktopUpdateState): boolean {
  return state.manualInstall === true && state.status === "available" && Boolean(state.releaseUrl);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (isManualDownloadOffer(state)) {
    return "open-release";
  }
  if (state.status === "error" && state.errorContext === "install" && !state.canRetry) {
    return "none";
  }
  if (
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "up-to-date" ||
    (state.status === "error" && state.errorContext === "check")
  ) {
    return "check";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "downloaded") {
    return "install";
  }
  if (state.status === "error") {
    if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
      return "download";
    }
    if (
      state.downloadedVersion &&
      (state.errorContext === "install" || state.errorContext === null)
    ) {
      return "install";
    }
    if (
      state.availableVersion &&
      (state.errorContext === "download" || state.errorContext === null)
    ) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state?.enabled) return false;
  // Only show the button when there's actually something to do:
  // a version being prepared, a downloaded update to install, or a retryable error.
  // Update checks stay background-only so periodic polling never flashes sidebar UI.
  const action = resolveDesktopUpdateButtonAction(state);
  return (
    state.status === "available" ||
    state.status === "downloading" ||
    state.status === "downloaded" ||
    (state.status === "error" &&
      state.errorContext !== "check" &&
      (action !== "none" || (state.errorContext === "install" && Boolean(state.downloadedVersion))))
  );
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  if (state && isManualDownloadOffer(state)) return false;
  return (
    (state?.status === "error" && state.errorContext === "install" && !state.canRetry) ||
    state?.status === "downloading" ||
    state?.status === "checking" ||
    (state?.status === "available" && state.errorContext !== "download")
  );
}

/**
 * Clamped, integer download percentage to surface on the update button while a
 * download is in flight. Returns null outside the downloading state or when the
 * updater has not reported a finite percentage yet.
 */
export function getDesktopUpdateDownloadPercent(state: DesktopUpdateState | null): number | null {
  if (!state || state.status !== "downloading") return null;
  const percent = state.downloadPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.max(0, Math.min(100, Math.floor(percent)));
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return t("settings:updateArchOk");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return t("settings:updateArmPreparing");
  }
  if (action === "install") {
    return t("settings:updateArmClickUpdate");
  }
  return t("settings:updateArmNextUpdate");
}

export function getDesktopUpdateButtonTooltip(
  state: DesktopUpdateState,
  options?: { installing?: boolean },
): string {
  if (options?.installing) {
    return t("settings:updateApplying");
  }
  if (isManualDownloadOffer(state)) {
    return t("settings:updateManualDownload", { version: state.availableVersion ?? "" });
  }
  if (state.status === "error" && state.errorContext === "install" && !state.canRetry) {
    return state.message ?? t("settings:updateQuitReopen");
  }
  if (state.status === "idle") {
    return t("settings:updateCheck");
  }
  if (state.status === "checking") {
    return t("settings:updateChecking");
  }
  if (state.status === "up-to-date") {
    return t("settings:updateUpToDate", { version: state.currentVersion });
  }
  if (state.errorContext === "install" && !state.downloadedVersion && state.availableVersion) {
    return t("settings:updateRestartedNotInstalled", { version: state.availableVersion });
  }
  if (state.errorContext === "download" && state.availableVersion) {
    return t("settings:updateCouldNotPrepare", { version: state.availableVersion });
  }
  if (state.errorContext === "install" && (state.downloadedVersion || state.availableVersion)) {
    return t("settings:updateCouldNotInstall", {
      version: state.downloadedVersion ?? state.availableVersion,
    });
  }
  if (state.status === "available") {
    return t("settings:updatePreparing", { version: state.availableVersion ?? "" }).trim();
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? t("settings:updatePreparingPercent", { percent: Math.floor(state.downloadPercent) })
      : t("settings:updatePreparing", { version: "" }).trim();
  }
  if (state.status === "downloaded") {
    return t("settings:updateReady", {
      version: state.downloadedVersion ?? state.availableVersion ?? "",
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "check") {
      return state.message
        ? t("settings:updateCheckFailedWithMessage", { message: state.message })
        : t("settings:updateCheckFailed");
    }
    if (state.errorContext === "download" && state.availableVersion) {
      return t("settings:updateCouldNotPrepare", { version: state.availableVersion });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return t("settings:updateCouldNotInstall", { version: state.downloadedVersion });
    }
    return state.message ?? t("settings:updateFailed");
  }
  return t("settings:updateAvailable");
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return result.accepted && !result.completed;
}

// installUpdate resolves as soon as the quit-and-install handoff starts, while
// the updater still reports "downloaded". That state means the install is in
// flight, so callers must not treat the accepted-but-incomplete result as done.
export function isDesktopUpdateInstallInFlight(result: DesktopUpdateActionResult): boolean {
  return (
    result.accepted &&
    !result.completed &&
    result.state.status === "downloaded" &&
    result.state.errorContext !== "install"
  );
}

// A download/install request can resolve to "up-to-date" when the offered version
// turned out not to be newer (stale updater state). That is not an error, so the UI
// should show an informational notice instead of silently resetting the button.
export function getDesktopUpdateAlreadyCurrentNotice(
  result: DesktopUpdateActionResult,
): string | null {
  if (result.completed || result.state.status !== "up-to-date") {
    return null;
  }
  return t("settings:updateAlreadyLatest", { version: result.state.currentVersion });
}

export function shouldRecommendManualDesktopDownload(state: DesktopUpdateState | null): boolean {
  return Boolean(state && state.installFailureCount >= 2 && state.releaseUrl);
}

// Stable identity for an in-app update failure, used to avoid toasting the same
// download/install error twice (e.g. once from the click handler and again when
// the install watchdog pushes the recovered state). Returns null for states that
// have no actionable manual-download fallback (checks, successes, in-progress).
export function getDesktopUpdateErrorSignature(state: DesktopUpdateState | null): string | null {
  if (!state || (state.errorContext !== "download" && state.errorContext !== "install")) {
    return null;
  }
  const version = state.downloadedVersion ?? state.availableVersion ?? "";
  return `${state.errorContext}:${version}:${state.installFailureCount}:${state.message ?? ""}`;
}
