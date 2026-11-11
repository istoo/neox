/* eslint-disable react-perf/jsx-no-new-array-as-prop -- routing steps: style arrays in a card drawn a few times a second. */
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { GatewayRouteWire } from "@neolix/protocol/gateway";
import { settingsStyles } from "@/styles/settings";
import { RoutingDot } from "./routing-dot";
import { buildSteps, formatClock } from "./routing-model";

export function GatewayRoutingSteps({ route }: { route: GatewayRouteWire | null }) {
  const { t } = useTranslation();
  if (route === null) {
    return (
      <View style={settingsStyles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>{t("settings.gatewayPages.routing.lastRequest")}</Text>
        </View>
        <Text style={styles.empty}>{t("settings.gatewayPages.routing.noRequests")}</Text>
      </View>
    );
  }
  const steps = buildSteps(route, t);
  return (
    <View style={settingsStyles.card} testID="gateway-routing-steps">
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.gatewayPages.routing.lastRequest")}</Text>
        <View style={styles.headMeta}>
          <Text style={styles.badge}>#{route.id}</Text>
          <Text style={styles.clock}>{formatClock(route.time)}</Text>
        </View>
      </View>
      <View style={styles.list}>
        {steps.map((step) => (
          <View key={step.key} style={styles.row}>
            <RoutingDot tone={step.tone} style={styles.dot} />
            <Text style={styles.text}>{step.text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  headMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  badge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  clock: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  list: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  dot: {
    marginTop: 6,
  },
  text: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));
