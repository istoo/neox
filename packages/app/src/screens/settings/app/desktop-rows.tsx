import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isElectronRuntimeMac } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import {
  useDesktopSettings,
  type PreventSleepMode,
  type TrayClickAction,
} from "@/desktop/settings/desktop-settings";
import { normalizePanelShortcut } from "@/desktop/system/panel-shortcut";

const SLEEP_MODES: readonly PreventSleepMode[] = ["off", "on", "display"];
const TRAY_CLICKS: readonly TrayClickAction[] = ["window", "panel"];

/**
 * The desktop-only rows myna keeps in General: prevent sleep, open at login,
 * show in Dock (macOS) and ask before quitting. Each one changes the operating
 * system through the Electron main process.
 */
export function DesktopSystemRows() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useDesktopSettings();
  const isMac = isElectronRuntimeMac();

  const sleepOptions = useMemo<SegmentedControlOption<PreventSleepMode>[]>(
    () =>
      SLEEP_MODES.map((value) => ({
        value,
        label: t(`settings.pages.general.sleep.${value}`),
      })),
    [t],
  );

  const setPreventSleep = useCallback(
    (preventSleep: PreventSleepMode) => void updateSettings({ preventSleep }),
    [updateSettings],
  );
  const setLaunchAtLogin = useCallback(
    (launchAtLogin: boolean) => void updateSettings({ launchAtLogin }),
    [updateSettings],
  );
  const setDockVisible = useCallback(
    (dockVisible: boolean) => void updateSettings({ dockVisible }),
    [updateSettings],
  );
  const setConfirmQuit = useCallback(
    (confirmQuit: boolean) => void updateSettings({ confirmQuit }),
    [updateSettings],
  );
  const setLightweightMode = useCallback(
    (lightweightMode: boolean) => void updateSettings({ lightweightMode }),
    [updateSettings],
  );
  const setTrayClick = useCallback(
    (tray: TrayClickAction) => void updateSettings({ tray }),
    [updateSettings],
  );
  const shortcutInput = useRef<EditingTextInputHandle>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const handleShortcutChange = useCallback(() => {
    setShortcutError((current) => (current === null ? current : null));
  }, []);
  const commitShortcut = useCallback(() => {
    const normalized = normalizePanelShortcut(
      shortcutInput.current?.getText() ?? "",
      isMac ? "darwin" : "linux",
    );
    if (!normalized.valid) {
      setShortcutError(t("settings.pages.general.panelShortcutInvalid"));
      return;
    }
    setShortcutError(null);
    if ((normalized.accelerator ?? "") !== settings.panelShortcut) {
      void updateSettings({ panelShortcut: normalized.accelerator ?? "" });
    }
  }, [isMac, settings.panelShortcut, t, updateSettings]);

  const trayOptions = useMemo<SegmentedControlOption<TrayClickAction>[]>(
    () =>
      TRAY_CLICKS.map((value) => ({
        value,
        label: t(`settings.pages.general.trayClick.${value}`),
      })),
    [t],
  );

  return (
    <SettingsSection title={t("settings.pages.general.desktopSection")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.pages.general.preventSleep")}
          hint={t("settings.pages.general.preventSleepHint")}
        >
          <SegmentedControl
            value={settings.preventSleep}
            onValueChange={setPreventSleep}
            options={sleepOptions}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("settings.pages.general.launchAtLogin")}
          hint={t("settings.pages.general.launchAtLoginHint")}
          value={settings.launchAtLogin}
          onValueChange={setLaunchAtLogin}
        />
        {isMac ? (
          <SettingsSwitch
            label={t("settings.pages.general.dockVisible")}
            hint={t("settings.pages.general.dockVisibleHint")}
            value={settings.dockVisible}
            onValueChange={setDockVisible}
          />
        ) : null}
        <SettingsSwitch
          label={t("settings.pages.general.confirmQuit")}
          hint={t("settings.pages.general.confirmQuitHint")}
          value={settings.confirmQuit}
          onValueChange={setConfirmQuit}
        />
        <SettingsSwitch
          label={t("lightweightMode.label")}
          hint={t("lightweightMode.hint")}
          value={settings.lightweightMode}
          onValueChange={setLightweightMode}
          testID="settings-lightweight-mode"
        />
        <OmarchyWidgetRow />
        <SettingsRow
          label={t("settings.pages.general.trayClick.label")}
          hint={t("settings.pages.general.trayClick.hint")}
        >
          <SegmentedControl
            value={settings.tray}
            onValueChange={setTrayClick}
            options={trayOptions}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.general.panelShortcut")}
          hint={t("settings.pages.general.panelShortcutHint")}
          error={shortcutError ?? undefined}
        >
          <EditingTextInput
            key={settings.panelShortcut}
            ref={shortcutInput}
            initialValue={settings.panelShortcut}
            placeholder={isMac ? "Cmd+Shift+M" : "Ctrl+Shift+M"}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={handleShortcutChange}
            onBlur={commitShortcut}
            onSubmitEditing={commitShortcut}
            style={styles.shortcutInput}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

interface OmarchyWidgetStatus {
  supported: boolean;
  enabled: boolean;
}

/**
 * myna's Omarchy bar widget (omarchy/widget.go): offered only where Omarchy
 * runs, and put in only when asked.
 */
function OmarchyWidgetRow() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<OmarchyWidgetStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await invokeDesktopCommand<unknown>("desktop_omarchy_widget_status");
        if (cancelled || typeof raw !== "object" || raw === null) {
          return;
        }
        const record = raw as Record<string, unknown>;
        setStatus({ supported: record.supported === true, enabled: record.enabled === true });
      } catch {
        // Not an Omarchy host, or an older desktop build: no row.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setStatus((current) => (current ? { ...current, enabled } : current));
    const save = async () => {
      try {
        const raw = await invokeDesktopCommand<unknown>("desktop_set_omarchy_widget", { enabled });
        if (typeof raw !== "object" || raw === null) {
          return;
        }
        const record = raw as Record<string, unknown>;
        setStatus({ supported: record.supported === true, enabled: record.enabled === true });
      } catch {
        setStatus((current) => (current ? { ...current, enabled: !enabled } : current));
      }
    };
    void save();
  }, []);

  if (!status?.supported) {
    return null;
  }
  return (
    <SettingsSwitch
      label={t("settings.pages.general.omarchyWidget")}
      hint={t("settings.pages.general.omarchyWidgetHint")}
      value={status.enabled}
      onValueChange={setEnabled}
    />
  );
}

const styles = StyleSheet.create({
  shortcutInput: {
    minWidth: 200,
  },
});
