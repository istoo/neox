import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { GatewayMaskingRecordWire, GatewayRouteWire } from "@neolix/protocol/gateway";
import { useGatewayCallMasking } from "@/hooks/use-gateway-call-masking";
import { useGatewayTrace } from "@/hooks/use-gateway-trace";
import { settingsStyles } from "@/styles/settings";
import { agentDisplayName } from "./routing-agent-names";
import { formatClock } from "./routing-model";
import { GatewayRoutingSteps } from "./routing-steps";

/**
 * The gateway's requests, newest first, with the selected call's decision
 * chain and the masking it went through. A request is the page's unit: the
 * routing decisions, attempts and masking records all belong to one row.
 */
export function GatewayRequestFlow({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { trace, isLoading } = useGatewayTrace(serverId);
  const routes = trace?.routes ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  const route = routes.find((entry) => entry.id === picked) ?? routes[0] ?? null;
  const masking = useGatewayCallMasking(serverId, route?.gatewayCallId ?? null);

  const select = useCallback((id: number) => setPicked(id), []);

  if (isLoading && trace === null) {
    return <Text style={styles.empty}>{t("settings.gatewayPages.routing.lastRequest")}</Text>;
  }
  if (routes.length === 0) {
    return (
      <View style={settingsStyles.card}>
        <Text style={styles.empty}>{t("settings.gatewayPages.routing.noRequests")}</Text>
      </View>
    );
  }

  return (
    <View testID="gateway-request-flow">
      <View style={settingsStyles.card}>
        {routes.map((entry) => (
          <RequestRow
            key={entry.id}
            route={entry}
            selected={route !== null && entry.id === route.id}
            onSelect={select}
          />
        ))}
      </View>
      {route === null ? null : (
        <>
          <View style={styles.block}>
            <GatewayRoutingSteps route={route} />
          </View>
          <MaskingCard
            records={masking.records}
            more={masking.more}
            linked={route.gatewayCallId !== undefined}
          />
        </>
      )}
    </View>
  );
}

function RequestRow({
  route,
  selected,
  onSelect,
}: {
  route: GatewayRouteWire;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(route.id), [onSelect, route.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const failed = route.status !== null && route.status >= 400;
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={selected ? rowStyles.rowSelected : rowStyles.row}
      testID={`gateway-request-${route.id}`}
    >
      <Text style={rowStyles.clock}>{formatClock(route.time)}</Text>
      <Text style={rowStyles.agent} numberOfLines={1}>
        {agentDisplayName(route.agent)}
      </Text>
      <Text style={rowStyles.model} numberOfLines={1}>
        {route.model}
      </Text>
      <Text style={failed ? rowStyles.statusFailed : rowStyles.status}>{route.status ?? "…"}</Text>
      <Text style={rowStyles.millis}>
        {route.millis === null ? "" : `${String(Math.round(route.millis))}ms`}
      </Text>
      {route.tries.length > 1 ? (
        <Text style={rowStyles.tries}>{route.tries.length}</Text>
      ) : (
        <View style={rowStyles.triesPlaceholder} />
      )}
      <Text style={route.masked ? rowStyles.masked : rowStyles.maskedOff}>
        {route.masked ? t("settings.gatewayPages.masking.masked") : ""}
      </Text>
    </PressHighlight>
  );
}

/** What masking swapped in this call, by value; the values themselves are never kept. */
function MaskingCard({
  records,
  more,
  linked,
}: {
  records: GatewayMaskingRecordWire[];
  more: boolean;
  linked: boolean;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.block}>
      <View style={settingsStyles.card} testID="gateway-request-masking">
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{t("settings.gatewayPages.masking.recordsTitle")}</Text>
          <Text style={styles.cardHint}>
            {linked
              ? t("settings.gatewayPages.masking.masked")
              : t("settings.gatewayPages.masking.nothingYet")}
          </Text>
        </View>
        {records.length === 0 ? (
          <Text style={styles.empty}>{t("settings.gatewayPages.masking.nothingYet")}</Text>
        ) : (
          records.map((record) => (
            <View key={record.key} style={styles.maskRecord}>
              <Text style={styles.maskWhen}>{new Date(record.t).toLocaleTimeString()}</Text>
              <Text style={styles.maskCount}>
                {record.n} {t("settings.gatewayPages.masking.valuesMasked")}
              </Text>
              {record.values.map((value) => (
                <Text key={value.p} style={styles.maskValue} numberOfLines={1}>
                  {value.p} · {value.k} · {value.n}
                </Text>
              ))}
            </View>
          ))
        )}
        {more ? (
          <Text style={styles.empty}>{t("settings.gatewayPages.masking.noMatch")}</Text>
        ) : null}
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  clock: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  agent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    minWidth: 72,
  },
  model: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  statusFailed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  millis: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    minWidth: 56,
    textAlign: "right",
  },
  tries: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 20,
    textAlign: "right",
  },
  triesPlaceholder: {
    minWidth: 20,
  },
  masked: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.sm,
    minWidth: 64,
    textAlign: "right",
  },
  maskedOff: {
    minWidth: 64,
  },
}));

const styles = StyleSheet.create((theme) => ({
  block: {
    marginBottom: theme.spacing[4],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  cardHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  maskRecord: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  maskWhen: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  maskCount: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  maskValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
