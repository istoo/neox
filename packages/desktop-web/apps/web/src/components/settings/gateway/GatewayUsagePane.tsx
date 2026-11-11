// FILE: GatewayUsagePane.tsx
// Purpose: The gateway's usage ledger — totals, series, breakdowns, request rows,
//          sessions, prompt composition, CSV export, check-in and tune advice.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayCheckin,
  GatewayConfig,
  GatewayUsageReport,
  GatewayUsageRequest,
  GatewayUsageTotals,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { downloadUsageCsv } from "./gatewayUsageCsv";
import { formatTokens, formatUsd, formatWhen } from "./gatewayHelpers";
import { GatewayEmpty, GatewayPill, GatewayRow, GatewayToggle } from "./GatewayPrimitives";

const PERIODS = ["today", "7d", "30d", "all", "custom"] as const;
type Period = (typeof PERIODS)[number];
const VIEWS = ["overview", "requests", "sessions", "context"] as const;
type UsageView = (typeof VIEWS)[number];
const PAGE_LIMIT = 50;
const EXPORT_ROW_LIMIT = 5_000;

/** Daemon check-in outcomes, localized here; the free-form message stays as returned. */
const CHECKIN_OUTCOME_KEYS: Record<string, string> = {
  done: "gateway:checkin_outcome_done",
  claimed: "gateway:checkin_outcome_claimed",
  inactive: "gateway:checkin_outcome_inactive",
  ineligible: "gateway:checkin_outcome_ineligible",
  failed: "gateway:checkin_outcome_failed",
};

interface UsageFilters {
  client?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  account?: string | undefined;
  key?: string | undefined;
  retried?: boolean | undefined;
}

export interface GatewayUsageProps {
  config: GatewayConfig;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function metricRows(totals: GatewayUsageTotals) {
  return [
    ["tokens", formatTokens(totals.inputTokens + totals.outputTokens)],
    ["cache_read", formatTokens(totals.cacheReadTokens)],
    ["reasoning", formatTokens(totals.reasoningTokens)],
    ["calls", totals.calls],
    ["failed", totals.failed],
    ["cost", formatUsd(totals.costUsd)],
  ] as const;
}

type UsageQueryInput = Parameters<typeof neolixGatewayApi.getUsage>[0];

async function runExportAll(
  buildQuery: (extra: { limit?: number; offset?: number }) => UsageQueryInput,
  period: Period,
  setExporting: (value: boolean) => void,
): Promise<void> {
  setExporting(true);
  try {
    const rows: GatewayUsageRequest[] = [];
    let nextOffset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (rows.length < Math.min(total, EXPORT_ROW_LIMIT)) {
      const page = await neolixGatewayApi.getUsage(buildQuery({ limit: 500, offset: nextOffset }));
      if (page.report === null) break;
      rows.push(...page.report.requests.rows);
      total = page.report.requests.total;
      if (page.report.requests.rows.length === 0) break;
      nextOffset += page.report.requests.rows.length;
    }
    downloadUsageCsv(rows, `neolix-usage-${period}-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setExporting(false);
  }
}

async function runCheckin(
  refetch: () => Promise<unknown>,
  doneTitle: string,
  setRunning: (value: boolean) => void,
): Promise<void> {
  setRunning(true);
  try {
    await neolixGatewayApi.checkinRun({});
    await refetch();
    toastManager.add({ type: "success", title: doneTitle });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setRunning(false);
  }
}

export function GatewayUsagePane({ config, apply }: GatewayUsageProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<UsageView>("overview");
  const [period, setPeriod] = useState<Period>("7d");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [filters, setFilters] = useState<UsageFilters>({});
  const [exporting, setExporting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [refreshMs, setRefreshMs] = useState(0);

  const usageQuery = (extra: { limit?: number; offset?: number } = {}) => ({
    period,
    ...extra,
    ...(period === "custom" && from ? { from } : {}),
    ...(period === "custom" && to ? { to } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
    ...(failedOnly ? { failed: true } : {}),
    ...(filters.client ? { client: filters.client } : {}),
    ...(filters.provider ? { provider: filters.provider } : {}),
    ...(filters.model ? { model: filters.model } : {}),
    ...(filters.account ? { account: filters.account } : {}),
    ...(filters.key ? { key: filters.key } : {}),
    ...(filters.retried ? { retried: true } : {}),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
  });

  const usage = useQuery({
    queryKey: [
      "neolix-gateway",
      "usage",
      period,
      from,
      to,
      query,
      failedOnly,
      filters,
      offset,
      view,
    ],
    queryFn: () =>
      neolixGatewayApi.getUsage(
        usageQuery(view === "requests" ? { limit: PAGE_LIMIT, offset } : {}),
      ),
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    enabled: period !== "custom" || (from.length > 0 && to.length > 0),
  });

  const report = usage.data?.report ?? null;

  const exportAll = () => runExportAll(usageQuery, period, setExporting);

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:usage_title">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <div className="flex flex-wrap gap-1">
            {PERIODS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setPeriod(option);
                  setOffset(0);
                }}
                className={`rounded-md border px-2 py-1 text-ui-xs ${
                  period === option
                    ? "border-foreground/25 bg-foreground/8 text-foreground"
                    : "border-[color:var(--color-border)] text-muted-foreground hover:text-foreground"
                }`}
              >
                {t(`gateway:period_${option}`)}
              </button>
            ))}
          </div>
          {period === "custom" ? (
            <>
              <input
                type="date"
                value={from}
                onChange={(event) => {
                  setFrom(event.currentTarget.value);
                  setOffset(0);
                }}
                className="h-7 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 text-ui-sm"
              />
              <span className="text-ui-xs text-muted-foreground">→</span>
              <input
                type="date"
                value={to}
                onChange={(event) => {
                  setTo(event.currentTarget.value);
                  setOffset(0);
                }}
                className="h-7 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 text-ui-sm"
              />
            </>
          ) : null}
          <select
            value={refreshMs}
            onChange={(event) => setRefreshMs(Number(event.currentTarget.value))}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value={0}>{t("gateway:refresh_off")}</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
            <option value={30000}>30s</option>
            <option value={60000}>60s</option>
          </select>
          <Button size="xs" variant="ghost" onClick={() => void usage.refetch()}>
            {t("gateway:refresh")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={exporting || !report || report.requests.total === 0}
            onClick={() => void exportAll()}
          >
            {exporting ? t("gateway:exporting") : t("gateway:export_csv")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {VIEWS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              className={`rounded-md border px-2 py-1 text-ui-xs ${
                view === option
                  ? "border-foreground/25 bg-foreground/8 text-foreground"
                  : "border-[color:var(--color-border)] text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`gateway:usage_view_${option}`)}
            </button>
          ))}
        </div>

        {usage.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : usage.error ? (
          <div className="px-3 py-2">
            <GatewayEmpty tone="error">{usage.data?.error ?? String(usage.error)}</GatewayEmpty>
          </div>
        ) : report === null ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_usage")}</GatewayEmpty>
          </div>
        ) : view === "overview" ? (
          <UsageOverview report={report} />
        ) : view === "requests" ? (
          <UsageRequests
            report={report}
            query={query}
            setQuery={setQuery}
            failedOnly={failedOnly}
            setFailedOnly={setFailedOnly}
            filters={filters}
            setFilters={setFilters}
            offset={offset}
            setOffset={setOffset}
          />
        ) : view === "sessions" ? (
          <UsageGroups
            title={t("gateway:sessions")}
            groups={report.bySession}
            empty={t("gateway:no_sessions")}
          />
        ) : (
          <UsageContext report={report} />
        )}
      </SettingsSection>

      <SettingsSection title="gateway:checkin_title">
        <CheckinCard config={config} apply={apply} />
      </SettingsSection>

      <SettingsSection title="gateway:tune_title">
        <TuneCard />
      </SettingsSection>
    </div>
  );
}

function UsageOverview({ report }: { report: GatewayUsageReport }) {
  const { t } = useTranslation();
  const totals = report.totals;
  const maxCalls = Math.max(1, ...report.series.map((point) => point.calls));
  return (
    <>
      <div className="grid grid-cols-2 gap-px bg-[color:var(--color-border)] sm:grid-cols-3 lg:grid-cols-6">
        {metricRows(totals).map(([key, value]) => (
          <div key={key} className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
            <div className="text-ui-xs text-muted-foreground">{t(`gateway:usage_kpi_${key}`)}</div>
            <div className="text-ui font-medium">{value}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-1.5 text-ui-xs text-muted-foreground">
        <span>
          {t("gateway:usage_kpi_hit_rate")}:{" "}
          {totals.cacheHitRate === null ? "—" : `${Math.round(totals.cacheHitRate)}%`}
        </span>
        <span>
          {t("gateway:usage_kpi_cache_write")}: {formatTokens(totals.cacheWriteTokens)}
        </span>
        <span>
          {t("gateway:usage_kpi_ttft")}: {formatMs(totals.meanTtftMs)}
        </span>
        <span>
          {t("gateway:usage_kpi_handed_on")}: {totals.handedOn}
        </span>
        <span>
          {t("gateway:usage_kpi_retried")}: {totals.retried}
        </span>
      </div>
      {totals.unpricedCalls > 0 ? (
        <div className="px-3 py-1.5 text-ui-xs text-muted-foreground">
          {t("gateway:unpriced", { count: totals.unpricedCalls })}
        </div>
      ) : null}
      {/* debt: 序列是简化条形；旧 UI 的折线/热力图与按小时钻取待补。 */}
      <div className="flex h-24 items-end gap-0.5 px-3 py-2">
        {report.series.slice(-60).map((point) => (
          <div
            key={`${point.start}-${point.label}`}
            title={`${point.label}: ${point.calls} · ${formatUsd(point.costUsd)}`}
            className="min-w-[3px] max-w-4 flex-1 rounded-sm bg-foreground/20 hover:bg-foreground/40"
            style={{ height: `${Math.max(2, (point.calls / maxCalls) * 100)}%` }}
          />
        ))}
      </div>
      <UsageGroups
        title={t("gateway:by_provider")}
        groups={report.byProvider}
        empty={t("gateway:no_usage")}
      />
      <UsageGroups
        title={t("gateway:by_model")}
        groups={report.byModel}
        empty={t("gateway:no_usage")}
      />
      <UsageGroups
        title={t("gateway:by_client")}
        groups={report.byClient}
        empty={t("gateway:no_usage")}
      />
      {report.byAccount.length > 0 ? (
        <UsageGroups
          title={t("gateway:by_account")}
          groups={report.byAccount}
          empty={t("gateway:no_usage")}
        />
      ) : null}
      {report.byKey.length > 0 ? (
        <UsageGroups
          title={t("gateway:by_key")}
          groups={report.byKey}
          empty={t("gateway:no_usage")}
        />
      ) : null}
      <div className="px-3 py-2 text-ui-xs text-muted-foreground">
        {t("gateway:ledger_path")} {report.path}
      </div>
    </>
  );
}

function UsageGroups({
  title,
  groups,
  empty,
}: {
  title: string;
  groups: GatewayUsageReport["byModel"];
  empty: string;
}) {
  const { t } = useTranslation();
  if (groups.length === 0) {
    return <GatewayEmpty>{empty}</GatewayEmpty>;
  }
  return (
    <div className="px-3 py-2">
      <div className="mb-1 text-ui-xs uppercase tracking-wide text-muted-foreground">{title}</div>
      {groups.slice(0, 20).map((group) => (
        <div
          key={group.id}
          className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] py-1 first:border-t-0"
        >
          <div className="min-w-0">
            <div className="truncate text-ui-sm">{group.name}</div>
            <div className="truncate text-ui-xs text-muted-foreground">
              {group.sub ? `${group.sub} · ` : ""}
              {t("gateway:group_detail", {
                input: formatTokens(group.inputTokens),
                output: formatTokens(group.outputTokens),
                cache: formatTokens(group.cacheReadTokens),
                hit: group.cacheHitRate === null ? "—" : `${Math.round(group.cacheHitRate)}%`,
              })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <GatewayPill>{t("gateway:calls_short", { count: group.calls })}</GatewayPill>
            <GatewayPill>{formatTokens(group.inputTokens + group.outputTokens)}</GatewayPill>
            <GatewayPill>{formatUsd(group.costUsd)}</GatewayPill>
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: Array<{ value: string; label: string }>;
  allLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-ui-xs text-muted-foreground">{label}</span>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
        className="h-7 max-w-44 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function groupOptions(groups: GatewayUsageReport["byModel"]) {
  return groups.map((group) => ({
    value: group.id,
    label: group.name.length > 0 ? group.name : group.id,
  }));
}

function UsageRequests({
  report,
  query,
  setQuery,
  failedOnly,
  setFailedOnly,
  filters,
  setFilters,
  offset,
  setOffset,
}: {
  report: GatewayUsageReport;
  query: string;
  setQuery: (value: string) => void;
  failedOnly: boolean;
  setFailedOnly: (value: boolean) => void;
  filters: UsageFilters;
  setFilters: (value: UsageFilters) => void;
  offset: number;
  setOffset: (value: number) => void;
}) {
  const { t } = useTranslation();
  const page = report.requests;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const change = (patch: UsageFilters) => {
    setFilters({ ...filters, ...patch });
    setOffset(0);
  };
  const anyFilter =
    failedOnly ||
    filters.retried === true ||
    Object.values(filters).some((value) => value !== undefined && value !== false);
  const status = filters.retried === true ? "retried" : failedOnly ? "failed" : "all";
  return (
    <>
      <div className="flex flex-wrap items-end gap-2 px-3 py-2">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOffset(0);
          }}
          placeholder={t("gateway:search_requests")}
          size="sm"
          variant="soft"
          className="min-w-40 flex-1"
        />
        <label className="flex flex-col gap-0.5">
          <span className="text-ui-xs text-muted-foreground">{t("gateway:request_status")}</span>
          <select
            value={status}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFailedOnly(value === "failed");
              change({ retried: value === "retried" ? true : undefined });
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value="all">{t("gateway:request_status_all")}</option>
            <option value="failed">{t("gateway:failed_only")}</option>
            <option value="retried">{t("gateway:retried_only")}</option>
          </select>
        </label>
        <FilterSelect
          label={t("gateway:filter_client")}
          value={filters.client}
          allLabel={t("gateway:filter_all_clients")}
          options={groupOptions(report.byClient)}
          onChange={(value) => change({ client: value })}
        />
        <FilterSelect
          label={t("gateway:filter_provider")}
          value={filters.provider}
          allLabel={t("gateway:filter_all_providers")}
          options={groupOptions(report.byProvider)}
          onChange={(value) => change({ provider: value })}
        />
        <FilterSelect
          label={t("gateway:filter_model")}
          value={filters.model}
          allLabel={t("gateway:filter_all_models")}
          options={groupOptions(report.byModel)}
          onChange={(value) => change({ model: value })}
        />
        <FilterSelect
          label={t("gateway:filter_account")}
          value={filters.account}
          allLabel={t("gateway:filter_all_accounts")}
          options={groupOptions(report.byAccount)}
          onChange={(value) => change({ account: value })}
        />
        <FilterSelect
          label={t("gateway:filter_key")}
          value={filters.key}
          allLabel={t("gateway:filter_all_keys")}
          options={groupOptions(report.byKey)}
          onChange={(value) => change({ key: value })}
        />
        {anyFilter ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setQuery("");
              setFailedOnly(false);
              setFilters({});
              setOffset(0);
            }}
          >
            {t("gateway:filter_clear")}
          </Button>
        ) : null}
        <span className="text-ui-xs text-muted-foreground">
          {t("gateway:rows", { count: page.total })}
        </span>
      </div>
      {page.rows.length === 0 ? (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:no_requests")}</GatewayEmpty>
        </div>
      ) : (
        page.rows.map((row) => {
          const key = `${row.time}-${row.model}-${row.provider}-${String(row.requestId ?? "")}`;
          const open = openKey === key;
          return (
            <div
              key={key}
              className="border-t border-[color:var(--color-border)] px-3 py-2 first:border-t-0"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-ui-sm font-medium">{row.model}</span>
                    <GatewayPill tone={row.ok ? "ok" : "error"}>{row.status}</GatewayPill>
                    <GatewayPill>{row.provider}</GatewayPill>
                    {row.account ? <GatewayPill>{row.account}</GatewayPill> : null}
                    {row.attempts > 1 ? (
                      <GatewayPill tone="warn">
                        {t("gateway:attempts", { count: row.attempts })}
                      </GatewayPill>
                    ) : null}
                    {row.session ? <GatewayPill>session</GatewayPill> : null}
                  </div>
                  <div className="mt-0.5 truncate text-ui-xs text-muted-foreground">
                    {formatWhen(row.time)} · {row.client} · {row.protocol} · {row.durationMs}ms
                  </div>
                  {row.errorMessage ? (
                    <div className="mt-0.5 text-ui-xs text-destructive">{row.errorMessage}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  <GatewayPill>{formatTokens(row.inputTokens)} in</GatewayPill>
                  <GatewayPill>{formatTokens(row.outputTokens)} out</GatewayPill>
                  <GatewayPill>{formatUsd(row.costUsd)}</GatewayPill>
                  {row.key ? <GatewayPill>{row.keyLabel ?? "key"}</GatewayPill> : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-expanded={open}
                    onClick={() => setOpenKey(open ? null : key)}
                  >
                    {open ? t("gateway:hide") : t("gateway:details")}
                  </Button>
                </div>
              </div>
              {open ? (
                <div className="mt-1.5 grid gap-x-4 gap-y-0.5 rounded-md bg-foreground/4 px-2 py-1.5 text-ui-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-3">
                  <span>
                    {t("gateway:detail_requested")}: {row.requested}
                  </span>
                  <span>
                    {t("gateway:detail_protocol")}: {row.protocol}
                  </span>
                  <span>
                    {t("gateway:detail_duration")}: {formatMs(row.durationMs)}
                  </span>
                  <span>
                    {t("gateway:detail_ttft")}: {formatMs(row.ttftMs)}
                  </span>
                  <span>
                    {t("gateway:detail_cache")}: {formatTokens(row.cacheReadTokens)} /{" "}
                    {formatTokens(row.cacheWriteTokens)}
                  </span>
                  <span>
                    {t("gateway:detail_reasoning")}: {formatTokens(row.reasoningTokens)}
                  </span>
                  <span>
                    {t("gateway:detail_session")}: {row.session ?? "—"}
                  </span>
                  <span>
                    {t("gateway:detail_key")}: {row.keyLabel ?? row.key ?? "—"}
                  </span>
                  <span>
                    {t("gateway:detail_route")}: {row.routeId ?? "—"}
                  </span>
                  <span>
                    {t("gateway:detail_archive")}: {row.archive ?? "—"}
                  </span>
                  <span>
                    {t("gateway:detail_request_id")}: {row.requestId ?? "—"}
                  </span>
                  <span>
                    {t("gateway:detail_endpoint")}: {row.endpoint ?? "—"}
                  </span>
                  {row.errorType ? (
                    <span>
                      {t("gateway:detail_error_type")}: {row.errorType}
                    </span>
                  ) : null}
                  {row.handedOn === true ? <span>{t("gateway:detail_handed_on")}</span> : null}
                  {row.probe ? (
                    <span>
                      {t("gateway:detail_probe")}: {row.probe}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      <div className="flex items-center justify-between px-3 py-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
        >
          {t("gateway:previous")}
        </Button>
        <span className="text-ui-xs text-muted-foreground">
          {page.total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_LIMIT, page.total)} /{" "}
          {page.total}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={offset + PAGE_LIMIT >= page.total}
          onClick={() => setOffset(offset + PAGE_LIMIT)}
        >
          {t("gateway:next")}
        </Button>
      </div>
    </>
  );
}

function UsageContext({ report }: { report: GatewayUsageReport }) {
  const { t } = useTranslation();
  const prompt = report.prompt;
  if (!prompt) {
    return <GatewayEmpty>{t("gateway:no_context")}</GatewayEmpty>;
  }
  const total = Math.max(1, prompt.tokens);
  return (
    <div className="px-3 py-2">
      <div className="mb-2 text-ui-sm">
        {t("gateway:context_tokens", { tokens: formatTokens(prompt.tokens) })}
      </div>
      {prompt.parts.map((part) => (
        <div key={part.kind} className="mb-2">
          <div className="mb-0.5 flex justify-between text-ui-xs text-muted-foreground">
            <span>{part.kind}</span>
            <span>{formatTokens(part.tokens)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-foreground/40"
              style={{ width: `${Math.round((part.tokens / total) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function CheckinCard({
  config,
  apply,
}: {
  config: GatewayConfig;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const checkin = useQuery({
    queryKey: ["neolix-gateway", "checkin"],
    queryFn: neolixGatewayApi.checkinStatus,
  });
  const [running, setRunning] = useState(false);
  const data: GatewayCheckin | undefined = checkin.data;
  const hasTargets =
    Object.keys(data?.switches ?? {}).length > 0 || (data?.accounts ?? []).length > 0;
  return (
    <>
      {checkin.isSuccess && !hasTargets ? (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:checkin_no_accounts")}</GatewayEmpty>
        </div>
      ) : (
        <>
          <GatewayRow
            title={t("gateway:checkin_now")}
            description={t("gateway:checkin_hint")}
            trailing={
              <Button
                size="xs"
                variant="outline"
                disabled={running}
                onClick={() =>
                  void runCheckin(checkin.refetch, t("gateway:checkin_done"), setRunning)
                }
              >
                {running ? t("gateway:checking") : t("gateway:checkin_now")}
              </Button>
            }
          />
          {(Object.entries(data?.switches ?? {}) as Array<[string, boolean]>).map(([by, on]) => (
            <GatewayRow
              key={by}
              title={by}
              description={t("gateway:checkin_switch_hint")}
              trailing={
                <GatewayToggle
                  checked={on === true}
                  label={by}
                  onChange={(checked) =>
                    void neolixGatewayApi.checkinSwitch({ by, on: checked }).then(() => {
                      void checkin.refetch();
                    })
                  }
                />
              }
            />
          ))}
          {(data?.accounts ?? []).map((account) => (
            <GatewayRow
              key={account.key}
              title={`${account.by} · ${account.user}`}
              description={
                account.record
                  ? [
                      t(
                        CHECKIN_OUTCOME_KEYS[account.record.outcome] ??
                          "gateway:checkin_outcome_unknown",
                      ),
                      account.record.msg,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : undefined
              }
              trailing={
                <GatewayToggle
                  checked={account.on !== false}
                  label={account.key}
                  onChange={(checked) =>
                    void neolixGatewayApi
                      .checkinAccount({ key: account.key, on: checked })
                      .then(() => {
                        void checkin.refetch();
                      })
                  }
                />
              }
            />
          ))}
        </>
      )}
      <GatewayRow
        title={t("gateway:quota_reads")}
        description={t("gateway:quota_reads_hint")}
        trailing={
          <GatewayToggle
            checked={config.quotaReads === "asked"}
            label={t("gateway:quota_reads")}
            onChange={(checked) =>
              void apply((draft) => {
                if (checked) draft.quotaReads = "asked";
                else delete draft.quotaReads;
              })
            }
          />
        }
      />
    </>
  );
}

function TuneCard() {
  const { t } = useTranslation();
  const tune = useQuery({
    queryKey: ["neolix-gateway", "tune"],
    queryFn: () => neolixGatewayApi.tuneGet(30),
  });
  const advice = tune.data?.advice ?? [];
  const apply = async (input: {
    agent: "claude" | "codex";
    knob: "compact" | "cache_ttl";
    value: string;
    model?: string | undefined;
  }) => {
    try {
      await neolixGatewayApi.tuneApply(input);
      toastManager.add({ type: "success", title: t("gateway:tune_applied") });
      void tune.refetch();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const undo = async (input: {
    agent: "claude" | "codex";
    knob: "compact" | "cache_ttl";
    model?: string | undefined;
  }) => {
    try {
      await neolixGatewayApi.tuneUndo(input);
      toastManager.add({ type: "success", title: t("gateway:tune_undone") });
      void tune.refetch();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (tune.isLoading) {
    return <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>;
  }
  if (advice.length === 0) {
    return <GatewayEmpty>{t("gateway:no_tune")}</GatewayEmpty>;
  }
  return (
    <>
      {advice.map((entry) => (
        <GatewayRow
          key={entry.agent}
          title={entry.agent}
          description={
            <span>
              {t("gateway:tune_calls", { count: entry.calls })}
              {entry.compact ? (
                <>
                  {" · "}
                  {t("gateway:tune_compact_detail", {
                    model: entry.compact.model ?? "",
                    current: entry.compact.current ?? "—",
                    best: entry.compact.best,
                  })}
                </>
              ) : null}
              {entry.ttl ? (
                <>
                  {" · "}
                  {t("gateway:tune_ttl_detail", {
                    current: entry.ttl.current ?? "—",
                    best: entry.ttl.best,
                  })}
                </>
              ) : null}
            </span>
          }
          trailing={
            <div className="flex flex-wrap gap-1">
              {entry.compact ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void apply({
                      agent: entry.agent as "claude" | "codex",
                      knob: "compact",
                      value: entry.compact!.best,
                      ...(entry.compact!.model ? { model: entry.compact!.model } : {}),
                    })
                  }
                >
                  compact {entry.compact.best}
                </Button>
              ) : null}
              {entry.ttl ? (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void apply({
                      agent: entry.agent as "claude" | "codex",
                      knob: "cache_ttl",
                      value: entry.ttl!.best,
                    })
                  }
                >
                  ttl {entry.ttl.best}
                </Button>
              ) : null}
              {entry.compact ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void undo({
                      agent: entry.agent as "claude" | "codex",
                      knob: "compact",
                      ...(entry.compact!.model ? { model: entry.compact!.model } : {}),
                    })
                  }
                >
                  {t("gateway:tune_undo_compact")}
                </Button>
              ) : null}
              {entry.ttl ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void undo({
                      agent: entry.agent as "claude" | "codex",
                      knob: "cache_ttl",
                    })
                  }
                >
                  {t("gateway:tune_undo_ttl")}
                </Button>
              ) : null}
            </div>
          }
        />
      ))}
      <div className="flex justify-end px-3 py-2">
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            for (const entry of advice) {
              await neolixGatewayApi
                .tuneUndo({
                  agent: entry.agent as "claude" | "codex",
                  knob: "compact",
                  ...(entry.compact?.model ? { model: entry.compact.model } : {}),
                })
                .catch(() => undefined);
              await neolixGatewayApi
                .tuneUndo({ agent: entry.agent as "claude" | "codex", knob: "cache_ttl" })
                .catch(() => undefined);
            }
            void tune.refetch();
          }}
        >
          {t("gateway:tune_undo")}
        </Button>
      </div>
    </>
  );
}
