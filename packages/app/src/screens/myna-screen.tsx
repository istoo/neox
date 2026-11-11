import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostFeature } from "@/runtime/host-features";
import { providerModelCount } from "@/screens/settings/gateway/providers-helpers";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import {
  formatCompact,
  formatUsd,
  useGatewayQuota,
  useGatewayUsage,
} from "@/screens/settings/gateway/usage-data";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { GatewayQuotaAccountWire, GatewayQuotaWindowWire } from "@neolix/protocol/gateway";

/**
 * The overview, allowances and usage sections of the Models & quota page,
 * read through the selected host's gateway. These used to be myna's own page;
 * the page chrome and host picker now live in the feature screen.
 */
export function GatewayOverviewView({ serverId }: { serverId: string }): ReactElement {
  return (
    <GatewayFeatureGate serverId={serverId} feature="gatewayUsageReport">
      <MynaOverview serverId={serverId} />
    </GatewayFeatureGate>
  );
}

export function GatewayAllowancesView({ serverId }: { serverId: string }): ReactElement {
  return (
    <GatewayFeatureGate serverId={serverId} feature="gatewayQuotas">
      <MynaAllowances serverId={serverId} />
    </GatewayFeatureGate>
  );
}

export function GatewayUsageView({ serverId }: { serverId: string }): ReactElement {
  return (
    <GatewayFeatureGate serverId={serverId} feature="gatewayUsageReport">
      <MynaUsage serverId={serverId} />
    </GatewayFeatureGate>
  );
}

function GatewayFeatureGate({
  serverId,
  feature,
  children,
}: {
  serverId: string;
  feature: "gatewayQuotas" | "gatewayUsageReport";
  children: ReactElement;
}): ReactElement {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, feature);
  if (!connected) {
    return (
      <Alert variant="warning" description={t("settings.gatewayPages.usage.errors.disconnected")} />
    );
  }
  if (!supported) {
    return (
      <Alert variant="warning" description={t("settings.gatewayPages.usage.errors.updateHost")} />
    );
  }
  return children;
}

function MynaOverview({ serverId }: { serverId: string }) {
  const { t, i18n } = useTranslation();
  const { config, status, isLoading, error, refresh } = useGatewayConfig(serverId);
  const usage = useGatewayUsage({ serverId, period: "today", filters: {}, refreshMs: 0 });
  const totals = usage.report?.totals ?? null;
  const running = status?.enabled === true;
  const modelCount = config?.providers?.reduce(
    (sum, provider) => sum + providerModelCount(provider),
    0,
  );

  if (error) {
    return <MynaReadError error={error} onRetry={refresh} />;
  }
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.loadingColor.color} />
      </View>
    );
  }

  return (
    <>
      <SettingsCard testID="myna-overview">
        <SettingsRow label={t("modelsPage.gateway")}>
          <StatusBadge
            variant={running ? "success" : "muted"}
            label={running ? t("featurePages.myna.connected") : t("featurePages.myna.disabled")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("modelsPage.sourcesCount", { count: config?.providers?.length ?? 0 })}
          hint={t("featurePages.myna.models", { count: modelCount ?? 0 })}
        />
        <SettingsRow label={t("featurePages.myna.calls")} hint={t("featurePages.myna.today")}>
          <Text style={styles.value}>
            {totals === null ? "—" : formatCompact(totals.calls, i18n.language)}
          </Text>
        </SettingsRow>
        <SettingsRow label={t("featurePages.myna.cost")} hint={t("featurePages.myna.today")}>
          <Text style={styles.value}>
            {totals === null ? "—" : formatUsd(totals.costUsd, i18n.language)}
          </Text>
        </SettingsRow>
      </SettingsCard>
      {usage.error ? <MynaReadError error={usage.error} onRetry={usage.refresh} /> : null}
      {totals?.calls === 0 ? (
        <Text style={styles.empty}>{t("featurePages.myna.empty")}</Text>
      ) : null}
    </>
  );
}

function MynaAllowances({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { quota, isLoading, error, refresh } = useGatewayQuota({
    serverId,
    trend: "cycle",
    refreshMs: 0,
  });

  if (error) {
    return <MynaReadError error={error} onRetry={refresh} />;
  }
  if (isLoading) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.loadingColor.color} />
      </View>
    );
  }

  if (quota === null || quota.accounts.length === 0) {
    return <Text style={styles.empty}>{t("featurePages.myna.noAllowances")}</Text>;
  }

  return (
    <View style={styles.accountList}>
      {quota.accounts.map((account) => (
        <AllowanceCard key={account.id} account={account} />
      ))}
    </View>
  );
}

function AllowanceCard({ account }: { account: GatewayQuotaAccountWire }) {
  const { i18n } = useTranslation();
  const spend = useMemo(
    () => <Text style={styles.value}>{formatUsd(account.spendUsd, i18n.language)}</Text>,
    [account.spendUsd, i18n.language],
  );
  return (
    <SettingsCard testID={`myna-allowance-${account.id}`}>
      <SettingsRow label={account.providerLabel} hint={account.accountLabel}>
        {spend}
      </SettingsRow>
      {account.windows.map((window) => (
        <AllowanceWindow key={window.id} window={window} />
      ))}
    </SettingsCard>
  );
}

function AllowanceWindow({ window }: { window: GatewayQuotaWindowWire }) {
  const { t, i18n } = useTranslation();
  const used = window.usedPercent;
  const value = used === null ? "—" : `${Math.round(used)}%`;
  const width = `${Math.min(100, Math.max(0, used ?? 0))}%` as const;
  const resets =
    window.resetsAt === null
      ? null
      : new Date(window.resetsAt).toLocaleString(i18n.language, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  const hint = resets === null ? undefined : t("featurePages.myna.windowResets", { time: resets });
  const trailing = useMemo(
    () => (
      <View style={styles.windowTrailing}>
        <View style={styles.track}>
          <View style={[styles.fill, { width }]} />
        </View>
        <Text style={styles.value}>{value}</Text>
      </View>
    ),
    [width, value],
  );
  return (
    <SettingsRow label={window.name ?? window.id} hint={hint}>
      {trailing}
    </SettingsRow>
  );
}

function MynaUsage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  return (
    <View style={styles.periodList}>
      <UsagePeriod serverId={serverId} period="today" label={t("featurePages.myna.today")} />
      <UsagePeriod serverId={serverId} period="7d" label={t("featurePages.myna.sevenDays")} />
      <UsagePeriod serverId={serverId} period="30d" label={t("featurePages.myna.thirtyDays")} />
      <Text style={styles.footnote}>{t("modelsPage.usageHint")}</Text>
    </View>
  );
}

function UsagePeriod({
  serverId,
  period,
  label,
}: {
  serverId: string;
  period: "today" | "7d" | "30d";
  label: string;
}) {
  const { t, i18n } = useTranslation();
  const { report, isLoading, error, refresh } = useGatewayUsage({
    serverId,
    period,
    filters: {},
    refreshMs: 0,
  });
  if (error) {
    return <MynaReadError error={error} onRetry={refresh} />;
  }
  const totals = report?.totals ?? null;
  const calls = totals === null ? "—" : formatCompact(totals.calls, i18n.language);
  const failed = totals === null ? "—" : formatCompact(totals.failed, i18n.language);
  const callsHint = `${t("featurePages.myna.calls")} ${calls} · ${t("featurePages.myna.failedCalls")} ${failed}`;
  const cost = isLoading || totals === null ? "—" : formatUsd(totals.costUsd, i18n.language);
  const tokens =
    totals === null
      ? "—"
      : `${formatCompact(totals.inputTokens + totals.outputTokens, i18n.language)} / ${formatCompact(
          totals.cacheReadTokens,
          i18n.language,
        )}`;
  return (
    <SettingsCard>
      <SettingsRow label={label} hint={callsHint}>
        <Text style={styles.value}>{cost}</Text>
      </SettingsRow>
      <SettingsRow label={t("featurePages.myna.tokens")} hint={t("featurePages.myna.cache")}>
        <Text style={styles.value}>{tokens}</Text>
      </SettingsRow>
    </SettingsCard>
  );
}

function MynaReadError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.readError} testID="myna-read-error">
      <Alert variant="error" description={error.message} />
      <View style={styles.readErrorAction}>
        <Button variant="ghost" onPress={onRetry} testID="myna-retry">
          {t("common.actions.retry")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
  },
  loadingColor: {
    color: theme.colors.foregroundMuted,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
  },
  readError: {
    gap: theme.spacing[2],
  },
  readErrorAction: {
    flexDirection: "row",
  },
  accountList: {
    gap: theme.spacing[3],
  },
  periodList: {
    gap: theme.spacing[3],
  },
  windowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 140,
  },
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
  footnote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
