import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  GatewayUsageGroupWire,
  GatewayUsageReportWire,
  GatewayUsageTotalsWire,
} from "@neolix/protocol/gateway";
import { HostUsageSection } from "@/usage";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { settingsStyles } from "@/styles/settings";
import { useUsageDisplay } from "@/usage/display";
import { useAppSettings } from "@/hooks/use-settings";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { GatewayCheckinSection } from "./checkin-card";
import { GatewayQuotaSection } from "./usage-quotas";
import { formatCompact, formatPercent, formatUsd, useSyncUsage } from "./usage-data";

/**
 * The Usage page's Overview: what the window came to, how it moved, and who
 * spent it — myna's shape, with Neolix's components and colour.
 */
export function GatewayUsageOverview({
  serverId,
  report,
  refreshMs,
  isLoading,
  error,
  openProvider,
}: {
  serverId: string;
  report: GatewayUsageReportWire | null;
  refreshMs: number;
  isLoading: boolean;
  error: Error | null;
  /** Opens a provider's editor, from a plan card's missing key. */
  openProvider?: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const { display } = useUsageDisplay([]);
  // myna's Hide accounts is a setting (Privacy › Sharing), shared by the
  // usage pages; the page's own button flips the same value.
  const { settings, updateSettings } = useAppSettings();
  const maskAccounts = settings.maskAccounts;
  const displayOptions = useMemo(
    () => [
      { value: "used" as const, label: t("settings.gatewayPages.usage.quotaUsed") },
      { value: "remaining" as const, label: t("settings.gatewayPages.usage.quotaRemaining") },
    ],
    [t],
  );
  const toggleMask = useCallback(
    () => void updateSettings({ maskAccounts: !maskAccounts }),
    [maskAccounts, updateSettings],
  );

  return (
    <View style={styles.root}>
      <GatewayCheckinSection serverId={serverId} maskAccounts={maskAccounts} />
      <View style={styles.quotaHead}>
        <SegmentedControl
          options={displayOptions}
          value={display.displayAs}
          onValueChange={display.setDisplayAs}
          size="sm"
        />
        <Button variant="ghost" size="sm" onPress={toggleMask}>
          {maskAccounts
            ? t("settings.gatewayPages.usage.showAccounts")
            : t("settings.gatewayPages.usage.maskAccounts")}
        </Button>
      </View>
      <GatewayQuotaSection
        serverId={serverId}
        refreshMs={refreshMs}
        displayAs={display.displayAs}
        maskAccounts={maskAccounts}
        {...(openProvider === undefined ? {} : { onOpenProvider: openProvider })}
      />

      <Text style={styles.groupTitle}>{t("settings.gatewayPages.usage.quota.agentTitle")}</Text>
      <HostUsageSection serverId={serverId} maskAccounts={maskAccounts} />

      <UsageReportSection report={report} isLoading={isLoading} error={error} />

      <SyncUsageSection serverId={serverId} refreshMs={refreshMs} />

      {report === null ? null : (
        <Text style={styles.note}>
          {t("settings.gatewayPages.usage.note", { path: report.path })}
        </Text>
      )}
    </View>
  );
}

/** The ledger's part of the overview: the period's totals, once they are read. */
export function UsageReportSection({
  report,
  isLoading,
  error,
}: {
  report: GatewayUsageReportWire | null;
  isLoading: boolean;
  error: Error | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  if (report === null) {
    return <UsageReportPlaceholder isLoading={isLoading} error={error} />;
  }
  if (report.totals.calls === 0 && report.totals.failed === 0) {
    return (
      <View style={[settingsStyles.card, styles.empty]}>
        <Text style={styles.emptyTitle}>{t(emptyPeriodKey(report.period))}</Text>
        <Text style={styles.emptyHint}>{t("settings.gatewayPages.usage.emptyHint")}</Text>
      </View>
    );
  }
  return (
    <>
      <View style={styles.kpis}>
        <Kpi
          value={formatCompact(report.totals.inputTokens + report.totals.outputTokens, locale)}
          label={t("settings.gatewayPages.usage.kpi.tokens")}
          sub={t("settings.gatewayPages.usage.kpi.inOut", {
            input: formatCompact(report.totals.inputTokens, locale),
            output: formatCompact(report.totals.outputTokens, locale),
          })}
        />
        <Kpi
          value={formatCompact(report.totals.cacheReadTokens, locale)}
          label={t("settings.gatewayPages.usage.kpi.cacheRead")}
          sub={
            report.totals.cacheHitRate === null
              ? undefined
              : t("settings.gatewayPages.usage.kpi.hitRate", {
                  pct: formatPercent(report.totals.cacheHitRate, locale),
                })
          }
          note={
            report.totals.cacheWriteTokens > 0
              ? t("settings.gatewayPages.usage.kpi.written", {
                  n: formatCompact(report.totals.cacheWriteTokens, locale),
                })
              : undefined
          }
        />
        <Kpi
          value={formatCompact(report.totals.reasoningTokens, locale)}
          label={t("settings.gatewayPages.usage.kpi.reasoning")}
          sub={t("settings.gatewayPages.usage.kpi.insideOutput")}
        />
        <Kpi
          value={new Intl.NumberFormat(locale).format(report.totals.calls)}
          label={t("settings.gatewayPages.usage.kpi.calls")}
          sub={summarizeFaults(report.totals, t)}
        />
      </View>

      <UsageChart report={report} />

      <Ranking
        title={t("settings.gatewayPages.usage.rankings.agents")}
        groups={report.byClient}
        total={report.totals.inputTokens + report.totals.outputTokens}
      />
      <Ranking
        title={t("settings.gatewayPages.usage.rankings.models")}
        groups={report.byModel}
        total={report.totals.inputTokens + report.totals.outputTokens}
      />
      <Ranking
        title={t("settings.gatewayPages.usage.rankings.providers")}
        groups={report.byProvider}
        total={report.totals.inputTokens + report.totals.outputTokens}
      />
      {report.byAccount.length === 0 ? null : (
        <Ranking
          title={t("settings.gatewayPages.usage.rankings.accounts")}
          groups={report.byAccount}
          total={report.totals.inputTokens + report.totals.outputTokens}
          unnamed={t("settings.gatewayPages.usage.accountNotRecorded")}
        />
      )}
      {report.byKey.length === 0 ? null : (
        <Ranking
          title={t("settings.gatewayPages.usage.rankings.keys")}
          groups={report.byKey}
          total={report.totals.inputTokens + report.totals.outputTokens}
          unnamed={t("settings.gatewayPages.usage.noKey")}
        />
      )}
    </>
  );
}

/** The ledger's own part, waiting or unreadable, under the allowances that loaded first. */
function UsageReportPlaceholder({ isLoading, error }: { isLoading: boolean; error: Error | null }) {
  const { t } = useTranslation();
  if (isLoading || error === null) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }
  return (
    <Alert
      variant="error"
      title={t("settings.gatewayPages.usage.errors.unreadable")}
      description={error.message}
    />
  );
}

function emptyPeriodKey(period: GatewayUsageReportWire["period"]): string {
  switch (period) {
    case "today":
      return "settings.gatewayPages.usage.noCallsToday";
    case "7d":
      return "settings.gatewayPages.usage.noCallsWeek";
    case "30d":
      return "settings.gatewayPages.usage.noCallsMonth";
    case "all":
      return "settings.gatewayPages.usage.noCallsAll";
    case "custom":
      return "settings.gatewayPages.usage.noCallsCustom";
  }
}

function summarizeFaults(
  totals: GatewayUsageTotalsWire,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  const parts: string[] = [];
  if (totals.failed > 0) {
    parts.push(t("settings.gatewayPages.usage.kpi.failed", { n: totals.failed }));
  }
  if (totals.retried > 0) {
    parts.push(t("settings.gatewayPages.usage.kpi.retried", { n: totals.retried }));
  }
  if (totals.unpricedCalls > 0) {
    parts.push(t("settings.gatewayPages.usage.kpi.unpriced", { n: totals.unpricedCalls }));
  }
  if (totals.meanTtftMs !== null) {
    parts.push(
      t("settings.gatewayPages.usage.kpi.ttft", { ms: Math.round(totals.meanTtftMs).toString() }),
    );
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join(" · ");
}

function Kpi({
  value,
  label,
  sub,
  note,
}: {
  value: string;
  label: string;
  sub?: string;
  note?: string;
}) {
  return (
    <View style={[settingsStyles.card, styles.kpi]}>
      <Text style={styles.kpiValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.kpiLabel}>{label}</Text>
      {sub === undefined ? null : <Text style={styles.kpiSub}>{sub}</Text>}
      {note === undefined ? null : <Text style={styles.kpiNote}>{note}</Text>}
    </View>
  );
}

/** One bar per hour or day: output sits on top of input. */
function UsageChart({ report }: { report: GatewayUsageReportWire }) {
  const { t, i18n } = useTranslation();
  const peak = Math.max(1, ...report.series.map((point) => point.inputTokens + point.outputTokens));
  const visible = report.series.filter((point) => point.calls > 0);
  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={styles.chartHead}>
        <Text style={styles.cardTitle}>{t("settings.gatewayPages.usage.chartTitle")}</Text>
        <Text style={styles.chartPeak}>
          {t("settings.gatewayPages.usage.peak", {
            n: formatCompact(peak, i18n.resolvedLanguage),
          })}
        </Text>
      </View>
      <View style={styles.bars}>
        {report.series.map((point) => {
          const total = point.inputTokens + point.outputTokens;
          return (
            <View key={point.start} style={styles.barSlot}>
              <View
                style={[
                  styles.bar,
                  { height: `${(100 * point.outputTokens) / peak}%` },
                  total === 0 ? styles.barEmpty : null,
                ]}
              />
              <View
                style={[
                  styles.bar,
                  styles.barInput,
                  { height: `${(100 * point.inputTokens) / peak}%` },
                  total === 0 ? styles.barEmpty : null,
                ]}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.labels}>
        {report.series.map((point, index) => (
          <Text key={point.start} style={styles.label}>
            {shouldLabel(index, report.series.length) ? point.label : ""}
          </Text>
        ))}
      </View>
      {visible.length === 0 ? null : (
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, styles.barInput]} />
            <Text style={styles.legendText}>{t("settings.gatewayPages.usage.legend.input")}</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.swatch, styles.barOutput]} />
            <Text style={styles.legendText}>{t("settings.gatewayPages.usage.legend.output")}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * The calls the other computers share through sync, by day: one strip for
 * them all and a line a computer, as myna's Usage page keeps the computers
 * apart (#542). Nothing until a host has shared usage to draw.
 */
function SyncUsageSection({ serverId, refreshMs }: { serverId: string; refreshMs: number }) {
  const { t, i18n } = useTranslation();
  const { usage, error } = useSyncUsage({ serverId, refreshMs });
  const computers = usage.computers;
  // myna's page has no Computer list until another computer's usage came.
  if (error !== null || computers === undefined || computers.length === 0) {
    return null;
  }
  const series = usage.series ?? [];
  const locale = i18n.resolvedLanguage;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const tokensOf = (value: { input?: number; output?: number }) =>
    (value.input ?? 0) + (value.output ?? 0);
  const peak = Math.max(1, ...series.map(tokensOf));
  const totalTokens =
    usage.input === undefined
      ? series.reduce((sum, point) => sum + tokensOf(point), 0)
      : tokensOf(usage);
  const totalCalls = usage.calls ?? series.reduce((sum, point) => sum + (point.calls ?? 0), 0);
  const totalCost = usage.cost ?? series.reduce((sum, point) => sum + (point.cost ?? 0), 0);
  // The latest calls the other computers made, newest first (myna's rows
  // name their computer; this computer's leave it empty).
  const latest = (usage.rows ?? []).filter((row) => row.computer !== undefined).slice(0, 5);
  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={styles.chartHead}>
        <Text style={styles.cardTitle}>{t("settings.gatewayPages.usage.computers.title")}</Text>
        <Text style={styles.chartPeak}>
          {t("settings.gatewayPages.usage.computers.summary", {
            tokens: formatCompact(totalTokens, locale),
            calls: number(totalCalls),
            cost: formatUsd(totalCost, locale),
          })}
        </Text>
      </View>
      <View style={styles.bars}>
        {series.map((point) => {
          const total = tokensOf(point);
          return (
            <View key={point.time ?? point.label} style={styles.barSlot}>
              <View
                style={[
                  styles.bar,
                  { height: `${(100 * total) / peak}%` },
                  total === 0 ? styles.barEmpty : null,
                ]}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.labels}>
        {series.map((point, index) => (
          <Text key={point.time ?? point.label} style={styles.label}>
            {shouldLabel(index, series.length) ? (point.label ?? "").slice(5) : ""}
          </Text>
        ))}
      </View>
      {computers.map((computer) => (
        <View key={computer.id} style={styles.deviceRow}>
          <Text style={styles.deviceName} numberOfLines={1}>
            {computer.id === "this"
              ? t("settings.gatewayPages.usage.computers.thisComputer")
              : (computer.name ?? computer.id)}
          </Text>
          <Text style={styles.deviceMeta} numberOfLines={1}>
            {t("settings.gatewayPages.usage.computers.device", {
              tokens: formatCompact(tokensOf(computer), locale),
              calls: number(computer.calls ?? 0),
              cost: formatUsd(computer.cost ?? 0, locale),
            })}
          </Text>
        </View>
      ))}
      {latest.length === 0 ? null : (
        <>
          <Text style={styles.syncRecent}>{t("settings.gatewayPages.usage.computers.recent")}</Text>
          {latest.map((row) => (
            <View
              key={[
                row.t ?? "",
                row.computer ?? "",
                row.provider ?? "",
                row.model ?? "",
                row.in ?? 0,
                row.out ?? 0,
                row.status ?? 0,
                row.ms ?? 0,
              ].join("|")}
              style={styles.deviceRow}
            >
              <Text style={styles.deviceName} numberOfLines={1}>
                {row.computerName ?? row.computer ?? ""}
                {row.model === undefined ? "" : ` · ${row.model}`}
              </Text>
              <Text style={styles.deviceMeta} numberOfLines={1}>
                {`${formatCompact((row.in ?? 0) + (row.out ?? 0), locale)} · ${
                  row.priced === false ? "—" : formatUsd(row.cost ?? 0, locale)
                } · ${syncTimeLabel(row.t, locale)}`}
              </Text>
            </View>
          ))}
        </>
      )}
      <Text style={styles.syncNote}>{t("settings.gatewayPages.usage.computers.note")}</Text>
    </View>
  );
}

/** A call's time on the reader's clock, as myna's request log writes it. */
function syncTimeLabel(iso: string | undefined, locale: string | undefined): string {
  if (iso === undefined) {
    return "";
  }
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) {
    return "";
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** Six labels over a long strip, every bar over a short one. */
function shouldLabel(index: number, count: number): boolean {
  if (count <= 8) {
    return true;
  }
  const every = count <= 31 ? Math.ceil(count / 6) : Math.ceil(count / 5);
  return index % every === 0;
}

function Ranking({
  title,
  groups,
  total,
  unnamed,
}: {
  title: string;
  groups: readonly GatewayUsageGroupWire[];
  total: number;
  unnamed?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  if (groups.length === 0) {
    return null;
  }
  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={styles.rankHead}>
        <Text style={styles.rankTitle}>{title.toUpperCase()}</Text>
      </View>
      {groups.map((group) => {
        const tokens = group.inputTokens + group.outputTokens;
        const share = total > 0 ? Math.max(1.5, (100 * tokens) / total) : 0;
        const name = group.name.length > 0 ? group.name : (unnamed ?? "");
        return (
          <View key={group.id} style={styles.rankRow}>
            <View style={styles.rankWho}>
              <Text style={styles.rankName} numberOfLines={1}>
                {name}
              </Text>
              <Text style={styles.rankSub} numberOfLines={1}>
                {rankSubtitle(group, t, locale)}
              </Text>
            </View>
            <View style={styles.rankTrack}>
              <View style={[styles.rankFill, { width: `${share}%` }]} />
            </View>
            <View style={styles.rankNum}>
              <Text style={styles.rankTokens}>{formatCompact(tokens, locale)}</Text>
              <Text style={styles.rankDetail} numberOfLines={1}>
                {t("settings.gatewayPages.usage.rankDetail", {
                  input: formatCompact(group.inputTokens, locale),
                  output: formatCompact(group.outputTokens, locale),
                  cache: formatCompact(group.cacheReadTokens, locale),
                })}
                {group.cacheHitRate === null
                  ? ""
                  : ` · ${t("settings.gatewayPages.usage.kpi.hitRate", {
                      pct: formatPercent(group.cacheHitRate, locale),
                    })}`}
              </Text>
            </View>
            <Text style={styles.rankCost}>
              {group.costUsd > 0 ? `≈${formatUsd(group.costUsd, locale)}` : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function rankSubtitle(
  group: GatewayUsageGroupWire,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale: string | undefined,
): string {
  const parts: string[] = [];
  if (group.sub !== undefined) {
    parts.push(group.sub);
  }
  parts.push(
    group.calls === 1
      ? t("settings.gatewayPages.usage.oneCall", { n: group.calls })
      : t("settings.gatewayPages.usage.calls", {
          n: new Intl.NumberFormat(locale).format(group.calls),
        }),
  );
  if (group.failed > 0) {
    parts.push(t("settings.gatewayPages.usage.kpi.failed", { n: group.failed }));
  }
  if (group.retried > 0) {
    parts.push(t("settings.gatewayPages.usage.kpi.retried", { n: group.retried }));
  }
  if (group.meanTtftMs !== null) {
    parts.push(
      t("settings.gatewayPages.usage.kpi.ttft", { ms: Math.round(group.meanTtftMs).toString() }),
    );
  }
  return parts.join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[4],
  },
  quotaHead: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    justifyContent: "flex-end",
  },
  loading: {
    alignItems: "center",
    padding: theme.spacing[8],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    letterSpacing: 0.6,
    textTransform: "uppercase",
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
  kpis: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  kpi: {
    flexBasis: 0,
    flexGrow: 1,
    gap: theme.spacing[1],
    minWidth: 150,
    padding: theme.spacing[4],
  },
  kpiValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
  kpiLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kpiSub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  kpiNote: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    padding: theme.spacing[4],
  },
  chartHead: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: theme.spacing[4],
  },
  cardTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chartPeak: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  bars: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 2,
    height: 140,
  },
  barSlot: {
    flex: 1,
    height: "100%",
    justifyContent: "flex-end",
  },
  bar: {
    backgroundColor: theme.colors.accent,
    borderRadius: 2,
    minHeight: 0,
    width: "100%",
  },
  barInput: {
    backgroundColor: theme.colors.surface4,
  },
  barOutput: {
    backgroundColor: theme.colors.accent,
  },
  barEmpty: {
    backgroundColor: theme.colors.surface2,
    height: 1,
  },
  deviceRow: {
    alignItems: "center",
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
    justifyContent: "space-between",
    marginTop: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  deviceName: {
    color: theme.colors.foreground,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  deviceMeta: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  syncRecent: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[3],
  },
  syncNote: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  labels: {
    flexDirection: "row",
    gap: 2,
    marginTop: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundExtraMuted,
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  legend: {
    flexDirection: "row",
    gap: theme.spacing[4],
    marginTop: theme.spacing[3],
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
  legendText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rankHead: {
    marginBottom: theme.spacing[2],
  },
  rankTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    letterSpacing: 0.6,
  },
  rankRow: {
    alignItems: "center",
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  rankWho: {
    width: 170,
  },
  rankName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rankSub: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rankTrack: {
    backgroundColor: theme.colors.surface3,
    borderRadius: 2,
    flexGrow: 1,
    height: 4,
    overflow: "hidden",
  },
  rankFill: {
    backgroundColor: theme.colors.foregroundMuted,
    borderRadius: 2,
    height: "100%",
  },
  rankNum: {
    alignItems: "flex-end",
    width: 170,
  },
  rankTokens: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rankDetail: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rankCost: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
    width: 80,
  },
  note: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
