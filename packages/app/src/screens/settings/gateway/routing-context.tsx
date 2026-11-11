/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-object-as-prop -- context card: style arrays and per-segment widths, a few dozen views. */
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  GatewayRoutePromptWire,
  GatewayRouteTraceWire,
  GatewayRouteWire,
} from "@neolix/protocol/gateway";
import { settingsStyles } from "@/styles/settings";
import {
  averagePromptTokens,
  formatTokens,
  healthOf,
  promptSegments,
  type PromptSegment,
} from "./routing-model";
import { agentDisplayName } from "./routing-agent-names";
import { RoutingDot } from "./routing-dot";

interface GatewayRoutingContextProps {
  trace: GatewayRouteTraceWire | null;
  route: GatewayRouteWire | null;
}

export function GatewayRoutingContext({ trace, route }: GatewayRoutingContextProps) {
  const { t } = useTranslation();
  const prompt = route?.prompt ?? null;
  if (route === null || prompt === null) {
    return (
      <View style={settingsStyles.card}>
        <View style={styles.head}>
          <Text style={styles.title}>{t("settings.gatewayPages.routing.contextTitle")}</Text>
        </View>
        <Text style={styles.empty}>
          {route === null
            ? t("settings.gatewayPages.routing.noRequests")
            : t("settings.gatewayPages.routing.noPrompt")}
        </Text>
      </View>
    );
  }
  const segments = promptSegments(prompt);
  const health = healthOf(prompt.tokens, prompt.window);
  const average = trace === null ? null : averagePromptTokens(trace);
  const percent =
    prompt.window === null || prompt.window <= 0
      ? null
      : Math.round((prompt.tokens / prompt.window) * 100);
  const roomFor =
    average === null || prompt.window === null || average <= 0
      ? null
      : Math.max(0, Math.floor((prompt.window - prompt.tokens) / average));

  return (
    <View style={settingsStyles.card} testID="gateway-routing-context">
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.gatewayPages.routing.contextTitle")}</Text>
        <View style={styles.headMeta}>
          <Text style={styles.chip} numberOfLines={1}>
            {agentDisplayName(route.agent)}
          </Text>
          <Text style={styles.chevron}>›</Text>
          <Text style={styles.chip} numberOfLines={1}>
            {route.providerLabel ?? route.provider ?? route.routedModel}
          </Text>
          <Text style={styles.chevron}>›</Text>
          <Text style={styles.chip} numberOfLines={1}>
            {prompt.window === null
              ? route.model
              : t("settings.gatewayPages.routing.windowOf", {
                  model: route.model,
                  window: formatTokens(prompt.window),
                })}
          </Text>
          <RoutingDot tone={route.done ? "neutral" : "active"} style={styles.liveDot} />
          <Text style={styles.liveText}>
            {route.done
              ? t("settings.gatewayPages.routing.contextDone")
              : t("settings.gatewayPages.routing.contextLive")}
          </Text>
        </View>
      </View>
      <View style={styles.body}>
        <View style={styles.usedHead}>
          <Text style={styles.usedLabel}>{t("settings.gatewayPages.routing.usedContext")}</Text>
          <View style={[styles.health, healthStyle(health)]}>
            <Text style={styles.healthText}>{healthLabel(health, t)}</Text>
          </View>
        </View>
        <View style={styles.figureRow}>
          <Text style={styles.figure}>{formatTokens(prompt.tokens)}</Text>
          {prompt.window === null ? null : (
            <Text style={styles.figureTotal}>/ {formatTokens(prompt.window)} token</Text>
          )}
        </View>
        <Text style={styles.subline}>
          {percent === null
            ? t("settings.gatewayPages.routing.tokensUsed", { used: formatTokens(prompt.tokens) })
            : t("settings.gatewayPages.routing.percentUsed", { percent })}
          {roomFor === null
            ? ""
            : ` · ${t("settings.gatewayPages.routing.roomFor", { n: roomFor })}`}
        </Text>
        <View style={styles.bar}>
          {segments.map((segment) => (
            <View key={segment.kind} style={[styles.barSegment, segmentStyle(segment)]} />
          ))}
        </View>
        <View style={styles.legend}>
          {segments.map((segment) => (
            <View key={segment.kind} style={styles.legendItem}>
              <View style={[styles.legendDot, partStyle(segment.kind)]} />
              <Text style={styles.legendText}>
                {segmentLabel(segment.kind, t)} {formatTokens(segment.tokens)}
              </Text>
            </View>
          ))}
        </View>
      </View>
      <View style={styles.contents}>
        <Text style={styles.contentsTitle}>{t("settings.gatewayPages.routing.contents")}</Text>
        {prompt.parts.map((part) => (
          <PromptPartRow key={part.kind} part={part} />
        ))}
      </View>
    </View>
  );
}

type Health = "healthy" | "tight" | "over";

function PromptPartRow({ part }: { part: GatewayRoutePromptWire["parts"][number] }) {
  const { t } = useTranslation();
  return (
    <View style={styles.part}>
      <View style={styles.partHead}>
        <View style={[styles.legendDot, partStyle(part.kind)]} />
        <Text style={styles.partName}>{segmentLabel(part.kind, t)}</Text>
        <Text style={styles.partTokens}>{formatTokens(part.tokens)}</Text>
      </View>
      {part.items.map((item) => (
        <View key={`${item.tag}-${item.name}-${item.tokens}`} style={styles.item}>
          <Text style={styles.itemName} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.itemBarTrack}>
            <View
              style={[
                styles.itemBarFill,
                partStyle(part.kind),
                { width: itemWidth(item.tokens, part.tokens) },
              ]}
            />
          </View>
          <Text style={styles.itemTokens}>{formatTokens(item.tokens)}</Text>
        </View>
      ))}
    </View>
  );
}

function healthLabel(health: Health, t: TFunction): string {
  if (health === "over") {
    return t("settings.gatewayPages.routing.healthOver");
  }
  return health === "tight"
    ? t("settings.gatewayPages.routing.healthTight")
    : t("settings.gatewayPages.routing.healthHealthy");
}

function healthStyle(health: Health) {
  if (health === "over") {
    return styles.healthOver;
  }
  return health === "tight" ? styles.healthTight : styles.healthHealthy;
}

function segmentLabel(kind: PromptSegment["kind"], t: TFunction): string {
  switch (kind) {
    case "system":
      return t("settings.gatewayPages.routing.partSystem");
    case "tools":
      return t("settings.gatewayPages.routing.partTools");
    case "messages":
      return t("settings.gatewayPages.routing.partMessages");
    case "other":
      return t("settings.gatewayPages.routing.partOther");
    default:
      return t("settings.gatewayPages.routing.partRemaining");
  }
}

function segmentStyle(segment: PromptSegment) {
  const ratio = Math.max(segment.ratio, 0.0001);
  switch (segment.kind) {
    case "system":
      return [styles.barSystem, { flex: ratio }];
    case "tools":
      return [styles.barTools, { flex: ratio }];
    case "messages":
      return [styles.barMessages, { flex: ratio }];
    case "other":
      return [styles.barOther, { flex: ratio }];
    default:
      return [styles.barRemaining, { flex: ratio }];
  }
}

function partStyle(kind: PromptSegment["kind"]) {
  switch (kind) {
    case "system":
      return styles.barSystem;
    case "tools":
      return styles.barTools;
    case "messages":
      return styles.barMessages;
    case "other":
      return styles.barOther;
    default:
      return styles.barRemaining;
  }
}

function itemWidth(tokens: number, total: number): `${number}%` {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.max(1, Math.min(100, Math.round((tokens / total) * 100)))}%`;
}

const styles = StyleSheet.create((theme) => ({
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  headMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  chip: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    maxWidth: 160,
  },
  chevron: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  liveDot: {
    marginLeft: theme.spacing[2],
  },
  liveText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  usedHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  usedLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  health: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
  },
  healthHealthy: { backgroundColor: theme.colors.statusSuccessTint },
  healthTight: { backgroundColor: theme.colors.statusWarningTint },
  healthOver: { backgroundColor: theme.colors.statusDangerTint },
  healthText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  figureRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1],
  },
  figure: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  figureTotal: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  subline: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bar: {
    flexDirection: "row",
    height: 56,
    gap: 2,
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  barSegment: {
    borderRadius: theme.borderRadius.base,
    minWidth: 2,
  },
  barSystem: { backgroundColor: theme.colors.accent },
  barTools: { backgroundColor: theme.colors.statusWarning },
  barMessages: { backgroundColor: theme.colors.statusMerged },
  barOther: { backgroundColor: theme.colors.foregroundExtraMuted },
  barRemaining: { backgroundColor: theme.colors.surface3 },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  contents: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  contentsTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  part: {
    gap: theme.spacing[1],
  },
  partHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  partName: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  partTokens: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
  },
  itemName: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  itemBarTrack: {
    width: 120,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  itemBarFill: {
    height: 4,
    borderRadius: 2,
  },
  itemTokens: {
    width: 52,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
}));
