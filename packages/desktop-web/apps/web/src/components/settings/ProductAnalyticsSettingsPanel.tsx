import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "~/i18n";
import { productAnalyticsBridge } from "~/lib/productAnalytics";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { IS_REMOTE_DESKTOP } from "~/branding";

const queryKey = ["desktop", "product-analytics-consent"] as const;

export function ProductAnalyticsSettingsPanel() {
  const bridge = productAnalyticsBridge();
  const client = useQueryClient();
  const state = useQuery({
    queryKey,
    queryFn: () => bridge!.getState(),
    enabled: !!bridge,
    retry: false,
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) => bridge!.setEnabled(enabled),
    onSuccess: (value) => client.setQueryData(queryKey, value),
  });
  if (!bridge) return null;
  const title = IS_REMOTE_DESKTOP
    ? t("settings:shareUsageAndDiagnostics")
    : t("settings:shareProductAnalytics");
  return (
    <SettingsSection title={t("settings:privacySection")}>
      <SettingsRow
        title={title}
        description={
          IS_REMOTE_DESKTOP
            ? t("settings:analyticsRemoteDescription")
            : t("settings:analyticsLocalDescription")
        }
        control={
          <Switch
            aria-label={title}
            checked={state.data?.enabled ?? false}
            disabled={state.isPending || state.isError || change.isPending}
            onCheckedChange={(checked) => change.mutate(Boolean(checked))}
          />
        }
        status={
          state.isError ? (
            <Button variant="outline" size="sm" onClick={() => void state.refetch()}>
              {t("settings:retryLoadingPrivacySettings")}
            </Button>
          ) : change.isError ? (
            t("settings:couldNotSaveYourChoice")
          ) : IS_REMOTE_DESKTOP ? (
            t("settings:analyticsOffRemote")
          ) : (
            t("settings:analyticsOffLocal")
          )
        }
      />
    </SettingsSection>
  );
}
