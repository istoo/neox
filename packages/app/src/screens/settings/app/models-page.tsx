/* eslint-disable react-perf/jsx-no-new-function-as-prop -- a handful of settings rows open host pages; none of them is in a hot list, so memoising each closure buys nothing. */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { buildModelsRoute, type ModelsView } from "@/utils/host-routes";
import { SettingsLinkRow, useSettingsHostServerId, useSettingsNavigate } from "./shared";
import { ModelNamesRow } from "./gateway-option-rows";
import { DisabledModelsRows, ImageGenerationRows, ReplyRows, VisionRows } from "./models-rows";
import { useGatewayMode } from "./gateway-mode";
import { useBuiltinFeatureEnabled } from "@/plugins/builtin-features";

/**
 * Settings › Models. Providers and routing open the host's gateway pages;
 * the reply, image-recognition and model-name rows are edited here through
 * the host's gateway config.
 */
export function ModelsPage({
  serverId: serverIdOverride,
  embedded = false,
}: {
  /** The host the Models & quota page is showing. */
  serverId?: string | null;
  /** The page's own sections already hold providers and routing. */
  embedded?: boolean;
} = {}) {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const selectedServerId = useSettingsHostServerId();
  const serverId = serverIdOverride === undefined ? selectedServerId : serverIdOverride;
  const gatewayMode = useGatewayMode(serverId);
  const searchOn = useBuiltinFeatureEnabled(serverId, "search");
  const open = useCallback(
    (view: ModelsView) => {
      if (serverId === null) {
        return;
      }
      navigate(buildModelsRoute({ serverId, view }));
    },
    [navigate, serverId],
  );

  return (
    <>
      {embedded ? null : (
        <SettingsSection title={t("settings.pages.models.providersSection")}>
          <SettingsCard>
            <SettingsLinkRow
              label={t("settings.pages.models.providers")}
              hint={t("settings.pages.models.providersHint")}
              actionLabel={t("settings.pages.actions.open")}
              onPress={() => open("sources")}
              disabled={serverId === null}
            />
            <SettingsLinkRow
              label={t("settings.pages.models.routing")}
              hint={t("settings.pages.models.routingHint")}
              actionLabel={t("settings.pages.actions.open")}
              onPress={() => open("routing")}
              disabled={serverId === null}
            />
          </SettingsCard>
        </SettingsSection>
      )}
      {gatewayMode.enabled ? null : (
        <SettingsSection title={t("settings.pages.models.namingSection")}>
          <SettingsCard>
            <ModelNamesRow />
          </SettingsCard>
        </SettingsSection>
      )}
      <SettingsSection title={t("settings.pages.models.repliesSection")}>
        <SettingsCard>
          <ReplyRows />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title={t("settings.pages.models.imagesSection")}>
        <SettingsCard>
          <VisionRows />
          <ImageGenerationRows />
        </SettingsCard>
      </SettingsSection>
      {searchOn ? (
        <SettingsSection title={t("settings.pages.models.searchSection")}>
          <SettingsCard>
            <SettingsLinkRow
              label={t("settings.pages.models.search")}
              hint={t("settings.pages.models.searchHint")}
              actionLabel={t("settings.pages.actions.open")}
              onPress={() => open("overview")}
              disabled={serverId === null}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      <SettingsSection title={t("settings.pages.models.disabledSection")}>
        <SettingsCard>
          <DisabledModelsRows />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
