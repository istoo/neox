import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayUsagePromptWire, GatewayUsageReportWire } from "@neolix/protocol/gateway";
import { settingsStyles } from "@/styles/settings";
import { formatCompact, formatPercent } from "./usage-data";

const SLICE_ORDER = ["system", "tools", "results", "chat", "other"] as const;
type SliceKind = (typeof SLICE_ORDER)[number];

function sliceFill(kind: SliceKind) {
  switch (kind) {
    case "system":
      return styles.sliceSystem;
    case "tools":
      return styles.sliceTools;
    case "results":
      return styles.sliceResults;
    case "chat":
      return styles.sliceChat;
    case "other":
      return styles.sliceOther;
  }
}

/**
 * The Context page: what each agent's prompts held. The gateway reads every
 * request body, so it can tell system, tools, tool results and the
 * conversation apart — the same estimator Routing shows. It cannot split the
 * system prompt into skills, memory and files the way myna reads an agent's
 * own instructions, and it says so rather than drawing them.
 */
export function GatewayUsageContext({ report }: { report: GatewayUsageReportWire }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const rows = report.byClient.filter((group) => group.prompt !== undefined);
  if (rows.length === 0 || report.prompt.calls === 0) {
    return (
      <View style={[settingsStyles.card, styles.empty]}>
        <Text style={styles.emptyTitle}>{t("settings.gatewayPages.usage.context.none")}</Text>
        <Text style={styles.emptyHint}>{t("settings.gatewayPages.usage.context.hint")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <Text style={styles.lead}>
        {t("settings.gatewayPages.usage.context.lead", {
          calls: new Intl.NumberFormat(locale).format(report.prompt.calls),
          tokens: formatCompact(report.prompt.tokens, locale),
        })}
      </Text>
      <View style={[settingsStyles.card, styles.card]}>
        {rows.map((group) => {
          const prompt = group.prompt;
          return prompt === undefined ? null : (
            <PromptRow key={group.id} name={group.name} prompt={prompt} />
          );
        })}
      </View>
      <Text style={styles.note}>{t("settings.gatewayPages.usage.context.notMeasured")}</Text>
      <Text style={styles.note}>{t("settings.gatewayPages.usage.context.note")}</Text>
    </View>
  );
}

function PromptRow({ name, prompt }: { name: string; prompt: GatewayUsagePromptWire }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const total = prompt.tokens > 0 ? prompt.tokens : 0;
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.total}>{formatCompact(total, locale)}</Text>
      </View>
      <View style={styles.bar}>
        {SLICE_ORDER.map((kind) => {
          const slice = prompt.parts.find((part) => part.kind === kind);
          if (slice === undefined || total === 0) {
            return null;
          }
          return (
            <View
              key={kind}
              style={[
                styles.segment,
                sliceFill(kind),
                { width: `${(100 * slice.tokens) / total}%` },
              ]}
            />
          );
        })}
      </View>
      <View style={styles.legend}>
        {SLICE_ORDER.flatMap((kind) => {
          const slice = prompt.parts.find((part) => part.kind === kind);
          if (slice === undefined) {
            return [];
          }
          return [
            <View key={kind} style={styles.legendItem}>
              <View style={[styles.swatch, sliceFill(kind)]} />
              <Text style={styles.legendLabel}>
                {t(`settings.gatewayPages.usage.context.slices.${kind}`)}
              </Text>
              <Text style={styles.legendValue}>
                {t("settings.gatewayPages.usage.context.share", {
                  n: formatCompact(slice.tokens, locale),
                  pct: total === 0 ? "0%" : formatPercent(slice.tokens / total, locale),
                })}
              </Text>
            </View>,
          ];
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[3],
  },
  lead: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    gap: theme.spacing[2],
    padding: theme.spacing[6],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  emptyHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    paddingHorizontal: theme.spacing[4],
  },
  row: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[4],
  },
  rowHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  total: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  bar: {
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
    flexDirection: "row",
    height: 8,
    overflow: "hidden",
    width: "100%",
  },
  segment: {
    height: "100%",
  },
  sliceSystem: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  sliceTools: {
    backgroundColor: theme.colors.accent,
  },
  sliceResults: {
    backgroundColor: theme.colors.statusWarning,
  },
  sliceChat: {
    backgroundColor: theme.colors.surface4,
  },
  sliceOther: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
  },
  legendItem: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  swatch: {
    borderRadius: 2,
    height: 8,
    width: 8,
  },
  legendLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  legendValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  note: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
