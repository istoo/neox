import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useAppSettings, type GatewayMode } from "@/hooks/use-settings";
import { useGatewayMode, type GatewayModeReason } from "./gateway-mode";

const MODES: readonly GatewayMode[] = ["auto", "on", "off"];

const REASON_KEYS: Record<GatewayModeReason, string> = {
  "pinned-on": "settings.pages.general.gatewayReasonOn",
  "pinned-off": "settings.pages.general.gatewayReasonOff",
  flag: "settings.pages.general.gatewayReasonFlag",
  "no-agents": "settings.pages.general.gatewayReasonNoAgents",
  agents: "settings.pages.general.gatewayReasonAgents",
  checking: "settings.pages.general.gatewayReasonChecking",
};

/** myna's Gateway mode switch: Automatic, On or Off. */
export function GatewayModeRow() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const state = useGatewayMode();
  const options = useMemo<SegmentedControlOption<GatewayMode>[]>(
    () =>
      MODES.map((value) => ({
        value,
        label: t(`settings.pages.general.gatewayMode.${value}`),
      })),
    [t],
  );
  const change = useCallback(
    (gatewayMode: GatewayMode) => void updateSettings({ gatewayMode }),
    [updateSettings],
  );
  // myna's renderGatewayMode only appends the current state while the setting
  // is Automatic; an explicit on/off speaks for itself.
  const base = t("settings.pages.general.gatewayMode.hint");
  const hint = settings.gatewayMode === "auto" ? `${base} · ${t(REASON_KEYS[state.reason])}` : base;
  return (
    <SettingsRow label={t("settings.pages.general.gatewayMode.label")} hint={hint}>
      <SegmentedControl
        options={options}
        value={settings.gatewayMode}
        onValueChange={change}
        testID="settings-gateway-mode"
      />
    </SettingsRow>
  );
}
