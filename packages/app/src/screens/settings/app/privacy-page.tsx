import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useAppSettings } from "@/hooks/use-settings";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildModelsRoute } from "@/utils/host-routes";
import { SessionReadsRows } from "./session-reads-rows";
import { SettingsLinkRow, useSettingsHostServerId, useSettingsNavigate } from "./shared";

/** The browser/not-browser choice as myna keeps it: `signInLinkOnly` inverted. */
function withoutSignInLinkOnly(config: GatewayConfigWire): GatewayConfigWire {
  const next = { ...config };
  delete next.codexSignInLinkOnly;
  return next;
}

/**
 * Settings › Privacy. Myna's redaction rows are the host gateway's masking
 * rules in Neolix; the page links to the host's masking page, where the rules,
 * the built-in detectors and a live preview live. The sign-in rows are the
 * gateway's own settings (`app.js:21698-21731`).
 */
export function PrivacyPage() {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);
  const { config: daemonConfig, patchConfig } = useDaemonConfig(serverId);
  const { settings, updateSettings } = useAppSettings();
  const telemetryEnabled = daemonConfig?.telemetry?.enabled === true;
  const shareUsage = daemonConfig?.telemetry?.shareUsage === true;
  const telemetryDisabled = daemonConfig === null;
  const openMasking = useCallback(() => {
    if (serverId === null) {
      return;
    }
    navigate(buildModelsRoute({ serverId, view: "masking" }));
  }, [navigate, serverId]);

  // COMPAT(codexAccountDiscovery): added in v0.16.0, remove after 2027-11-06.
  const discovery = (config?.accountDiscovery ?? config?.codexAccountDiscovery) !== false;
  const openSignInPages = config?.codexSignInLinkOnly !== true;
  const disabled = config === null;
  const sessionHistorySupported = useHostFeature(serverId, "externalSessions");

  const changeDiscovery = useCallback(
    async (on: boolean) => {
      if (config === null || on === discovery) {
        return;
      }
      if (!on) {
        // Off takes every subscription out of Neolix at once, as myna asks
        // before it does (`app.js:21711-21716`).
        const sure = await confirmDialog({
          title: t("settings.pages.privacy.discoveryOffTitle"),
          message: t("settings.pages.privacy.discoveryOffMessage"),
          confirmLabel: t("settings.pages.privacy.discoveryOffConfirm"),
          cancelLabel: t("settings.pages.privacy.cancel"),
          destructive: true,
        });
        if (!sure) {
          return;
        }
      }
      void save({ ...config, accountDiscovery: on });
    },
    [config, discovery, save, t],
  );

  const changeOpenSignInPages = useCallback(
    (open: boolean) => {
      if (config === null || open === openSignInPages) {
        return;
      }
      void save(open ? withoutSignInLinkOnly(config) : { ...config, codexSignInLinkOnly: true });
    },
    [config, openSignInPages, save],
  );

  const changeHideAccounts = useCallback(
    (on: boolean) => void updateSettings({ maskAccounts: on }),
    [updateSettings],
  );

  const changeTelemetry = useCallback(
    (on: boolean) => {
      if (daemonConfig === null || on === telemetryEnabled) {
        return;
      }
      void patchConfig({
        telemetry: {
          enabled: on,
          // Turning sharing off forgets the narrower choice too, so turning
          // it back on never starts sending usage silently.
          ...(on ? {} : { shareUsage: false }),
          decidedAt: new Date().toISOString(),
        },
      });
    },
    [daemonConfig, patchConfig, telemetryEnabled],
  );

  const changeShareUsage = useCallback(
    (on: boolean) => {
      if (daemonConfig === null || on === shareUsage) {
        return;
      }
      void patchConfig({
        telemetry: { shareUsage: on, decidedAt: new Date().toISOString() },
      });
    },
    [daemonConfig, patchConfig, shareUsage],
  );

  const onDiscoveryChange = useCallback(
    (value: string) => {
      void changeDiscovery(value === "on");
    },
    [changeDiscovery],
  );

  const onOpenSignInPagesChange = useCallback(
    (value: string) => {
      changeOpenSignInPages(value === "on");
    },
    [changeOpenSignInPages],
  );

  const offOn = [
    { value: "off", label: t("settings.pages.privacy.off"), disabled },
    { value: "on", label: t("settings.pages.privacy.on"), disabled },
  ];

  return (
    <>
      <SettingsSection title={t("settings.pages.privacy.signInsSection")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.pages.privacy.subscriptionAccounts")}
            hint={
              disabled
                ? t("settings.pages.actions.noHost")
                : t("settings.pages.privacy.subscriptionAccountsHint")
            }
            testID="settings-subscription-accounts"
          >
            <SegmentedControl
              value={discovery ? "on" : "off"}
              onValueChange={onDiscoveryChange}
              options={offOn}
            />
          </SettingsRow>
          <SettingsRow
            label={t("settings.pages.privacy.openSignInPages")}
            hint={
              disabled
                ? t("settings.pages.actions.noHost")
                : t("settings.pages.privacy.openSignInPagesHint")
            }
            testID="settings-open-sign-in-pages"
          >
            <SegmentedControl
              value={openSignInPages ? "on" : "off"}
              onValueChange={onOpenSignInPagesChange}
              options={offOn}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      {sessionHistorySupported ? (
        <SettingsSection title={t("settings.pages.privacy.sessionHistorySection")}>
          <SettingsCard>
            <SessionReadsRows serverId={serverId} />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.pages.privacy.sharingSection")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.pages.privacy.hideAccounts")}
            hint={t("settings.pages.privacy.hideAccountsHint")}
            value={settings.maskAccounts}
            onValueChange={changeHideAccounts}
            testID="settings-hide-accounts"
          />
          <SettingsSwitch
            label={t("settings.pages.privacy.shareUsage")}
            hint={t("settings.pages.privacy.shareUsageHint")}
            value={telemetryEnabled}
            onValueChange={changeTelemetry}
            disabled={telemetryDisabled}
            testID="settings-telemetry-enabled"
          />
          {telemetryEnabled ? (
            <SettingsSwitch
              label={t("settings.pages.privacy.shareAgents")}
              hint={t("settings.pages.privacy.shareAgentsHint")}
              value={shareUsage}
              onValueChange={changeShareUsage}
              disabled={telemetryDisabled}
              testID="settings-telemetry-share-usage"
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.privacy.maskingSection")}>
        <SettingsCard>
          <SettingsLinkRow
            label={t("settings.pages.privacy.masking")}
            hint={t("settings.pages.privacy.maskingHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={openMasking}
            disabled={serverId === null}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
