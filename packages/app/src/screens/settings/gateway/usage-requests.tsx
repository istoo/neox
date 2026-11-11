/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-new-array-as-prop -- one closure per request row, none of them in a hot list. */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  GatewayHistoryRouteWire,
  GatewayUsageReportWire,
  GatewayUsageRequestWire,
} from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectField } from "@/components/ui/select-field";
import { settingsStyles } from "@/styles/settings";
import { HistoryDetail } from "./routing-history";
import type { GatewayUsageFilters } from "./usage-data";
import { formatCallTime, formatCompact, formatMs, formatUsd } from "./usage-data";

export type GatewayUsageStatusFilter = "all" | "failed" | "retried";

/** Neolix's own probes, named in the request log as myna names them. */
const PROBE_LABEL_KEYS = {
  test: "settings.gatewayPages.usage.probes.test",
  detect: "settings.gatewayPages.usage.probes.detect",
  list: "settings.gatewayPages.usage.probes.list",
} as const;

interface FilterOption {
  value: string;
  label: string;
}

/**
 * The Requests page: one line per call through the gateway, newest first,
 * a page at a time, with the filters the ledger can answer.
 */
export function GatewayUsageRequests({
  serverId,
  report,
  filters,
  status,
  onStatusChange,
  onQueryChange,
  onClientChange,
  onProviderChange,
  onModelChange,
  onAccountChange,
  onKeyChange,
  onPageChange,
  onExport,
  exporting,
  exportError,
}: {
  serverId: string;
  report: GatewayUsageReportWire;
  filters: GatewayUsageFilters;
  status: GatewayUsageStatusFilter;
  onStatusChange: (status: GatewayUsageStatusFilter) => void;
  onQueryChange: (query: string) => void;
  onClientChange: (client: string | undefined) => void;
  onProviderChange: (provider: string | undefined) => void;
  onModelChange: (model: string | undefined) => void;
  onAccountChange: (account: string | undefined) => void;
  onKeyChange: (key: string | undefined) => void;
  onPageChange: (offset: number) => void;
  onExport: () => void;
  exporting: boolean;
  exportError: string | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const now = Date.now();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggleOpen = useCallback((key: string) => {
    setOpenKey((current) => (current === key ? null : key));
  }, []);
  const page = report.requests;
  const statusOptions = [
    { value: "all" as const, label: t("settings.gatewayPages.usage.requests.all") },
    { value: "failed" as const, label: t("settings.gatewayPages.usage.requests.failed") },
    { value: "retried" as const, label: t("settings.gatewayPages.usage.requests.retried") },
  ];
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = page.offset + page.rows.length;
  const goPrevious = useCallback(
    () => onPageChange(Math.max(0, page.offset - page.limit)),
    [onPageChange, page.offset, page.limit],
  );
  const goNext = useCallback(
    () => onPageChange(page.offset + page.limit),
    [onPageChange, page.offset, page.limit],
  );

  const clientOptions = optionsOf(report.byClient);
  const providerOptions = optionsOf(report.byProvider);
  const modelOptions = optionsOf(report.byModel);
  const accountOptions = report.byAccount.map((group) => ({
    value: group.id,
    label: group.name.length > 0 ? group.name : t("settings.gatewayPages.usage.accountNotRecorded"),
  }));
  const keyOptions = report.byKey.map((group) => ({
    value: group.id,
    label: group.name.length > 0 ? group.name : group.id,
  }));

  return (
    <View style={styles.root}>
      <View style={styles.filters}>
        <SegmentedControl
          options={statusOptions}
          value={status}
          onValueChange={onStatusChange}
          size="sm"
          testID="gateway-usage-status"
        />
        <FilterSelect
          label={t("settings.gatewayPages.usage.filters.client")}
          allLabel={t("settings.gatewayPages.usage.filters.allClients")}
          value={filters.client}
          options={clientOptions}
          onChange={onClientChange}
          testID="gateway-usage-filter-client"
        />
        <FilterSelect
          label={t("settings.gatewayPages.usage.filters.provider")}
          allLabel={t("settings.gatewayPages.usage.filters.allProviders")}
          value={filters.provider}
          options={providerOptions}
          onChange={onProviderChange}
          testID="gateway-usage-filter-provider"
        />
        <FilterSelect
          label={t("settings.gatewayPages.usage.filters.model")}
          allLabel={t("settings.gatewayPages.usage.filters.allModels")}
          value={filters.model}
          options={modelOptions}
          onChange={onModelChange}
          testID="gateway-usage-filter-model"
        />
        <FilterSelect
          label={t("settings.gatewayPages.usage.filters.account")}
          allLabel={t("settings.gatewayPages.usage.filters.allAccounts")}
          value={filters.account}
          options={accountOptions}
          onChange={onAccountChange}
          testID="gateway-usage-filter-account"
        />
        <FilterSelect
          label={t("settings.gatewayPages.usage.filters.key")}
          allLabel={t("settings.gatewayPages.usage.filters.allKeys")}
          value={filters.key}
          options={keyOptions}
          onChange={onKeyChange}
          testID="gateway-usage-filter-key"
        />
        <View style={styles.search}>
          <FormTextInput
            initialValue={filters.query ?? ""}
            onChangeText={onQueryChange}
            placeholder={t("settings.gatewayPages.usage.requests.search")}
            size="sm"
            autoCapitalize="none"
            autoCorrect={false}
            testID="gateway-usage-search"
          />
        </View>
        <Button variant="outline" size="sm" loading={exporting} onPress={onExport}>
          {t("settings.gatewayPages.usage.requests.export")}
        </Button>
      </View>

      <Text style={styles.unavailable}>{t("settings.gatewayPages.usage.filters.unavailable")}</Text>

      {exportError === null ? null : <Text style={styles.exportError}>{exportError}</Text>}

      <View style={settingsStyles.card}>
        <View style={styles.summaryRow}>
          <Text style={styles.summary}>
            {page.total === 1
              ? t("settings.gatewayPages.usage.requests.oneRequest", { n: page.total })
              : t("settings.gatewayPages.usage.requests.requests", {
                  n: new Intl.NumberFormat(locale).format(page.total),
                })}
          </Text>
          <Text style={styles.summary}>
            {t("settings.gatewayPages.usage.requests.range", { from: first, to: last })}
          </Text>
        </View>

        {page.rows.length === 0 ? (
          <Text style={styles.empty}>{t("settings.gatewayPages.usage.requests.none")}</Text>
        ) : (
          page.rows.map((row) => {
            const key = requestKey(row);
            const open = key === openKey;
            return (
              <View key={key}>
                <Button
                  variant="ghost"
                  size="sm"
                  style={styles.rowButton}
                  onPress={() => toggleOpen(key)}
                  testID={`gateway-usage-request-${key}`}
                >
                  <RequestRow row={row} now={now} />
                </Button>
                {open ? <HistoryDetail route={historyRouteOf(row)} serverId={serverId} /> : null}
              </View>
            );
          })
        )}

        <View style={styles.pager}>
          <Button variant="ghost" size="sm" disabled={page.offset === 0} onPress={goPrevious}>
            {t("settings.gatewayPages.usage.requests.previous")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={page.offset + page.limit >= page.total}
            onPress={goNext}
          >
            {t("settings.gatewayPages.usage.requests.next")}
          </Button>
        </View>
      </View>
    </View>
  );
}

function optionsOf(groups: GatewayUsageReportWire["byClient"]): FilterOption[] {
  return groups.map((group) => ({
    value: group.id,
    label: group.name.length > 0 ? group.name : group.id,
  }));
}

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
  testID,
}: {
  label: string;
  allLabel: string;
  value: string | undefined;
  options: readonly FilterOption[];
  onChange: (value: string | undefined) => void;
  testID: string;
}) {
  const all = useMemo(
    () => [
      { id: "", value: "", label: allLabel },
      ...options.map((option) => ({ id: option.value, value: option.value, label: option.label })),
    ],
    [allLabel, options],
  );
  const selected = options.find((option) => option.value === value);
  const selectedDisplay = useMemo(
    () => ({ label: value === undefined ? allLabel : (selected?.label ?? value) }),
    [allLabel, selected?.label, value],
  );
  const handleChange = useCallback(
    (next: string) => onChange(next === "" ? undefined : next),
    [onChange],
  );
  return (
    <View style={styles.filterSelect}>
      <SelectField
        label={label}
        value={value ?? ""}
        selectedDisplay={selectedDisplay}
        options={all}
        onChange={handleChange}
        placeholder={allLabel}
        emptyText={allLabel}
        title={label}
        size="sm"
        field={false}
        searchable={options.length > 6}
        testID={testID}
      />
    </View>
  );
}

function RequestRow({ row, now }: { row: GatewayUsageRequestWire; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const failed = !row.ok && !row.handedOn;
  const models =
    row.requested.length > 0 && row.requested !== row.model
      ? `${row.requested} → ${row.model}`
      : row.model;
  const details = [
    ...(row.probe === undefined ? [] : [t(PROBE_LABEL_KEYS[row.probe])]),
    row.provider,
    row.account ?? t("settings.gatewayPages.usage.accountNotRecorded"),
    t("settings.gatewayPages.usage.requests.tokens", {
      input: formatCompact(row.inputTokens, locale),
      output: formatCompact(row.outputTokens, locale),
    }),
    ...(row.cacheReadTokens > 0
      ? [
          t("settings.gatewayPages.usage.requests.cache", {
            n: formatCompact(row.cacheReadTokens, locale),
          }),
        ]
      : []),
    formatMs(row.durationMs),
    ...(row.ttftMs === undefined
      ? []
      : [t("settings.gatewayPages.usage.kpi.ttft", { ms: String(Math.round(row.ttftMs)) })]),
    ...(row.attempts > 1
      ? [t("settings.gatewayPages.usage.requests.attempts", { n: row.attempts })]
      : []),
    ...(row.handedOn ? [t("settings.gatewayPages.usage.requests.handedOn")] : []),
  ];
  return (
    <View style={[styles.row, failed ? styles.rowFailed : null]}>
      <View style={styles.rowTop}>
        <Text style={styles.time}>{formatCallTime(row.time, locale, now)}</Text>
        <Text style={styles.client} numberOfLines={1}>
          {row.client}
        </Text>
        <Text style={[styles.model, failed ? styles.modelFailed : null]} numberOfLines={1}>
          {models}
        </Text>
        <Text style={[styles.status, failed ? styles.statusFailed : null]}>
          {failed ? String(row.status) : "OK"}
        </Text>
        <Text style={styles.cost}>{row.costUsd > 0 ? formatUsd(row.costUsd, locale) : "—"}</Text>
      </View>
      <Text style={styles.rowBottom} numberOfLines={1}>
        {details.join(" · ")}
      </Text>
    </View>
  );
}

/** The row a page opens: its request id, or its place in the log. */
function requestKey(row: GatewayUsageRequestWire): string {
  return row.requestId ?? `${row.time}|${row.model}|${row.status}`;
}

/** A ledger row as the detail component reads a routing-history row. */
function historyRouteOf(row: GatewayUsageRequestWire): GatewayHistoryRouteWire {
  return {
    id: requestKey(row),
    time: row.time,
    asked: row.requested,
    served: row.model,
    model: row.model,
    client: row.client,
    status: row.status,
    millis: row.durationMs,
    ...(row.session === undefined ? {} : { session: row.session }),
    ...(row.responseId === undefined ? {} : { responseId: row.responseId }),
    ...(row.archive === undefined ? {} : { archive: row.archive }),
  };
}

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.spacing[3],
  },
  filters: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  filterSelect: {
    minWidth: 132,
  },
  search: {
    flexGrow: 1,
    maxWidth: 280,
    minWidth: 170,
  },
  exportError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  unavailable: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  rowButton: {
    justifyContent: "flex-start",
    width: "100%",
  },
  summaryRow: {
    alignItems: "center",
    borderBottomColor: theme.colors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[6],
    textAlign: "center",
  },
  row: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  rowFailed: {
    backgroundColor: theme.colors.surface2,
  },
  rowTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    width: 116,
  },
  client: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    width: 110,
  },
  model: {
    color: theme.colors.foreground,
    flexGrow: 1,
    fontSize: theme.fontSize.sm,
  },
  modelFailed: {
    color: theme.colors.statusDanger,
  },
  status: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    width: 48,
  },
  statusFailed: {
    color: theme.colors.statusDanger,
  },
  cost: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
    width: 80,
  },
  rowBottom: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingLeft: 116 + 110 + 24,
  },
  pager: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
}));
