import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useHosts } from "@/runtime/host-runtime";
import { getIsElectron } from "@/constants/platform";
import { useAppSettings, type DisplayCurrency, type NumberUnits } from "@/hooks/use-settings";
import { useUsageDisplay } from "@/usage/display";
import { useUsageInSidebar } from "@/usage/in-sidebar";
import { useUsageSetting } from "@/usage/setting";
import type { UsageDisplayAs } from "@/usage/preferences";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { SettingsLinkRow, useSettingsHostServerId, useSettingsNavigate } from "./shared";
import { useBuiltinFeatureEnabled } from "@/plugins/builtin-features";
import { UsageAlertRows } from "./alerts-rows";
import { TrayUsageRows } from "./tray-usage-rows";
import { CodexResetRows } from "./codex-reset-rows";
import { TurnDoneAlertRow, WarmupRows } from "./gateway-option-rows";
import { useGatewayMode } from "./gateway-mode";

/**
 * Settings › Allowances. The menu-bar rows are myna's (index.html:263-291):
 * which allowances the tray shows and how it draws them. The rest are the
 * usage preferences Neolix has (host usage reading, the sidebar summary, used
 * vs remaining) and a way into the usage page.
 */
export function QuotaPage({
  serverId: serverIdOverride,
  onOpenUsage,
}: {
  /** The host the Models & quota page is showing. */
  serverId?: string | null;
  /** Opens the app-wide Usage modal instead of navigating to a host page. */
  onOpenUsage?: () => void;
} = {}) {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const selectedServerId = useSettingsHostServerId();
  const serverId = serverIdOverride === undefined ? selectedServerId : serverIdOverride;
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const usageSetting = useUsageSetting(serverId);
  const { inSidebar, setInSidebar } = useUsageInSidebar();
  const { display } = useUsageDisplay([]);
  const { settings: appSettings, updateSettings } = useAppSettings();
  const { config: gatewayConfig, save: saveGatewayConfig } = useGatewayConfig(serverId);
  const gatewayMode = useGatewayMode();
  const warmupsOn = useBuiltinFeatureEnabled(serverId, "warmups");
  const middlewareOn = useBuiltinFeatureEnabled(serverId, "middleware");

  const numberUnitOptions = useMemo<SegmentedControlOption<NumberUnits>[]>(
    () => [
      { value: "compact", label: t("settings.pages.quota.unitsCompact") },
      { value: "wan", label: t("settings.pages.quota.unitsWan") },
    ],
    [t],
  );
  const setNumberUnits = useCallback(
    (numberUnits: NumberUnits) => void updateSettings({ numberUnits }),
    [updateSettings],
  );

  const currencyOptions = useMemo<SegmentedControlOption<DisplayCurrency>[]>(
    () => [
      { value: "usd", label: t("settings.pages.quota.currencyUsd") },
      { value: "cny", label: t("settings.pages.quota.currencyCny") },
    ],
    [t],
  );
  const setCurrency = useCallback(
    (currency: DisplayCurrency) => void updateSettings({ currency }),
    [updateSettings],
  );

  const displayAsOptions = useMemo<SegmentedControlOption<UsageDisplayAs>[]>(
    () => [
      { value: "used", label: t("providerUsage.displayUsed"), testID: "quota-display-used" },
      {
        value: "remaining",
        label: t("providerUsage.displayRemaining"),
        testID: "quota-display-remaining",
      },
    ],
    [t],
  );

  const readsOptions = useMemo(
    () => [
      { value: "auto", label: t("settings.pages.quota.quotaReadsAuto") },
      { value: "asked", label: t("settings.pages.quota.quotaReadsAsked") },
    ],
    [t],
  );
  const quotaReads = gatewayConfig?.quotaReads === "asked" ? "asked" : "auto";
  const setQuotaReads = useCallback(
    (value: string) => {
      if (gatewayConfig === null) {
        return;
      }
      const { quotaReads: _quotaReads, ...rest } = gatewayConfig;
      void saveGatewayConfig(value === "asked" ? { ...rest, quotaReads: "asked" } : rest);
    },
    [gatewayConfig, saveGatewayConfig],
  );

  const openUsage = useCallback(() => {
    if (onOpenUsage) {
      onOpenUsage();
      return;
    }
    if (serverId === null) {
      return;
    }
    navigate(buildSettingsHostSectionRoute(serverId, "usage"));
  }, [navigate, onOpenUsage, serverId]);

  return (
    <>
      <SettingsSection title={t("settings.pages.quota.usageSection")}>
        <SettingsCard>
          {serverId !== null && usageSetting.supported ? (
            <SettingsSwitch
              label={t("providerUsage.checkUsage")}
              hint={t("providerUsage.checkUsageHint", { host: hostLabel })}
              disabled={!usageSetting.ready}
              value={usageSetting.enabled}
              onValueChange={usageSetting.setEnabled}
            />
          ) : null}
          <SettingsSwitch
            label={t("providerUsage.showInSidebar")}
            hint={t("providerUsage.showInSidebarHint")}
            value={inSidebar}
            onValueChange={setInSidebar}
          />
          <SettingsRow label={t("providerUsage.displayAs")}>
            <SegmentedControl
              options={displayAsOptions}
              value={display.displayAs}
              onValueChange={display.setDisplayAs}
              testID="quota-display-as"
            />
          </SettingsRow>
          <SettingsSelect
            label={t("settings.pages.quota.quotaReads")}
            hint={t("settings.pages.quota.quotaReadsHint")}
            value={quotaReads}
            options={readsOptions}
            onValueChange={setQuotaReads}
            disabled={gatewayConfig === null}
            testID="quota-reads"
          />
          <SettingsRow
            label={t("settings.pages.quota.numberUnits")}
            hint={t("settings.pages.quota.numberUnitsHint")}
          >
            <SegmentedControl
              options={numberUnitOptions}
              value={appSettings.numberUnits}
              onValueChange={setNumberUnits}
            />
          </SettingsRow>
          <SettingsRow
            label={t("settings.pages.quota.currency")}
            hint={t("settings.pages.quota.currencyHint")}
          >
            <SegmentedControl
              options={currencyOptions}
              value={appSettings.currency}
              onValueChange={setCurrency}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      {getIsElectron() ? (
        <SettingsSection title={t("trayUsage.section")}>
          <SettingsCard>
            <TrayUsageRows />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {gatewayMode.enabled ? null : (
        <SettingsSection title={t("settings.pages.quota.alertsSection")}>
          <SettingsCard>
            <UsageAlertRows />
          </SettingsCard>
        </SettingsSection>
      )}
      {warmupsOn ? (
        <SettingsSection title={t("settings.pages.quota.warmupSection")}>
          <SettingsCard>
            <WarmupRows />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {warmupsOn ? (
        <SettingsSection title={t("settings.pages.quota.codexResetsSection")}>
          <SettingsCard>
            <CodexResetRows />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {middlewareOn ? (
        <SettingsSection title={t("settings.pages.quota.turnDoneSection")}>
          <SettingsCard>
            <TurnDoneAlertRow />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.pages.quota.pageSection")}>
        <SettingsCard>
          <SettingsLinkRow
            label={t("settings.pages.quota.openUsage")}
            hint={
              serverId === null
                ? undefined
                : t("settings.pages.quota.openUsageHint", { host: hostLabel ?? "" })
            }
            actionLabel={t("settings.pages.actions.open")}
            onPress={openUsage}
            disabled={serverId === null}
            testID="settings-quota-open-usage"
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
