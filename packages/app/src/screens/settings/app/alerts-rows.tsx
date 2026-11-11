import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsRow, SettingsSwitch } from "@/components/settings";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { useAppSettings } from "@/hooks/use-settings";
import { useUsageAlertSettings } from "@/usage/alert-settings";
import { useGatewayMode } from "./gateway-mode";
import { useSettingsHostServerId } from "./shared";

const RESET_HOURS = ["0", "12", "24", "48"] as const;
type ResetHoursOption = (typeof RESET_HOURS)[number];
const DEFAULT_USAGE_ALERT = 80;
const DEFAULT_BALANCE_ALERT = 5;

/** myna's allowance alert (share used) and renewal reminder rows. */
export function UsageAlertRows() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const { usageAlertPercent, setUsageAlertPercent } =
    useUsageAlertSettings(useSettingsHostServerId());
  const gatewayMode = useGatewayMode();
  const [percentDraft, setPercentDraft] = useState("");
  const percentInput = useRef<EditingTextInputHandle>(null);
  const isOn = usageAlertPercent > 0;

  useEffect(() => {
    setPercentDraft(String(usageAlertPercent || DEFAULT_USAGE_ALERT));
  }, [usageAlertPercent]);

  const toggleUsageAlert = useCallback(
    (on: boolean) => setUsageAlertPercent(on ? DEFAULT_USAGE_ALERT : 0),
    [setUsageAlertPercent],
  );

  const commitPercent = useCallback(() => {
    const parsed = Number.parseInt(percentInput.current?.getText() ?? percentDraft, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
      percentInput.current?.replaceText(String(usageAlertPercent));
      return;
    }
    if (parsed !== usageAlertPercent) {
      setUsageAlertPercent(parsed);
    }
  }, [percentDraft, setUsageAlertPercent, usageAlertPercent]);

  const resetOptions = useMemo<SegmentedControlOption<ResetHoursOption>[]>(
    () =>
      RESET_HOURS.map((value) => ({
        value,
        label:
          value === "0"
            ? t("settings.pages.quota.off")
            : t("settings.pages.quota.hoursBefore", { count: Number(value) }),
      })),
    [t],
  );
  const setResetHours = useCallback(
    (value: ResetHoursOption) => void updateSettings({ resetReminderHours: Number(value) }),
    [updateSettings],
  );

  const selectedReset =
    RESET_HOURS.find((value) => Number(value) === settings.resetReminderHours) ?? "0";
  // Gateway mode leaves out the alerts this computer's own agents would raise.
  if (gatewayMode.enabled) {
    return null;
  }
  return (
    <>
      <SettingsSwitch
        label={t("settings.pages.quota.usageAlert")}
        hint={t("settings.pages.quota.usageAlertHint")}
        value={isOn}
        onValueChange={toggleUsageAlert}
      />
      {isOn ? (
        <SettingsRow label={t("settings.pages.quota.usageAlertShare")}>
          <TextInput
            ref={percentInput}
            initialValue={percentDraft}
            onChangeText={setPercentDraft}
            onBlur={commitPercent}
            onSubmitEditing={commitPercent}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            style={styles.percentInput}
            accessibilityLabel={t("settings.pages.quota.usageAlertShare")}
          />
        </SettingsRow>
      ) : null}
      <SettingsRow
        label={t("settings.pages.quota.resetReminder")}
        hint={t("settings.pages.quota.resetReminderHint")}
      >
        <SegmentedControl
          value={selectedReset}
          onValueChange={setResetHours}
          options={resetOptions}
        />
      </SettingsRow>
      <BalanceAlertRow />
    </>
  );
}

/** myna's balance alert: the amount a key's own balance falls to, in its own unit. */
function BalanceAlertRow() {
  const { t } = useTranslation();
  const { balanceAlert, setBalanceAlert } = useUsageAlertSettings(useSettingsHostServerId());
  const [draft, setDraft] = useState("");
  const input = useRef<EditingTextInputHandle>(null);
  const isOn = balanceAlert > 0;

  useEffect(() => {
    setDraft(String(balanceAlert || DEFAULT_BALANCE_ALERT));
  }, [balanceAlert]);

  const toggle = useCallback(
    (on: boolean) => setBalanceAlert(on ? DEFAULT_BALANCE_ALERT : 0),
    [setBalanceAlert],
  );

  const commit = useCallback(() => {
    const parsed = Number.parseFloat(input.current?.getText() ?? draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      input.current?.replaceText(String(balanceAlert));
      return;
    }
    if (parsed !== balanceAlert) {
      setBalanceAlert(parsed);
    }
  }, [balanceAlert, draft, setBalanceAlert]);

  return (
    <>
      <SettingsSwitch
        label={t("settings.pages.quota.balanceAlert")}
        hint={t("settings.pages.quota.balanceAlertHint")}
        value={isOn}
        onValueChange={toggle}
      />
      {isOn ? (
        <SettingsRow
          label={t("settings.pages.quota.balanceAlertAmount")}
          hint={t("settings.pages.quota.balanceAlertAmountHint")}
        >
          <TextInput
            ref={input}
            initialValue={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            keyboardType="decimal-pad"
            inputMode="decimal"
            selectTextOnFocus
            style={styles.percentInput}
            accessibilityLabel={t("settings.pages.quota.balanceAlertAmount")}
          />
        </SettingsRow>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  percentInput: {
    minWidth: 72,
    textAlign: "right",
    color: theme.colors.foreground,
  },
}));
