/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-jsx-as-prop -- an eight-row section list and one host filter; none of it is a hot list, so memoising every row buys nothing. */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import {
  Boxes,
  ChartNoAxesColumn,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Route,
  Shield,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { HostFilter } from "@/components/hosts/host-filter";
import { PageLayout } from "@/components/page-layout";
import { FeatureSidebar, FeatureSidebarChevron } from "@/components/sidebar/feature-sidebar";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useActiveHostServerId } from "@/hooks/use-active-host-server-id";
import { selectSettingsHost } from "@/navigation/settings-presentation";
import { useSettingsSectionReplacement } from "@/plugins/page-replacement-navigation";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import { useHosts } from "@/runtime/host-runtime";
import { ModelsPage } from "@/screens/settings/app/models-page";
import { QuotaPage } from "@/screens/settings/app/quota-page";
import { GatewaySettingsSection } from "@/screens/settings/gateway-section";
import {
  GatewayAllowancesView,
  GatewayOverviewView,
  GatewayUsageView,
} from "@/screens/myna-screen";
import { settingsStyles } from "@/styles/settings";
import { UsageSidebarRoot, useOpenSidebarUsage } from "@/usage";
import { buildModelsRoute, isModelsView, MODELS_VIEWS, type ModelsView } from "@/utils/host-routes";

const VIEW_ICONS: Record<ModelsView, LucideIcon> = {
  overview: LayoutDashboard,
  sources: Boxes,
  routing: Route,
  keys: KeyRound,
  allowances: Gauge,
  usage: ChartNoAxesColumn,
  advanced: SlidersHorizontal,
  masking: Shield,
};

/**
 * Models & quota: the single place for this host's model sources, routing,
 * keys, allowances, usage, advanced gateway options and masking rules. Its
 * sections are a list+detail like Settings: a list column beside the detail on
 * wide layouts, and a pushed full screen on compact ones.
 */
export function ModelsScreen(): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const params = useLocalSearchParams<{ host?: string; view?: string; record?: string }>();
  const hosts = useHosts();
  const activeHostServerId = useActiveHostServerId();

  const paramHost = typeof params.host === "string" ? params.host.trim() : "";
  const host = useMemo(() => {
    if (paramHost && hosts.some((candidate) => candidate.serverId === paramHost)) {
      return paramHost;
    }
    return activeHostServerId;
  }, [activeHostServerId, hosts, paramHost]);

  // The app settings pages this screen reuses read their host from the shared
  // settings selection; keep it on the host shown here.
  useEffect(() => {
    if (host !== null) {
      selectSettingsHost(host);
    }
  }, [host]);

  const selectedView = isModelsView(params.view) ? params.view : null;
  const detailView: ModelsView = selectedView ?? "overview";
  const routingReplacement = useSettingsSectionReplacement(host ?? "", "gateway-routing");
  const record =
    typeof params.record === "string" && params.record.length > 0 ? params.record : null;

  const selectView = useCallback(
    (next: ModelsView) => {
      const href = buildModelsRoute({
        serverId: host,
        view: next,
      });
      if (isCompact) {
        router.push(href);
      } else {
        router.replace(href);
      }
    },
    [host, isCompact],
  );

  const selectHost = useCallback((serverId: string) => {
    router.setParams({ host: serverId });
  }, []);

  const backToList = useCallback(() => {
    router.replace(buildModelsRoute({ serverId: host }));
  }, [host]);

  const list = (
    <FeatureSidebar
      title={t("modelsPage.title")}
      compact={isCompact}
      testID="models-sidebar"
      headerAccessory={
        <HostFilter
          hosts={hosts.map((candidate) => ({
            serverId: candidate.serverId,
            label: candidate.label,
          }))}
          selectedHost={host ?? ""}
          onSelectHost={selectHost}
          includeAllHost={false}
          triggerTestID="models-host-filter"
        />
      }
    >
      {MODELS_VIEWS.map((view) => {
        const Icon = VIEW_ICONS[view];
        return (
          <SidebarHeaderRow
            key={view}
            icon={Icon}
            label={t(`modelsPage.views.${view}`)}
            onPress={() => selectView(view)}
            isActive={!isCompact && detailView === view}
            activeFill="selected"
            variant="compact"
            trailing={isCompact ? <FeatureSidebarChevron /> : undefined}
            testID={`models-sidebar-${view}`}
          />
        );
      })}
    </FeatureSidebar>
  );

  if (isCompact && selectedView === null) {
    return list;
  }

  // A plugin replacing Routing keeps its own settings screen.
  if (detailView === "routing" && host !== null && routingReplacement !== null) {
    return (
      <Redirect
        href={buildPluginSettingsRoute(
          host,
          routingReplacement.installation.id,
          routingReplacement.screen.id,
        )}
      />
    );
  }

  const detail = (
    <PageLayout
      title={t(`modelsPage.views.${detailView}`)}
      onBack={isCompact ? backToList : undefined}
      testID="models-detail"
    >
      {host === null ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("quickPanel.noHost")}</Text>
          </View>
        </View>
      ) : (
        <ModelsViewContent host={host} view={detailView} record={record} />
      )}
    </PageLayout>
  );

  if (isCompact) {
    return detail;
  }

  return (
    <View style={styles.split}>
      {list}
      {detail}
    </View>
  );
}

function ModelsViewContent({
  host,
  view,
  record,
}: {
  host: string;
  view: ModelsView;
  record: string | null;
}): ReactElement {
  switch (view) {
    case "overview":
      return <GatewayOverviewView serverId={host} />;
    case "sources":
      return <GatewaySettingsSection serverId={host} pane="providers" />;
    case "routing":
      return <GatewaySettingsSection serverId={host} pane="routing" />;
    case "keys":
      return <GatewaySettingsSection serverId={host} pane="keys" />;
    case "allowances":
      return <AllowancesView host={host} />;
    case "usage":
      return <GatewayUsageView serverId={host} />;
    case "advanced":
      return (
        <>
          <GatewaySettingsSection serverId={host} pane="advanced" />
          <ModelsPage serverId={host} embedded />
        </>
      );
    case "masking":
      return (
        <GatewaySettingsSection
          serverId={host}
          pane="masking"
          {...(record === null ? {} : { focusRecord: record })}
        />
      );
  }
}

/**
 * The allowances section keeps myna's allowance cards and the app's allowance
 * preferences, and opens the upstream plan-usage modal instead of copying it.
 */
function AllowancesView({ host }: { host: string }): ReactElement {
  return (
    <UsageSidebarRoot>
      <AllowancesBody host={host} />
    </UsageSidebarRoot>
  );
}

function AllowancesBody({ host }: { host: string }): ReactElement {
  const openUsage = useOpenSidebarUsage();
  return (
    <>
      <GatewayAllowancesView serverId={host} />
      <QuotaPage serverId={host} onOpenUsage={openUsage} />
    </>
  );
}

const styles = StyleSheet.create({
  split: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
});
