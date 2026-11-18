// FILE: DesktopSystemSettingsSection.tsx
// Purpose: The Electron shell's General settings rows (login item, Dock, quitting,
//          lightweight windows, tray, quick-panel shortcut) and its update policy.
//          Everything here comes from the shell's own command channel; in a plain
//          browser there is no shell and the sections render nothing.
// Layer: Settings UI components

import { useTranslation } from "~/i18n";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import { toastManager } from "~/components/ui/toast";

import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import {
  desktopShellAvailable,
  desktopShellPlatform,
  invokeDesktopShellCommand,
  useDesktopShellSettings,
  type DesktopReleaseChannel,
  type DesktopTrayClick,
  type DesktopTrayCurrency,
  type DesktopTrayDisplayAs,
  type DesktopTrayNumberUnits,
} from "./desktopShellSettings";
import { SettingResetButton, SettingsSegmentedControl } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";

type DesktopPreventSleepMode = "off" | "on" | "display";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DEFAULT_PREVENT_SLEEP: DesktopPreventSleepMode = "off";
const DEFAULT_LAUNCH_AT_LOGIN = false;
const DEFAULT_DOCK_VISIBLE = true;
const DEFAULT_CONFIRM_QUIT = false;
const DEFAULT_LIGHTWEIGHT_MODE = true;
const DEFAULT_TRAY: DesktopTrayClick = "window";
const DEFAULT_PANEL_SHORTCUT = "";
const DEFAULT_RELEASE_CHANNEL: DesktopReleaseChannel = "stable";
const DEFAULT_AUTO_CHECK = true;
const DEFAULT_UPDATE_MINUTES = 360;
const DEFAULT_AUTO_DOWNLOAD = true;
const DEFAULT_AUTO_RESTART = false;
const DEFAULT_MANAGE_BUILT_IN_DAEMON = true;
const DEFAULT_KEEP_RUNNING_AFTER_QUIT = false;
const DEFAULT_UPDATE_MIRROR = "";
const DEFAULT_NO_UPDATE_PILL = false;
const DEFAULT_TRAY_USAGES: ReadonlyArray<string> = [];
const DEFAULT_TRAY_USAGE_EVERY = 3;
const DEFAULT_TRAY_DISPLAY_AS: DesktopTrayDisplayAs = "used";
const DEFAULT_TRAY_CURRENCY: DesktopTrayCurrency = "usd";
const DEFAULT_TRAY_NUMBER_UNITS: DesktopTrayNumberUnits = "compact";

const TRAY_USAGE_EVERY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "1", label: "1" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
  { value: "10", label: "10" },
  { value: "30", label: "30" },
];

const TRAY_TOTAL_IDS = ["usage:today", "usage:7d"] as const;

const UPDATE_INTERVAL_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "30", label: "settings:desktop_interval30m" },
  { value: "60", label: "settings:desktop_interval1h" },
  { value: "360", label: "settings:desktop_interval6h" },
  { value: "1440", label: "settings:desktop_interval24h" },
];

export function DesktopSystemSettingsSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { available, settings, patch } = useDesktopShellSettings(active);

  if (!active || !available || !settings) return null;
  const isMac = desktopShellPlatform() === "darwin";
  const daemonSettings = settings.daemon ?? {
    manageBuiltInDaemon: DEFAULT_MANAGE_BUILT_IN_DAEMON,
    keepRunningAfterQuit: DEFAULT_KEEP_RUNNING_AFTER_QUIT,
  };

  return (
    <SettingsSection title="settings:desktop_section">
      <SettingsRow
        id="setting-prevent-sleep"
        title="settings:desktop_preventSleep"
        description="settings:desktop_preventSleepDescription"
        resetAction={
          settings.preventSleep !== DEFAULT_PREVENT_SLEEP ? (
            <SettingResetButton
              label={t("settings:desktop_preventSleep")}
              onClick={() => void patch({ preventSleep: DEFAULT_PREVENT_SLEEP })}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={settings.preventSleep}
            onValueChange={(value) => void patch({ preventSleep: value })}
            ariaLabel={t("settings:desktop_preventSleep")}
            options={[
              { value: "off", label: "settings:desktop_preventSleepOff" },
              { value: "on", label: "settings:desktop_preventSleepOn" },
              { value: "display", label: "settings:desktop_preventSleepDisplay" },
            ]}
          />
        }
      />
      <SettingsRow
        id="setting-launch-at-login"
        title="settings:desktop_launchAtLogin"
        description="settings:desktop_launchAtLoginDescription"
        resetAction={
          settings.launchAtLogin !== DEFAULT_LAUNCH_AT_LOGIN ? (
            <SettingResetButton
              label={t("settings:desktop_launchAtLogin")}
              onClick={() => void patch({ launchAtLogin: DEFAULT_LAUNCH_AT_LOGIN })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.launchAtLogin}
            onCheckedChange={(checked) => void patch({ launchAtLogin: Boolean(checked) })}
            aria-label={t("settings:desktop_launchAtLogin")}
          />
        }
      />

      {isMac ? (
        <SettingsRow
          id="setting-dock-visible"
          title="settings:desktop_dockVisible"
          description="settings:desktop_dockVisibleDescription"
          resetAction={
            settings.dockVisible !== DEFAULT_DOCK_VISIBLE ? (
              <SettingResetButton
                label={t("settings:desktop_dockVisible")}
                onClick={() => void patch({ dockVisible: DEFAULT_DOCK_VISIBLE })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.dockVisible}
              onCheckedChange={(checked) => void patch({ dockVisible: Boolean(checked) })}
              aria-label={t("settings:desktop_dockVisible")}
            />
          }
        />
      ) : null}

      <SettingsRow
        id="setting-confirm-quit"
        title="settings:desktop_confirmQuit"
        description="settings:desktop_confirmQuitDescription"
        resetAction={
          settings.confirmQuit !== DEFAULT_CONFIRM_QUIT ? (
            <SettingResetButton
              label={t("settings:desktop_confirmQuit")}
              onClick={() => void patch({ confirmQuit: DEFAULT_CONFIRM_QUIT })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.confirmQuit}
            onCheckedChange={(checked) => void patch({ confirmQuit: Boolean(checked) })}
            aria-label={t("settings:desktop_confirmQuit")}
          />
        }
      />

      <SettingsRow
        id="setting-lightweight-mode"
        title="settings:desktop_lightweightMode"
        description="settings:desktop_lightweightModeDescription"
        resetAction={
          settings.lightweightMode !== DEFAULT_LIGHTWEIGHT_MODE ? (
            <SettingResetButton
              label={t("settings:desktop_lightweightMode")}
              onClick={() => void patch({ lightweightMode: DEFAULT_LIGHTWEIGHT_MODE })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.lightweightMode}
            onCheckedChange={(checked) => void patch({ lightweightMode: Boolean(checked) })}
            aria-label={t("settings:desktop_lightweightMode")}
          />
        }
      />

      <SettingsRow
        id="setting-manage-built-in-daemon"
        title="settings:desktop_manageBuiltInDaemon"
        description="settings:desktop_manageBuiltInDaemonDescription"
        resetAction={
          settings.daemon?.manageBuiltInDaemon !== DEFAULT_MANAGE_BUILT_IN_DAEMON ? (
            <SettingResetButton
              label={t("settings:desktop_manageBuiltInDaemon")}
              onClick={() =>
                void patch({ daemon: { manageBuiltInDaemon: DEFAULT_MANAGE_BUILT_IN_DAEMON } })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={daemonSettings.manageBuiltInDaemon}
            onCheckedChange={(checked) =>
              void patch({ daemon: { manageBuiltInDaemon: Boolean(checked) } })
            }
            aria-label={t("settings:desktop_manageBuiltInDaemon")}
          />
        }
      />

      <SettingsRow
        id="setting-keep-daemon-running"
        title="settings:desktop_keepRunningAfterQuit"
        description="settings:desktop_keepRunningAfterQuitDescription"
        resetAction={
          settings.daemon?.keepRunningAfterQuit !== DEFAULT_KEEP_RUNNING_AFTER_QUIT ? (
            <SettingResetButton
              label={t("settings:desktop_keepRunningAfterQuit")}
              onClick={() =>
                void patch({ daemon: { keepRunningAfterQuit: DEFAULT_KEEP_RUNNING_AFTER_QUIT } })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={daemonSettings.keepRunningAfterQuit}
            onCheckedChange={(checked) =>
              void patch({ daemon: { keepRunningAfterQuit: Boolean(checked) } })
            }
            aria-label={t("settings:desktop_keepRunningAfterQuit")}
          />
        }
      />

      <SettingsRow
        id="setting-tray-click"
        title="settings:desktop_trayClick"
        description="settings:desktop_trayClickDescription"
        resetAction={
          settings.tray !== DEFAULT_TRAY ? (
            <SettingResetButton
              label={t("settings:desktop_trayClick")}
              onClick={() => void patch({ tray: DEFAULT_TRAY })}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={settings.tray}
            onValueChange={(value) => void patch({ tray: value })}
            ariaLabel={t("settings:desktop_trayClick")}
            options={[
              { value: "window", label: "settings:desktop_trayWindow" },
              { value: "panel", label: "settings:desktop_trayPanel" },
            ]}
          />
        }
      />

      <DesktopOmarchyWidgetRow active={active} />
      <SettingsRow
        id="setting-panel-shortcut"
        title="settings:desktop_panelShortcut"
        description="settings:desktop_panelShortcutDescription"
        resetAction={
          settings.panelShortcut !== DEFAULT_PANEL_SHORTCUT ? (
            <SettingResetButton
              label={t("settings:desktop_panelShortcut")}
              onClick={() => void patch({ panelShortcut: DEFAULT_PANEL_SHORTCUT })}
            />
          ) : null
        }
        control={
          <DebouncedSettingTextInput
            value={settings.panelShortcut}
            onCommit={(value) => void patch({ panelShortcut: value.trim() })}
            placeholder={isMac ? "Cmd+Shift+M" : "Ctrl+Shift+M"}
            aria-label={t("settings:desktop_panelShortcut")}
            className="w-52"
          />
        }
      />
    </SettingsSection>
  );
}

interface OmarchyWidgetStatus {
  readonly supported: boolean;
  readonly enabled: boolean;
}

/**
 * myna's Omarchy bar widget: only offered where Omarchy runs, and only put in
 * when asked. The shell owns the plugin files and the rescan.
 */
function DesktopOmarchyWidgetRow({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const available = desktopShellAvailable();
  const query = useQuery({
    queryKey: ["neolix-desktop-omarchy-widget"],
    queryFn: () => invokeDesktopShellCommand<OmarchyWidgetStatus>("desktop_omarchy_widget_status"),
    enabled: active && available,
    retry: false,
  });

  if (!active || !available || query.data?.supported !== true) return null;

  const setEnabled = async (enabled: boolean) => {
    try {
      await invokeDesktopShellCommand("desktop_set_omarchy_widget", { enabled });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:desktopSettingSaveFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    void query.refetch();
  };

  return (
    <SettingsRow
      id="setting-omarchy-widget"
      title="settings:desktop_omarchyWidget"
      description="settings:desktop_omarchyWidgetDescription"
      control={
        <Switch
          checked={query.data.enabled}
          onCheckedChange={(checked) => void setEnabled(checked === true)}
          aria-label={t("settings:desktop_omarchyWidget")}
        />
      }
    />
  );
}

export function DesktopUpdatePolicySettingsSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { available, settings, patch } = useDesktopShellSettings(active);

  if (!active || !available || !settings) return null;

  return (
    <SettingsSection title="settings:desktop_updatesSection">
      <SettingsRow
        id="setting-update-release-channel"
        title="settings:desktop_releaseChannel"
        description="settings:desktop_releaseChannelDescription"
        resetAction={
          settings.releaseChannel !== DEFAULT_RELEASE_CHANNEL ? (
            <SettingResetButton
              label={t("settings:desktop_releaseChannel")}
              onClick={() => void patch({ releaseChannel: DEFAULT_RELEASE_CHANNEL })}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={settings.releaseChannel}
            onValueChange={(value) => void patch({ releaseChannel: value })}
            ariaLabel={t("settings:desktop_releaseChannel")}
            options={[
              { value: "stable", label: "settings:desktop_channelStable" },
              { value: "beta", label: "settings:desktop_channelBeta" },
            ]}
          />
        }
      />

      <SettingsRow
        id="setting-update-auto-check"
        title="settings:desktop_autoCheck"
        description="settings:desktop_autoCheckDescription"
        resetAction={
          settings.autoCheckUpdates !== DEFAULT_AUTO_CHECK ? (
            <SettingResetButton
              label={t("settings:desktop_autoCheck")}
              onClick={() => void patch({ autoCheckUpdates: DEFAULT_AUTO_CHECK })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoCheckUpdates}
            onCheckedChange={(checked) => void patch({ autoCheckUpdates: Boolean(checked) })}
            aria-label={t("settings:desktop_autoCheck")}
          />
        }
      />

      {settings.autoCheckUpdates ? (
        <SettingsRow
          id="setting-update-interval"
          title="settings:desktop_updateInterval"
          description="settings:desktop_updateIntervalDescription"
          resetAction={
            settings.updateCheckMinutes !== DEFAULT_UPDATE_MINUTES ? (
              <SettingResetButton
                label={t("settings:desktop_updateInterval")}
                onClick={() => void patch({ updateCheckMinutes: DEFAULT_UPDATE_MINUTES })}
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={String(settings.updateCheckMinutes)}
              onValueChange={(value) => void patch({ updateCheckMinutes: Number(value) })}
              ariaLabel={t("settings:desktop_updateInterval")}
              options={UPDATE_INTERVAL_OPTIONS}
            />
          }
        />
      ) : null}

      <SettingsRow
        id="setting-update-auto-download"
        title="settings:desktop_autoDownload"
        description="settings:desktop_autoDownloadDescription"
        resetAction={
          settings.autoDownloadUpdates !== DEFAULT_AUTO_DOWNLOAD ? (
            <SettingResetButton
              label={t("settings:desktop_autoDownload")}
              onClick={() => void patch({ autoDownloadUpdates: DEFAULT_AUTO_DOWNLOAD })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoDownloadUpdates}
            onCheckedChange={(checked) => void patch({ autoDownloadUpdates: Boolean(checked) })}
            aria-label={t("settings:desktop_autoDownload")}
          />
        }
      />

      <SettingsRow
        id="setting-update-auto-restart"
        title="settings:desktop_autoRestart"
        description="settings:desktop_autoRestartDescription"
        resetAction={
          settings.autoRestartOnUpdate !== DEFAULT_AUTO_RESTART ? (
            <SettingResetButton
              label={t("settings:desktop_autoRestart")}
              onClick={() => void patch({ autoRestartOnUpdate: DEFAULT_AUTO_RESTART })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.autoRestartOnUpdate}
            onCheckedChange={(checked) => void patch({ autoRestartOnUpdate: Boolean(checked) })}
            aria-label={t("settings:desktop_autoRestart")}
          />
        }
      />
      <SettingsRow
        id="setting-update-mirror"
        title="settings:desktop_updateMirror"
        description="settings:desktop_updateMirrorDescription"
        resetAction={
          settings.updateMirror !== DEFAULT_UPDATE_MIRROR ? (
            <SettingResetButton
              label={t("settings:desktop_updateMirror")}
              onClick={() => void patch({ updateMirror: DEFAULT_UPDATE_MIRROR })}
            />
          ) : null
        }
        control={
          <DebouncedSettingTextInput
            value={settings.updateMirror}
            onCommit={(value) => {
              const trimmed = value.trim();
              if (trimmed !== "" && !/^https?:\/\//i.test(trimmed)) {
                toastManager.add({
                  type: "error",
                  title: t("settings:desktop_updateMirrorInvalid"),
                });
                return;
              }
              void patch({ updateMirror: trimmed });
            }}
            placeholder="https://mirror.example.com"
            aria-label={t("settings:desktop_updateMirror")}
            className="w-52"
          />
        }
      />

      <SettingsRow
        id="setting-update-hide-pill"
        title="settings:desktop_noUpdatePill"
        description="settings:desktop_noUpdatePillDescription"
        resetAction={
          settings.noUpdatePill !== DEFAULT_NO_UPDATE_PILL ? (
            <SettingResetButton
              label={t("settings:desktop_noUpdatePill")}
              onClick={() => void patch({ noUpdatePill: DEFAULT_NO_UPDATE_PILL })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.noUpdatePill}
            onCheckedChange={(checked) => void patch({ noUpdatePill: Boolean(checked) })}
            aria-label={t("settings:desktop_noUpdatePill")}
          />
        }
      />
    </SettingsSection>
  );
}

/** Notification sound lives with the shell's other notification preferences. */
export function DesktopNotificationSoundRow({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { available, settings, patch } = useDesktopShellSettings(active);
  if (!active || !available || !settings) return null;
  return (
    <SettingsRow
      id="setting-notification-sound"
      title="settings:desktop_notificationSound"
      description="settings:desktop_notificationSoundDescription"
      control={
        <Switch
          checked={settings.notifications.playSound}
          onCheckedChange={(checked) =>
            void patch({ notifications: { playSound: Boolean(checked) } })
          }
          aria-label={t("settings:desktop_notificationSound")}
        />
      }
    />
  );
}

interface CliInstallStatus {
  readonly installed: boolean;
}

/**
 * Installs the `neolix` command into the user's PATH. The shell owns the shim;
 * a plain browser has nothing to install, so the row renders nothing there.
 * About and Desktop › Developer tools show the same row.
 */
export function DesktopCommandLineSettingsRow({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const available = desktopShellAvailable();
  const [status, setStatus] = useState<CliInstallStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active || !available) return;
    let disposed = false;
    void invokeDesktopShellCommand<CliInstallStatus>("get_cli_install_status")
      .then((next) => {
        if (!disposed) setStatus(next);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [active, available]);

  if (!active || !available) return null;

  const run = async (command: "install_cli" | "uninstall_cli") => {
    setBusy(true);
    const successTitle =
      command === "install_cli"
        ? t("settings:desktop_cliInstalled")
        : t("settings:desktop_cliUninstalled");
    try {
      const next = await invokeDesktopShellCommand<CliInstallStatus>(command);
      setStatus(next);
      toastManager.add({
        type: "success",
        title: successTitle,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:desktop_cliInstallFailed"),
        description: errorMessage(error),
      });
    }
    setBusy(false);
  };

  return (
    <SettingsRow
      id="setting-command-line-tool"
      title={t("settings:desktop_cli")}
      description={t("settings:desktop_cliDescription")}
      status={
        status === null
          ? t("settings:host_loading")
          : status.installed
            ? t("settings:desktop_cliInstalledStatus")
            : t("settings:desktop_cliNotInstalled")
      }
      control={
        <Button
          size="xs"
          variant="outline"
          disabled={busy || status === null}
          onClick={() => void run(status?.installed ? "uninstall_cli" : "install_cli")}
        >
          {busy
            ? t("settings:host_loading")
            : status?.installed
              ? t("settings:desktop_uninstall")
              : t("settings:desktop_install")}
        </Button>
      }
    />
  );
}

export function DesktopCliSettingsSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  if (!active || !desktopShellAvailable()) return null;
  return (
    <SettingsSection title={t("settings:desktop_developerTools")}>
      <DesktopCommandLineSettingsRow active={active} />
    </SettingsSection>
  );
}

/**
 * What the menu bar shows. The shell's own poller reads these preferences, so
 * the rows only write settings; a browser has no tray and renders nothing.
 */
export function DesktopTraySettingsSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const platform = desktopShellPlatform();
  const shellAvailable = desktopShellAvailable();
  const { available, settings, patch } = useDesktopShellSettings(active && shellAvailable);
  const quota = useQuery({
    queryKey: ["neolix-gateway", "quota", "tray"],
    queryFn: () => neolixGatewayApi.getQuota({ historyDays: 2 }),
    enabled: active && shellAvailable,
    staleTime: 60_000,
    retry: false,
  });

  if (!active || !available || !settings) return null;

  const selected = settings.trayUsages ?? DEFAULT_TRAY_USAGES;
  const trayWindowsSetting = settings.trayWindows ?? {};
  const trayUsageEvery = settings.trayUsageEvery ?? DEFAULT_TRAY_USAGE_EVERY;
  const trayDisplayAs = settings.trayDisplayAs ?? DEFAULT_TRAY_DISPLAY_AS;
  const trayCurrency = settings.trayCurrency ?? DEFAULT_TRAY_CURRENCY;
  const trayNumberUnits = settings.trayNumberUnits ?? DEFAULT_TRAY_NUMBER_UNITS;
  const accounts = (quota.data?.quota.accounts ?? []).map((account) => ({
    id: account.id,
    label:
      account.accountLabel.trim() === "" || account.accountLabel === account.providerLabel
        ? account.providerLabel
        : `${account.providerLabel} · ${account.accountLabel}`,
    windows: account.windows.filter((window) => window.usedPercent !== null),
  }));
  const selectedAccounts = accounts.filter((account) => selected.includes(account.id));
  const toggleUsage = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((candidate) => candidate !== id)
      : [...selected, id];
    void patch({ trayUsages: next });
  };
  const toggleWindow = (accountId: string, windowId: string) => {
    const current = trayWindowsSetting[accountId] ?? [];
    const next = current.includes(windowId)
      ? current.filter((candidate) => candidate !== windowId)
      : [...current, windowId];
    const trayWindows: Record<string, ReadonlyArray<string>> = { ...trayWindowsSetting };
    if (next.length === 0) {
      delete trayWindows[accountId];
    } else {
      trayWindows[accountId] = next;
    }
    void patch({ trayWindows });
  };

  return (
    <SettingsSection title={t("settings:desktop_traySection")}>
      <SettingsRow
        id="setting-tray-usages"
        title={t("settings:desktop_trayUsages")}
        description={t("settings:desktop_trayUsagesDescription")}
        status={quota.error ? String(quota.error) : undefined}
        control={
          <div className="flex max-w-xl flex-wrap justify-end gap-1.5">
            {TRAY_TOTAL_IDS.map((id) => (
              <Button
                key={id}
                size="xs"
                variant={selected.includes(id) ? "default" : "outline"}
                onClick={() => toggleUsage(id)}
              >
                {id === "usage:today"
                  ? t("settings:desktop_trayToday")
                  : t("settings:desktop_trayLast7Days")}
              </Button>
            ))}
            {accounts.map((account) => (
              <Button
                key={account.id}
                size="xs"
                variant={selected.includes(account.id) ? "default" : "outline"}
                onClick={() => toggleUsage(account.id)}
              >
                {account.label}
              </Button>
            ))}
          </div>
        }
      />

      {selectedAccounts.map((account) => (
        <SettingsRow
          key={account.id}
          id={`setting-tray-windows-${account.id}`}
          title={t("settings:desktop_trayWindows")}
          description={t("settings:desktop_trayWindowsDescription")}
          control={
            <div className="flex max-w-xl flex-wrap justify-end gap-1.5">
              {account.windows.map((window) => (
                <Button
                  key={window.id}
                  size="xs"
                  variant={
                    (trayWindowsSetting[account.id] ?? []).includes(window.id)
                      ? "default"
                      : "outline"
                  }
                  onClick={() => toggleWindow(account.id, window.id)}
                >
                  {window.id}
                </Button>
              ))}
            </div>
          }
        />
      ))}

      {selected.length > 0 ? (
        <SettingsRow
          id="setting-tray-refresh"
          title={t("settings:desktop_trayRefresh")}
          description={t("settings:desktop_trayRefreshDescription")}
          control={
            <SettingsSegmentedControl
              value={String(trayUsageEvery)}
              onValueChange={(value) => void patch({ trayUsageEvery: Number(value) })}
              ariaLabel={t("settings:desktop_trayRefresh")}
              options={TRAY_USAGE_EVERY_OPTIONS}
            />
          }
        />
      ) : null}

      <SettingsRow
        id="setting-tray-display-as"
        title={t("settings:desktop_trayDisplayAs")}
        description={t("settings:desktop_trayDisplayAsDescription")}
        control={
          <SettingsSegmentedControl
            value={trayDisplayAs}
            onValueChange={(value) => void patch({ trayDisplayAs: value })}
            ariaLabel={t("settings:desktop_trayDisplayAs")}
            options={[
              { value: "used", label: t("settings:desktop_used") },
              { value: "remaining", label: t("settings:desktop_remaining") },
            ]}
          />
        }
      />

      <SettingsRow
        id="setting-tray-currency"
        title={t("settings:desktop_trayCurrency")}
        description={t("settings:desktop_trayCurrencyDescription")}
        control={
          <SettingsSegmentedControl
            value={trayCurrency}
            onValueChange={(value) => void patch({ trayCurrency: value })}
            ariaLabel={t("settings:desktop_trayCurrency")}
            options={[
              { value: "usd", label: "USD" },
              { value: "cny", label: "CNY" },
            ]}
          />
        }
      />

      <SettingsRow
        id="setting-tray-units"
        title={t("settings:desktop_trayUnits")}
        description={t("settings:desktop_trayUnitsDescription")}
        control={
          <SettingsSegmentedControl
            value={trayNumberUnits}
            onValueChange={(value) => void patch({ trayNumberUnits: value })}
            ariaLabel={t("settings:desktop_trayUnits")}
            options={[
              { value: "compact", label: t("settings:desktop_compact") },
              { value: "wan", label: t("settings:desktop_wan") },
            ]}
          />
        }
      />

      {platform === "darwin" && selected.length > 0 ? (
        <>
          <SettingsRow
            id="setting-tray-logos"
            title={t("settings:desktop_trayLogos")}
            description={t("settings:desktop_trayLogosDescription")}
            control={
              <Switch
                checked={!settings.trayNoLogos}
                onCheckedChange={(checked) => void patch({ trayNoLogos: !checked })}
                aria-label={t("settings:desktop_trayLogos")}
              />
            }
          />
          <SettingsRow
            id="setting-tray-icon"
            title={t("settings:desktop_trayIcon")}
            description={t("settings:desktop_trayIconDescription")}
            control={
              <Switch
                checked={!settings.trayNoBird}
                onCheckedChange={(checked) => void patch({ trayNoBird: !checked })}
                aria-label={t("settings:desktop_trayIcon")}
              />
            }
          />
        </>
      ) : null}

      {platform !== "win32" && selected.length > 0 ? (
        <SettingsRow
          id="setting-tray-pace"
          title={t("settings:desktop_trayPace")}
          description={t("settings:desktop_trayPaceDescription")}
          control={
            <Switch
              checked={settings.trayPace}
              onCheckedChange={(checked) => void patch({ trayPace: checked === true })}
              aria-label={t("settings:desktop_trayPace")}
            />
          }
        />
      ) : null}

      <SettingsRow
        id="setting-tray-cost"
        title={t("settings:desktop_trayCost")}
        description={t("settings:desktop_trayCostDescription")}
        control={
          <Switch
            checked={!settings.trayNoCost}
            onCheckedChange={(checked) => void patch({ trayNoCost: !checked })}
            aria-label={t("settings:desktop_trayCost")}
          />
        }
      />

      {platform === "win32" && selected.length > 0 ? (
        <SettingsRow
          id="setting-tray-number"
          title={t("settings:desktop_trayNumber")}
          description={t("settings:desktop_trayNumberDescription")}
          control={
            <Switch
              checked={!settings.trayNoNumber}
              onCheckedChange={(checked) => void patch({ trayNoNumber: !checked })}
              aria-label={t("settings:desktop_trayNumber")}
            />
          }
        />
      ) : null}
    </SettingsSection>
  );
}
