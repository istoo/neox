/* eslint-disable react-perf/jsx-no-new-function-as-prop -- a handful of settings rows open host pages; none of them is in a hot list, so memoising each closure buys nothing. */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection } from "@/components/settings";
import {
  buildModelsRoute,
  buildSettingsHostSectionRoute,
  buildSettingsSectionRoute,
  type HostSectionSlug,
} from "@/utils/host-routes";
import { OtelRows } from "./otel-rows";
import { SettingsLinkRow, useSettingsHostServerId, useSettingsNavigate } from "./shared";

/**
 * Settings › Observability. Gateway trace export, the gateway's recent calls
 * and usage, and the app's own diagnostics.
 */
export function ObservabilityPage() {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const serverId = useSettingsHostServerId();
  const openHost = useCallback(
    (section: HostSectionSlug) => {
      if (serverId === null) {
        return;
      }
      navigate(buildSettingsHostSectionRoute(serverId, section));
    },
    [navigate, serverId],
  );
  const openGateway = useCallback(() => {
    if (serverId === null) {
      return;
    }
    navigate(buildModelsRoute({ serverId, view: "overview" }));
  }, [navigate, serverId]);
  const openDiagnostics = useCallback(
    () => navigate(buildSettingsSectionRoute("diagnostics")),
    [navigate],
  );

  return (
    <>
      <SettingsSection title={t("settings.pages.observability.gatewaySection")}>
        <SettingsCard>
          <SettingsLinkRow
            label={t("settings.pages.observability.recentCalls")}
            hint={t("settings.pages.observability.recentCallsHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={openGateway}
            disabled={serverId === null}
          />
          <SettingsLinkRow
            label={t("settings.pages.observability.usage")}
            hint={t("settings.pages.observability.usageHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={() => openHost("usage")}
            disabled={serverId === null}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.observability.otelSection")}>
        <SettingsCard>
          <OtelRows />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.observability.localSection")}>
        <SettingsCard>
          <SettingsLinkRow
            label={t("settings.pages.observability.diagnostics")}
            hint={t("settings.pages.observability.diagnosticsHint")}
            actionLabel={t("settings.pages.actions.open")}
            onPress={openDiagnostics}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
