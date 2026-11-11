// FILE: DesktopDaemonSection.tsx
// Purpose: Desktop shell rows for the built-in daemon's start/stop/status and the
//          diagnostics panel shared by the daemon and the Electron shell.
// Layer: Settings UI components
// Exports: DesktopDaemonLifecycleSection, DesktopDiagnosticsSettingsPanel

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/ui/copyTextButton";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";
import { getHostDiagnostics, getHostStatus, revealHostPath } from "~/lib/neolixHostApi";
import { ensureNativeApi } from "~/nativeApi";

import {
  desktopShellAvailable,
  invokeDesktopShellCommand,
  useDesktopShellSettings,
} from "./desktopShellSettings";
import type { DesktopShellSettings } from "./desktopShellSettings";
import { SettingsEmptyState, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

function textOr(value: string | null | undefined, fallback: string): string {
  return value ?? fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ShellDaemonStatus {
  readonly serverId: string;
  readonly status: "starting" | "running" | "stopped" | "errored";
  readonly listen: string | null;
  readonly pid: number | null;
  readonly home: string;
  readonly version: string | null;
  readonly desktopManaged: boolean;
  readonly ownedByDesktop: boolean;
  readonly error: string | null;
}

interface ShellDaemonLogs {
  readonly logPath: string;
  readonly contents: string;
}

interface ShellAppLogs {
  readonly logPath: string;
  readonly contents: string;
}

function daemonStateLabel(
  status: ShellDaemonStatus | undefined,
  t: (key: string) => string,
): string {
  if (!status) return t("settings:host_loading");
  switch (status.status) {
    case "running":
      return `${t("settings:desktop_daemonRunning")} · ${status.version ?? t("settings:host_unknownVersion")} · PID ${status.pid ?? "—"}`;
    case "starting":
      return t("settings:desktop_daemonStarting");
    case "errored":
      return status.error ?? t("settings:desktop_daemonErrored");
    default:
      return t("settings:desktop_daemonStopped");
  }
}

async function confirmStop(
  status: ShellDaemonStatus,
  message: string,
  confirmLabel: string,
): Promise<boolean> {
  try {
    return await ensureNativeApi().dialogs.confirm(
      `${message}\n\n${status.home}\nPID ${status.pid ?? "—"}`,
      { confirmLabel, destructive: true },
    );
  } catch {
    return false;
  }
}

/**
 * Starts and stops the daemon the desktop app owns. It appears only in the
 * desktop shell: a plain browser has no daemon process to control, so the host
 * page keeps only the daemon's own restart/update rows there.
 */
export function DesktopDaemonLifecycleSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const available = desktopShellAvailable();
  const { settings } = useDesktopShellSettings(active && available);
  const [busy, setBusy] = useState<"start" | "stop" | null>(null);
  const statusQuery = useQuery({
    queryKey: ["neolix-desktop-daemon-status"],
    queryFn: () => invokeDesktopShellCommand<ShellDaemonStatus>("desktop_daemon_status"),
    enabled: active && available,
    refetchInterval: active && available ? 5_000 : false,
    retry: false,
  });

  const run = useCallback(
    async (action: "start" | "stop") => {
      const status = statusQuery.data;
      if (action === "stop") {
        if (!status) return;
        if (
          !(await confirmStop(
            status,
            t("settings:desktop_daemonStopConfirm"),
            t("settings:desktop_stopDaemon"),
          ))
        )
          return;
      }
      setBusy(action);
      const command = action === "start" ? "start_desktop_daemon" : "stop_desktop_daemon";
      const commandArgs = action === "start" ? {} : { reason: "settings" };
      const successTitle =
        action === "start"
          ? t("settings:desktop_daemonStartSucceeded")
          : t("settings:desktop_daemonStopSucceeded");
      const failureTitle =
        action === "start"
          ? t("settings:desktop_couldNotStartDaemon")
          : t("settings:desktop_couldNotStopDaemon");
      try {
        await invokeDesktopShellCommand(command, commandArgs);
        await statusQuery.refetch();
        toastManager.add({
          type: "success",
          title: successTitle,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: messageOf(error),
        });
      }
      setBusy(null);
    },
    [statusQuery, t],
  );

  if (!active || !available) return null;
  const status = statusQuery.data;
  const running = status?.status === "running" || status?.status === "starting";
  const managementEnabled: DesktopShellSettings["daemon"] | undefined = settings?.daemon;

  return (
    <SettingsSection title={t("settings:desktop_builtInDaemon")}>
      <SettingsRow
        title={t("settings:desktop_daemonStatus")}
        description={t("settings:desktop_daemonStatusDescription")}
        status={statusQuery.error ? messageOf(statusQuery.error) : daemonStateLabel(status, t)}
        control={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={
                busy !== null || running || managementEnabled?.manageBuiltInDaemon === false
              }
              onClick={() => void run("start")}
            >
              {busy === "start" ? t("settings:host_loading") : t("settings:desktop_startDaemon")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null || !running}
              onClick={() => void run("stop")}
            >
              {busy === "stop" ? t("settings:host_loading") : t("settings:desktop_stopDaemon")}
            </Button>
          </div>
        }
      />
      {managementEnabled?.manageBuiltInDaemon === false ? (
        <SettingsRow
          title={t("settings:desktop_daemonManagementOff")}
          description={t("settings:desktop_daemonManagementOffDescription")}
        />
      ) : null}
      {status?.home ? (
        <SettingsRow
          title={t("settings:desktop_daemonHome")}
          description={status.home}
          control={
            <div className="flex items-center gap-1">
              <CopyTextButton
                text={status.home}
                label={t("settings:desktop_daemonHome")}
                iconOnly
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void window.desktopBridge?.showInFolder(status.home)}
              >
                {t("settings:host_reveal")}
              </Button>
            </div>
          }
        />
      ) : null}
      <DesktopDaemonLogRow active={active && available} />
    </SettingsSection>
  );
}

function DesktopDaemonLogRow({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["neolix-desktop-daemon-logs"],
    queryFn: () => invokeDesktopShellCommand<ShellDaemonLogs>("desktop_daemon_logs"),
    enabled: active,
    retry: false,
  });
  const logPath = query.data?.logPath;
  if (!logPath) return null;
  return (
    <SettingsRow
      title={t("settings:desktop_daemonLog")}
      description={logPath}
      control={
        <div className="flex items-center gap-1">
          <CopyTextButton text={logPath} label={t("settings:desktop_daemonLog")} iconOnly />
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void window.desktopBridge?.showInFolder(logPath)}
          >
            {t("settings:host_reveal")}
          </Button>
        </div>
      }
    />
  );
}

function ReportBlock({ text }: { readonly text: string }) {
  return (
    <pre className="mx-3 my-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--color-border)] bg-background p-3 font-mono text-ui-xs text-foreground">
      {text}
    </pre>
  );
}

/**
 * Settings › Diagnostics: the daemon's own report plus the Electron shell's
 * sandbox, log and updater diagnostics. Everything here is a snapshot, so rows
 * run on click rather than polling.
 */
export function DesktopDiagnosticsSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const available = desktopShellAvailable();
  const statusQuery = useQuery({
    queryKey: ["neolix-host-status"],
    queryFn: getHostStatus,
    enabled: active,
    staleTime: 10_000,
    retry: false,
  });
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [runningDiagnostic, setRunningDiagnostic] = useState(false);
  const [shellReport, setShellReport] = useState<{ title: string; text: string } | null>(null);
  const [busyShell, setBusyShell] = useState<string | null>(null);

  const runDiagnostic = useCallback(async () => {
    setRunningDiagnostic(true);
    try {
      const result = await getHostDiagnostics();
      setDiagnostic(result.diagnostic);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:desktop_diagnosticFailed"),
        description: messageOf(error),
      });
    }
    setRunningDiagnostic(false);
  }, [t]);

  const runShell = useCallback(
    async (command: string, title: string, format: (value: unknown) => string) => {
      setBusyShell(command);
      try {
        const value = await invokeDesktopShellCommand(command);
        setShellReport({ title, text: format(value) });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:desktop_diagnosticFailed"),
          description: messageOf(error),
        });
      }
      setBusyShell(null);
    },
    [t],
  );

  const reveal = useCallback(
    async (target: "config" | "log") => {
      try {
        const result = await revealHostPath(target);
        if (!result.ok) {
          toastManager.add({
            type: "error",
            title: t("settings:desktop_diagnosticFailed"),
            description: textOr(result.error, t("settings:unavailable")),
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:desktop_diagnosticFailed"),
          description: messageOf(error),
        });
      }
    },
    [t],
  );

  if (!active) return null;
  const status = statusQuery.data;

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:desktop_daemonPaths")}>
        {statusQuery.error ? (
          <SettingsEmptyState layout="status">
            {t("settings:host_unavailableWith", { error: messageOf(statusQuery.error) })}
          </SettingsEmptyState>
        ) : (
          <>
            <SettingsRow
              title={t("settings:desktop_configFolder")}
              description={status?.home ?? t("settings:unavailable")}
              control={
                <div className="flex items-center gap-1">
                  {status?.home ? (
                    <CopyTextButton
                      text={status.home}
                      label={t("settings:desktop_configFolder")}
                      iconOnly
                    />
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!status?.home}
                    onClick={() => void reveal("config")}
                  >
                    {t("settings:host_reveal")}
                  </Button>
                </div>
              }
            />
            <SettingsRow
              title={t("settings:desktop_logFile")}
              description={status?.logPath ?? t("settings:unavailable")}
              control={
                <div className="flex items-center gap-1">
                  {status?.logPath ? (
                    <CopyTextButton
                      text={status.logPath}
                      label={t("settings:desktop_logFile")}
                      iconOnly
                    />
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!status?.logPath}
                    onClick={() => void reveal("log")}
                  >
                    {t("settings:host_reveal")}
                  </Button>
                </div>
              }
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings:desktop_hostDiagnostics")}>
        <SettingsRow
          title={t("settings:desktop_runDiagnostic")}
          description={t("settings:desktop_runDiagnosticDescription")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={runningDiagnostic}
              onClick={() => void runDiagnostic()}
            >
              {runningDiagnostic ? t("settings:host_loading") : t("settings:desktop_run")}
            </Button>
          }
        />
        {diagnostic ? (
          <>
            <SettingsRow
              title={t("settings:desktop_diagnosticReport")}
              description=""
              control={
                <CopyTextButton
                  text={diagnostic}
                  label={t("settings:desktop_diagnosticReport")}
                  iconOnly
                />
              }
            />
            <ReportBlock text={diagnostic} />
          </>
        ) : null}
      </SettingsSection>

      {available ? (
        <SettingsSection title={t("settings:desktop_shellDiagnostics")}>
          <SettingsRow
            title={t("settings:desktop_sandbox")}
            description={t("settings:desktop_sandboxDescription")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busyShell !== null}
                onClick={() =>
                  void runShell(
                    "desktop_sandbox_diagnostics",
                    t("settings:desktop_sandbox"),
                    (value) => JSON.stringify(value, null, 2),
                  )
                }
              >
                {t("settings:desktop_run")}
              </Button>
            }
          />
          <SettingsRow
            title={t("settings:desktop_appLogs")}
            description={t("settings:desktop_appLogsDescription")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busyShell !== null}
                onClick={() =>
                  void runShell("desktop_app_logs", t("settings:desktop_appLogs"), (value) => {
                    const logs = value as ShellAppLogs;
                    return `${logs.logPath}\n\n${logs.contents}`;
                  })
                }
              >
                {t("settings:desktop_run")}
              </Button>
            }
          />
          <SettingsRow
            title={t("settings:desktop_updateDiagnostics")}
            description={t("settings:desktop_updateDiagnosticsDescription")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busyShell !== null}
                onClick={() =>
                  void runShell(
                    "desktop_update_diagnostics",
                    t("settings:desktop_updateDiagnostics"),
                    (value) => JSON.stringify(value, null, 2),
                  )
                }
              >
                {t("settings:desktop_run")}
              </Button>
            }
          />
          <SettingsRow
            title={t("settings:desktop_cliStatus")}
            description={t("settings:desktop_cliStatusDescription")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busyShell !== null}
                onClick={() =>
                  void runShell("cli_daemon_status", t("settings:desktop_cliStatus"), (value) =>
                    String(value),
                  )
                }
              >
                {t("settings:desktop_run")}
              </Button>
            }
          />
          {shellReport ? (
            <>
              <SettingsRow
                title={shellReport.title}
                description=""
                control={
                  <CopyTextButton text={shellReport.text} label={shellReport.title} iconOnly />
                }
              />
              <ReportBlock text={shellReport.text} />
            </>
          ) : null}
        </SettingsSection>
      ) : null}
    </div>
  );
}
