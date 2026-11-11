/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-array-as-prop -- routing page header: three closures and style arrays, none in a hot list. */
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useGatewayTrace } from "@/hooks/use-gateway-trace";
import { useHostFeature } from "@/runtime/host-features";
import { useBuiltinFeatureEnabled } from "@/plugins/builtin-features";
import { settingsStyles } from "@/styles/settings";
import { GatewayRequestFlow } from "./request-flow";
import { RoutingDot } from "./routing-dot";
import { GatewayRoutingGroups, newRoutingGroup } from "./routing-groups";
import type { GatewayPageProps } from "./types";

export function GatewayRoutingPage({ serverId, config, edit }: GatewayPageProps) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "gatewayRoutingTrace");
  const groupsOn = useBuiltinFeatureEnabled(serverId, "groups");
  const { trace, isLoading, error } = useGatewayTrace(serverId);
  const [groupsOpen, setGroupsOpen] = useState(true);
  const toggleGroups = useCallback(() => setGroupsOpen((value) => !value), []);
  const addGroup = useCallback(() => {
    edit((next) => {
      next.groups = [...(next.groups ?? []), newRoutingGroup(next)];
    });
    setGroupsOpen(true);
  }, [edit]);

  if (!supported) {
    return (
      <View style={settingsStyles.card}>
        <Text style={styles.unsupported}>{t("settings.gatewayPages.routing.updateHost")}</Text>
      </View>
    );
  }

  const route = trace?.routes[0] ?? null;

  return (
    <View testID="gateway-routing-page">
      <View style={styles.head}>
        <View style={styles.headTitle}>
          <Text style={styles.title}>{t("settings.gatewayPages.routing.title")}</Text>
          <RoutingDot tone={route === null || route.done ? "neutral" : "active"} />
          <Text style={styles.note}>{t("settings.gatewayPages.routing.live")}</Text>
        </View>
        <View style={styles.actions}>
          {groupsOn ? (
            <>
              <Button variant="ghost" size="sm" onPress={toggleGroups}>
                {t("settings.gatewayPages.routing.groupsTitle")}
              </Button>
              <Button variant="ghost" size="sm" onPress={addGroup}>
                {t("settings.gatewayPages.routing.newGroup")}
              </Button>
            </>
          ) : null}
        </View>
      </View>

      {isLoading && trace === null ? (
        <View style={styles.loading}>
          <LoadingSpinner size="small" color={styles.loadingColor.color} />
        </View>
      ) : (
        <>
          {error === null ? null : <Text style={styles.error}>{error.message}</Text>}
          <GatewayRequestFlow serverId={serverId} />
        </>
      )}

      {groupsOpen && groupsOn ? (
        <View style={styles.block}>
          <GatewayRoutingGroups config={config} edit={edit} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  headTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  block: {
    marginBottom: theme.spacing[6],
  },
  loading: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
  },
  loadingColor: {
    color: theme.colors.foregroundMuted,
  },
  unsupported: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
}));
