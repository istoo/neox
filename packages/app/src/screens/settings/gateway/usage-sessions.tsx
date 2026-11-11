import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayUsageReportWire } from "@neolix/protocol/gateway";
import { settingsStyles } from "@/styles/settings";
import { formatCompact, formatPercent, formatUsd } from "./usage-data";

/**
 * The Conversations page: the calls whose client named its conversation in
 * `x-neolix-conversation`, summed per conversation. A client that names none
 * has no sessions here — the gateway keeps no other session identity.
 */
export function GatewayUsageSessions({ report }: { report: GatewayUsageReportWire }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  if (report.bySession.length === 0) {
    return (
      <View style={[settingsStyles.card, styles.empty]}>
        <Text style={styles.emptyTitle}>{t("settings.gatewayPages.usage.sessions.none")}</Text>
        <Text style={styles.emptyHint}>{t("settings.gatewayPages.usage.sessions.hint")}</Text>
      </View>
    );
  }
  return (
    <View style={settingsStyles.card}>
      <View style={styles.head}>
        <Text style={styles.headText}>{t("settings.gatewayPages.usage.sessions.title")}</Text>
        <Text style={styles.headText}>
          {t("settings.gatewayPages.usage.sessions.count", { n: report.bySession.length })}
        </Text>
      </View>
      {report.bySession.map((session) => (
        <View key={session.id} style={styles.row}>
          <View style={styles.who}>
            <Text style={styles.name} numberOfLines={1}>
              {session.name}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {[session.sub, formatCalls(session.calls, t)].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <Text style={styles.tokens}>
            {formatCompact(session.inputTokens + session.outputTokens, locale)}
          </Text>
          <Text style={styles.detail}>
            {t("settings.gatewayPages.usage.rankDetail", {
              input: formatCompact(session.inputTokens, locale),
              output: formatCompact(session.outputTokens, locale),
              cache: formatCompact(session.cacheReadTokens, locale),
            })}
            {session.cacheHitRate === null
              ? ""
              : ` · ${t("settings.gatewayPages.usage.kpi.hitRate", {
                  pct: formatPercent(session.cacheHitRate, locale),
                })}`}
          </Text>
          <Text style={styles.cost}>
            {session.costUsd > 0 ? `≈${formatUsd(session.costUsd, locale)}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

function formatCalls(
  calls: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return calls === 1
    ? t("settings.gatewayPages.usage.oneCall", { n: calls })
    : t("settings.gatewayPages.usage.calls", { n: calls });
}

const styles = StyleSheet.create((theme) => ({
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
  head: {
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  headText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    alignItems: "center",
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  who: {
    flexGrow: 1,
    minWidth: 120,
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sub: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  tokens: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
    width: 80,
  },
  detail: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    width: 230,
  },
  cost: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
    width: 90,
  },
}));
