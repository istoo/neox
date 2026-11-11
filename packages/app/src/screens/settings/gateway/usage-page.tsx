import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayUsagePeriodWire } from "@neolix/protocol/gateway";
import { RotateCw } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField } from "@/components/ui/select-field";
import { hostFeatureAvailability } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { GatewayRequestArchive } from "./request-archive-settings";
import { GatewayUsageContext } from "./usage-context";
import { GatewayUsageOverview } from "./usage-overview";
import { GatewayUsageRequests, type GatewayUsageStatusFilter } from "./usage-requests";
import { GatewayUsageSessions } from "./usage-sessions";
import { GatewayUsageTune } from "./usage-tune";
import {
  fetchAllUsageRows,
  formatUsd,
  REFRESH_INTERVALS,
  usageCsv,
  usageExportName,
  useGatewayUsage,
  type GatewayUsageFilters,
} from "./usage-data";
import { saveUsageCsv } from "./usage-export";
import type { GatewayPageProps } from "./types";

/** The Usage page's sub-pages; the settings sidebar mirrors them. */
export type GatewayUsageView = "overview" | "requests" | "sessions" | "context";

const DAY_MS = 24 * 60 * 60 * 1000;

export function GatewayUsagePage({
  serverId,
  config,
  apply,
  edit,
  openProvider,
  view: controlledView,
  onViewChange,
}: GatewayPageProps & {
  /** The sub-page the sidebar selected; the page keeps its own when none is given. */
  view?: GatewayUsageView;
  onViewChange?: (view: GatewayUsageView) => void;
}) {
  const { t, i18n } = useTranslation();
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const supported = hostFeatureAvailability(serverInfo, "gatewayUsageReport");
  const client = useHostRuntimeClient(serverId);
  const [localView, setLocalView] = useState<GatewayUsageView>("overview");
  const view = controlledView ?? localView;
  const setView = useCallback(
    (next: GatewayUsageView) => {
      setLocalView(next);
      onViewChange?.(next);
    },
    [onViewChange],
  );
  const [period, setPeriod] = useState<GatewayUsagePeriodWire>("7d");
  const [from, setFrom] = useState(() => dayKey(new Date(Date.now() - 6 * DAY_MS)));
  const [to, setTo] = useState(() => dayKey(new Date()));
  const [refreshSeconds, setRefreshSeconds] = useState<number>(5);
  const [status, setStatus] = useState<GatewayUsageStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [clientFilter, setClientFilter] = useState<string | undefined>(undefined);
  const [providerFilter, setProviderFilter] = useState<string | undefined>(undefined);
  const [modelFilter, setModelFilter] = useState<string | undefined>(undefined);
  const [accountFilter, setAccountFilter] = useState<string | undefined>(undefined);
  const [keyFilter, setKeyFilter] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const filters = useMemo<GatewayUsageFilters>(
    () => ({
      ...(clientFilter === undefined ? {} : { client: clientFilter }),
      ...(providerFilter === undefined ? {} : { provider: providerFilter }),
      ...(modelFilter === undefined ? {} : { model: modelFilter }),
      ...(accountFilter === undefined ? {} : { account: accountFilter }),
      ...(keyFilter === undefined ? {} : { key: keyFilter }),
      ...(status === "failed" ? { failedOnly: true } : {}),
      ...(status === "retried" ? { retriedOnly: true } : {}),
      ...(query.trim().length === 0 ? {} : { query: query.trim() }),
      ...(period === "custom" ? { from, to } : {}),
      offset: view === "requests" ? offset : 0,
    }),
    [
      clientFilter,
      providerFilter,
      modelFilter,
      accountFilter,
      keyFilter,
      status,
      query,
      period,
      from,
      to,
      offset,
      view,
    ],
  );

  const { report, isLoading, isRefreshing, error, refresh } = useGatewayUsage({
    serverId,
    period,
    filters,
    refreshMs: refreshSeconds * 1_000,
  });

  const changePeriod = useCallback((next: GatewayUsagePeriodWire) => {
    setPeriod(next);
    setOffset(0);
  }, []);
  const changeStatus = useCallback((next: GatewayUsageStatusFilter) => {
    setStatus(next);
    setOffset(0);
  }, []);
  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setOffset(0);
  }, []);
  const changeClient = useCallback((next: string | undefined) => {
    setClientFilter(next);
    setOffset(0);
  }, []);
  const changeProvider = useCallback((next: string | undefined) => {
    setProviderFilter(next);
    setOffset(0);
  }, []);
  const changeModel = useCallback((next: string | undefined) => {
    setModelFilter(next);
    setOffset(0);
  }, []);
  const changeAccount = useCallback((next: string | undefined) => {
    setAccountFilter(next);
    setOffset(0);
  }, []);
  const changeKey = useCallback((next: string | undefined) => {
    setKeyFilter(next);
    setOffset(0);
  }, []);

  const exportCsv = useCallback(async () => {
    if (client === null) {
      setExportError(t("settings.gatewayPages.usage.errors.disconnected"));
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const rows = await fetchAllUsageRows({
        client,
        period,
        filters,
        unreadableMessage: t("settings.gatewayPages.usage.errors.unreadable"),
      });
      await saveUsageCsv(
        usageCsv(rows),
        usageExportName(period, new Date()),
        t("settings.gatewayPages.usage.errors.noDownloadDirectory"),
      );
    } catch (cause) {
      setExportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  }, [client, period, filters, t]);

  const viewOptions = useMemo(
    () => [
      { value: "overview" as const, label: t("settings.gatewayPages.usage.views.overview") },
      { value: "requests" as const, label: t("settings.gatewayPages.usage.views.requests") },
      { value: "sessions" as const, label: t("settings.gatewayPages.usage.views.sessions") },
      { value: "context" as const, label: t("settings.gatewayPages.usage.views.context") },
    ],
    [t],
  );
  const periodOptions = useMemo(
    () => [
      { value: "today" as const, label: t("settings.gatewayPages.usage.period.today") },
      { value: "7d" as const, label: t("settings.gatewayPages.usage.period.week") },
      { value: "30d" as const, label: t("settings.gatewayPages.usage.period.month") },
      { value: "all" as const, label: t("settings.gatewayPages.usage.period.all") },
      { value: "custom" as const, label: t("settings.gatewayPages.usage.period.custom") },
    ],
    [t],
  );
  const refreshOptions = useMemo(
    () =>
      REFRESH_INTERVALS.map((seconds) => ({
        id: String(seconds),
        value: seconds,
        label: refreshLabel(seconds, t),
      })),
    [t],
  );
  const refreshDisplay = useMemo(
    () => ({ label: refreshLabel(refreshSeconds, t) }),
    [refreshSeconds, t],
  );
  const changeRefresh = useCallback((seconds: number) => setRefreshSeconds(seconds), []);

  if (supported === false) {
    return <Text style={styles.message}>{t("settings.gatewayPages.usage.errors.updateHost")}</Text>;
  }

  let body: ReactNode;
  if (view === "overview") {
    // The allowances load on their own, before — and without — the ledger.
    body = (
      <GatewayUsageOverview
        serverId={serverId}
        report={report}
        refreshMs={refreshSeconds * 1_000}
        isLoading={isLoading}
        error={error}
        {...(openProvider === undefined ? {} : { openProvider })}
      />
    );
  } else if (error !== null) {
    body = (
      <Alert
        variant="error"
        title={t("settings.gatewayPages.usage.errors.unreadable")}
        description={error.message}
      />
    );
  } else if (isLoading || report === null) {
    body = (
      <View style={styles.loading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  } else if (view === "requests") {
    body = (
      <>
        <GatewayRequestArchive config={config} apply={apply} edit={edit} />
        <GatewayUsageRequests
          serverId={serverId}
          report={report}
          filters={filters}
          status={status}
          onStatusChange={changeStatus}
          onQueryChange={changeQuery}
          onClientChange={changeClient}
          onProviderChange={changeProvider}
          onModelChange={changeModel}
          onAccountChange={changeAccount}
          onKeyChange={changeKey}
          onPageChange={setOffset}
          onExport={exportCsv}
          exporting={exporting}
          exportError={exportError}
        />
      </>
    );
  } else if (view === "sessions") {
    body = <GatewayUsageSessions report={report} />;
  } else {
    body = (
      <>
        <GatewayUsageContext report={report} />
        <GatewayUsageTune serverId={serverId} />
      </>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <SegmentedControl
          options={viewOptions}
          value={view}
          onValueChange={setView}
          size="sm"
          testID="gateway-usage-view"
        />
        <View style={styles.controls}>
          <SegmentedControl
            options={periodOptions}
            value={period}
            onValueChange={changePeriod}
            size="sm"
            testID="gateway-usage-period"
          />
          <View style={styles.refreshSelect}>
            <SelectField
              label={t("settings.gatewayPages.usage.autoRefresh")}
              value={refreshSeconds}
              selectedDisplay={refreshDisplay}
              options={refreshOptions}
              onChange={changeRefresh}
              placeholder={t("settings.gatewayPages.usage.autoRefresh")}
              emptyText={t("settings.gatewayPages.usage.autoRefresh")}
              title={t("settings.gatewayPages.usage.autoRefresh")}
              size="sm"
              field={false}
              testID="gateway-usage-refresh-every"
            />
          </View>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={RotateCw}
            loading={isRefreshing}
            onPress={refresh}
            accessibilityLabel={t("settings.gatewayPages.usage.refresh")}
            testID="gateway-usage-refresh"
          >
            {t("settings.gatewayPages.usage.refresh")}
          </Button>
        </View>
      </View>

      {period === "custom" ? (
        <View style={styles.range}>
          <View style={styles.rangeField}>
            <FormTextInput
              initialValue={from}
              onChangeText={setFrom}
              placeholder="YYYY-MM-DD"
              size="sm"
              autoCapitalize="none"
              autoCorrect={false}
              testID="gateway-usage-from"
            />
          </View>
          <Text style={styles.rangeDash}>–</Text>
          <View style={styles.rangeField}>
            <FormTextInput
              initialValue={to}
              onChangeText={setTo}
              placeholder="YYYY-MM-DD"
              size="sm"
              autoCapitalize="none"
              autoCorrect={false}
              testID="gateway-usage-to"
            />
          </View>
          {isDayKey(from) && isDayKey(to) ? null : (
            <Text style={styles.rangeHint}>{t("settings.gatewayPages.usage.customRangeHint")}</Text>
          )}
        </View>
      ) : null}

      {report === null ? null : (
        <View style={styles.costLine}>
          <Text style={styles.cost}>{formatUsd(report.totals.costUsd, i18n.resolvedLanguage)}</Text>
          <Text style={styles.costNote}>{unpricedNote(t, report.totals.unpricedCalls)}</Text>
        </View>
      )}

      {body}
    </View>
  );
}

function refreshLabel(
  seconds: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (seconds === 0) {
    return t("settings.gatewayPages.usage.refreshOff");
  }
  if (seconds >= 60) {
    return t("settings.gatewayPages.usage.refreshMinute");
  }
  return t("settings.gatewayPages.usage.refreshEvery", { n: seconds });
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function unpricedNote(
  t: (key: string, options?: Record<string, unknown>) => string,
  n: number,
): string {
  if (n === 1) {
    return t("settings.gatewayPages.usage.unpricedOne", { n });
  }
  if (n > 1) {
    return t("settings.gatewayPages.usage.unpriced", { n });
  }
  return t("settings.gatewayPages.usage.effectivePrices");
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[4],
  },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  controls: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  refreshSelect: {
    minWidth: 96,
  },
  range: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  rangeField: {
    width: 140,
  },
  rangeDash: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  rangeHint: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  costLine: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  cost: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
  },
  costNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loading: {
    alignItems: "center",
    padding: theme.spacing[8],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
