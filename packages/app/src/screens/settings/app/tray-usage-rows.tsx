import { useCallback, useMemo } from "react";
/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- settings rows: closures over the row's account or window, none of them in a hot list. */
import { useTranslation } from "react-i18next";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsRow, SettingsSwitch } from "@/components/settings";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getIsElectron } from "@/constants/platform";
import {
  TRAY_USAGE_EVERIES,
  useDesktopSettings,
  type DesktopSettingsPatch,
} from "@/desktop/settings/desktop-settings";
import { useGatewayQuota } from "@/screens/settings/gateway/usage-data";
import { useSettingsHostServerId } from "./shared";
import type { Theme } from "@/styles/theme";

/**
 * Myna's menu-bar allowance rows (Settings › Allowances, index.html:263-291).
 * The menu bar itself is the desktop app's; these rows pick what it shows.
 */

type TrayPlatform = "mac" | "windows" | "other";

function trayPlatform(): TrayPlatform {
  if (typeof navigator === "undefined") {
    return "other";
  }
  const agent = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(agent)) {
    return "mac";
  }
  return /Windows/.test(agent) ? "windows" : "other";
}

const TOTAL_IDS = ["usage:today", "usage:7d"] as const;

export function TrayUsageRows() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useDesktopSettings();
  const serverId = useSettingsHostServerId();
  const { quota } = useGatewayQuota({
    serverId: serverId ?? "",
    trend: "off",
    refreshMs: 0,
  });
  const accounts = useMemo(() => quota?.accounts ?? [], [quota]);
  const platform = trayPlatform();
  const selected = settings.trayUsages;

  const patch = useCallback(
    (updates: DesktopSettingsPatch) => void updateSettings(updates),
    [updateSettings],
  );
  const toggleUsage = useCallback(
    (id: string) => {
      const next = selected.includes(id)
        ? selected.filter((candidate) => candidate !== id)
        : [...selected, id];
      patch({ trayUsages: next });
    },
    [patch, selected],
  );
  const toggleWindow = useCallback(
    (accountId: string, windowId: string) => {
      const current = settings.trayWindows[accountId] ?? [];
      const next = current.includes(windowId)
        ? current.filter((candidate) => candidate !== windowId)
        : [...current, windowId];
      const trayWindows = { ...settings.trayWindows };
      if (next.length === 0) {
        delete trayWindows[accountId];
      } else {
        trayWindows[accountId] = next;
      }
      patch({ trayWindows });
    },
    [patch, settings.trayWindows],
  );

  const accountOptions = useMemo(
    () =>
      accounts.map((account) => ({
        id: account.id,
        label:
          account.accountLabel.trim() === "" || account.accountLabel === account.providerLabel
            ? account.providerLabel
            : `${account.providerLabel} · ${account.accountLabel}`,
        windows: account.windows.filter((window) => window.usedPercent !== null),
      })),
    [accounts],
  );
  const selectedAccounts = accountOptions.filter((account) => selected.includes(account.id));
  const refreshOptions = useMemo(
    () => TRAY_USAGE_EVERIES.map((minutes) => ({ value: String(minutes), label: String(minutes) })),
    [],
  );

  if (!getIsElectron()) {
    return null;
  }

  return (
    <>
      <SettingsRow
        label={t("trayUsage.menuBar")}
        hint={t("trayUsage.menuBarHint")}
        testID="settings-tray-usages"
      >
        <View style={styles.chips}>
          {TOTAL_IDS.map((id) => (
            <ToggleChip
              key={id}
              label={t(id === "usage:today" ? "trayUsage.today" : "trayUsage.last7Days")}
              selected={selected.includes(id)}
              onPress={() => toggleUsage(id)}
            />
          ))}
          {accountOptions.map((account) => (
            <ToggleChip
              key={account.id}
              label={account.label}
              selected={selected.includes(account.id)}
              onPress={() => toggleUsage(account.id)}
            />
          ))}
        </View>
      </SettingsRow>

      {selectedAccounts.map((account) => (
        <SettingsRow
          key={account.id}
          label={t("trayUsage.windows")}
          hint={t("trayUsage.windowsHint")}
        >
          <View style={styles.chips}>
            {account.windows.map((window) => (
              <ToggleChip
                key={window.id}
                label={window.id}
                selected={(settings.trayWindows[account.id] ?? []).includes(window.id)}
                onPress={() => toggleWindow(account.id, window.id)}
              />
            ))}
          </View>
        </SettingsRow>
      ))}

      {selected.length > 0 ? (
        <SettingsRow label={t("trayUsage.refresh")} hint={t("trayUsage.refreshHint")}>
          <SegmentedControl
            options={refreshOptions}
            value={String(settings.trayUsageEvery)}
            onValueChange={(value) => patch({ trayUsageEvery: Number(value) })}
            size="sm"
          />
        </SettingsRow>
      ) : null}

      {platform === "mac" && selected.length > 0 ? (
        <>
          <SettingsSwitch
            label={t("trayUsage.logos")}
            hint={t("trayUsage.logosHint")}
            value={!settings.trayNoLogos}
            onValueChange={(enabled) => patch({ trayNoLogos: !enabled })}
          />
          <SettingsSwitch
            label={t("trayUsage.icon")}
            hint={t("trayUsage.iconHint")}
            value={!settings.trayNoBird}
            onValueChange={(enabled) => patch({ trayNoBird: !enabled })}
          />
        </>
      ) : null}

      {platform !== "windows" && selected.length > 0 ? (
        <SettingsSwitch
          label={t("trayUsage.pace")}
          hint={t("trayUsage.paceHint")}
          value={settings.trayPace}
          onValueChange={(enabled) => patch({ trayPace: enabled })}
        />
      ) : null}

      <SettingsSwitch
        label={t("trayUsage.cost")}
        hint={t("trayUsage.costHint")}
        value={!settings.trayNoCost}
        onValueChange={(enabled) => patch({ trayNoCost: !enabled })}
      />

      {platform === "windows" && selected.length > 0 ? (
        <SettingsSwitch
          label={t("trayUsage.number")}
          hint={t("trayUsage.numberHint")}
          value={!settings.trayNoNumber}
          onValueChange={(enabled) => patch({ trayNoNumber: !enabled })}
        />
      ) : null}
    </>
  );
}

function ToggleChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const chipStyle = useMemo(() => [styles.chip, selected && styles.chipSelected], [selected]);
  const labelStyle = useMemo(
    () => [styles.chipLabel, selected && styles.chipLabelSelected],
    [selected],
  );
  return (
    <PressHighlight
      onPress={onPress}
      style={chipStyle}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={labelStyle}>{label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    justifyContent: "flex-end",
    maxWidth: 420,
  },
  chip: {
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: 999,
  },
  chipSelected: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface3,
  },
  chipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chipLabelSelected: {
    color: theme.colors.foreground,
  },
}));
