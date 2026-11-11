import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  GatewayQuotaWire,
  GatewayUsagePeriodWire,
  GatewayUsageReportWire,
  GatewayUsageRequestWire,
} from "@neolix/protocol/gateway";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { cnyPerUsd, formatCount, getDisplayPreferences } from "@/usage/currency";

export interface GatewayUsageFilters {
  client?: string;
  provider?: string;
  model?: string;
  account?: string;
  key?: string;
  failedOnly?: boolean;
  retriedOnly?: boolean;
  query?: string;
  offset?: number;
  /** The first and last days of a custom window, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

export interface GatewayUsageResult {
  report: GatewayUsageReportWire | null;
  isLoading: boolean;
  isRefreshing: boolean;
  error: Error | null;
  refresh: () => void;
}

export const PAGE_LIMIT = 100;
/** The most rows an export asks for: ten pages of the largest page. */
export const EXPORT_ROW_LIMIT = 5_000;

/** myna's refresh choices: off, then 5 s to a minute. */
export const REFRESH_INTERVALS = [0, 5, 10, 30, 60] as const;
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number];

export function gatewayUsageQueryKey(
  serverId: string,
  period: GatewayUsagePeriodWire,
  filters: GatewayUsageFilters,
) {
  return [
    "gateway-usage",
    serverId,
    period,
    filters.from ?? "",
    filters.to ?? "",
    filters.client ?? "",
    filters.provider ?? "",
    filters.model ?? "",
    filters.account ?? "",
    filters.key ?? "",
    filters.failedOnly === true ? "failed" : "",
    filters.retriedOnly === true ? "retried" : "",
    filters.query ?? "",
    filters.offset ?? 0,
  ] as const;
}

function usageRequestBody(period: GatewayUsagePeriodWire, filters: GatewayUsageFilters) {
  return {
    period,
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    ...(period === "custom" && filters.from !== undefined ? { from: filters.from } : {}),
    ...(period === "custom" && filters.to !== undefined ? { to: filters.to } : {}),
    ...(filters.client === undefined ? {} : { client: filters.client }),
    ...(filters.provider === undefined ? {} : { provider: filters.provider }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
    ...(filters.account === undefined ? {} : { account: filters.account }),
    ...(filters.key === undefined ? {} : { key: filters.key }),
    ...(filters.failedOnly === true ? { failed: true } : {}),
    ...(filters.retriedOnly === true ? { retried: true } : {}),
    ...(filters.query === undefined || filters.query.length === 0 ? {} : { query: filters.query }),
  };
}

/**
 * One read of the usage report. Auto refresh polls the daemon while the page
 * asks for it; the ledger is a file the daemon already has open.
 */
export function useGatewayUsage({
  serverId,
  period,
  filters,
  refreshMs,
}: {
  serverId: string;
  period: GatewayUsagePeriodWire;
  filters: GatewayUsageFilters;
  refreshMs: number;
}): GatewayUsageResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "gatewayUsageReport");
  const queryKey = useMemo(
    () => gatewayUsageQueryKey(serverId, period, filters),
    [serverId, period, filters],
  );
  const enabled = Boolean(client) && isConnected && supported;
  const customWindowReady =
    period !== "custom" || (filters.from !== undefined && filters.to !== undefined);

  const query = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: enabled && customWindowReady,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    queryFn: async (): Promise<GatewayUsageReportWire> => {
      if (!client) {
        throw new Error(t("settings.gatewayPages.usage.errors.disconnected"));
      }
      const result = await client.getGatewayUsage({
        ...usageRequestBody(period, filters),
        limit: PAGE_LIMIT,
        offset: filters.offset ?? 0,
      });
      if (result.report === null) {
        throw new Error(result.error ?? t("settings.gatewayPages.usage.errors.unreadable"));
      }
      return result.report;
    },
  });

  return {
    report: query.data ?? null,
    isLoading: query.isLoading,
    isRefreshing: query.isFetching && !query.isLoading,
    error: query.error,
    refresh: () => {
      void query.refetch();
    },
  };
}

/**
 * The figures a day, a computer or the period adds up (myna `usage.Totals`).
 * Every field is optional so a host between shared-usage shapes still parses.
 */
export interface SyncUsageTotalsView {
  calls?: number;
  errors?: number;
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  cost?: number;
  unpriced?: number;
}

/** One point of the 90-day series (myna `usage.Point`); zero days are kept. */
export interface SyncUsageSeriesPointView extends SyncUsageTotalsView {
  label?: string;
  time?: string;
}

/** One computer's part of the period (myna `usage.Share`); this one is `this`. */
export interface SyncUsageComputerView extends SyncUsageTotalsView {
  id: string;
  name?: string;
}

/** One call of the shared ledger (myna `usageapi.Row`). */
export interface SyncUsageRowView {
  t?: string;
  agent?: string;
  provider?: string;
  providerAccount?: string;
  model?: string;
  in?: number;
  out?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  ms?: number;
  status?: number;
  cost?: number;
  priced?: boolean;
  /** Set on another computer's call; this computer's rows leave both empty. */
  computer?: string;
  computerName?: string;
}

/** One account's merged quota readings (myna `provider.QuotaHistory`). */
export interface SyncUsageQuotaHistoryView {
  provider?: string;
  user?: string;
  lines?: { name?: string; points?: { at?: string; left?: number; resetsAt?: string }[] }[];
}

/** What `sync.usage.get` answers: shared totals, series, computers, rows and quota history. */
export interface SyncUsagePayloadView extends SyncUsageTotalsView {
  period?: string;
  since?: string;
  bucket?: string;
  series?: SyncUsageSeriesPointView[];
  /** Only when another computer shares its usage; this one is `this`. */
  computers?: SyncUsageComputerView[];
  rows?: SyncUsageRowView[];
  total?: number;
  quotaHistory?: SyncUsageQuotaHistoryView[];
}

export interface SyncUsageResult {
  usage: SyncUsagePayloadView;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * Every computer's shared usage, as the Usage page draws it (myna's
 * `davsync/usage.go` and the Usage page's own shape): the 90-day series,
 * each computer's share, the latest calls and the merged quota history.
 */
export function useSyncUsage({
  serverId,
  refreshMs,
}: {
  serverId: string;
  refreshMs: number;
}): SyncUsageResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "sync");
  const query = useFetchQuery({
    queryKey: ["sync-usage", serverId] as const,
    dataShape: "value",
    staleTimeMs: 60_000,
    enabled: Boolean(client) && isConnected && supported,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    queryFn: async (): Promise<SyncUsagePayloadView> => {
      if (!client) {
        throw new Error(t("settings.gatewayPages.usage.errors.disconnected"));
      }
      const result = await client.getSyncUsage();
      if (result.error !== undefined && result.error !== "") {
        throw new Error(result.error);
      }
      return result;
    },
  });
  return {
    usage: query.data ?? {},
    isLoading: query.isLoading,
    error: query.error,
    refresh: () => {
      void query.refetch();
    },
  };
}

/** myna's choices for the allowance curves: none, two days, or the window's own cycle. */
export type GatewayQuotaTrend = "off" | "2d" | "cycle";

/** How far back each choice reads. A cycle is a week at most, so a month covers it. */
export const GATEWAY_QUOTA_TREND_DAYS: Record<GatewayQuotaTrend, number> = {
  off: 1,
  "2d": 2,
  cycle: 30,
};

export interface GatewayQuotaResult {
  quota: GatewayQuotaWire | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

/**
 * The gateway accounts' own allowances: what their usage endpoints last
 * answered, and the readings kept over time for the curves.
 */
export function useGatewayQuota({
  serverId,
  trend,
  refreshMs,
}: {
  serverId: string;
  trend: GatewayQuotaTrend;
  refreshMs: number;
}): GatewayQuotaResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "gatewayQuotas");
  const historyDays = GATEWAY_QUOTA_TREND_DAYS[trend];
  // Opening the page and pressing refresh ask the vendors again (myna's
  // quotaReads: "asked"); the timer's own refetches use the readings kept.
  const readRequested = useRef(true);
  const query = useFetchQuery({
    queryKey: ["gateway-quota", serverId, historyDays] as const,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: Boolean(client) && isConnected && supported,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    queryFn: async (): Promise<GatewayQuotaWire> => {
      if (!client) {
        throw new Error(t("settings.gatewayPages.usage.errors.disconnected"));
      }
      const read = readRequested.current;
      readRequested.current = false;
      const result = await client.getGatewayQuota({
        historyDays,
        ...(read ? { read: true } : {}),
      });
      return result.quota;
    },
  });

  return {
    quota: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refresh: () => {
      readRequested.current = true;
      void query.refetch();
    },
  };
}

/** Every row the filters keep, a page at a time, up to EXPORT_ROW_LIMIT. */
export async function fetchAllUsageRows({
  client,
  period,
  filters,
  unreadableMessage = "Could not read the usage ledger.",
}: {
  client: DaemonClient;
  period: GatewayUsagePeriodWire;
  filters: GatewayUsageFilters;
  unreadableMessage?: string;
}): Promise<GatewayUsageRequestWire[]> {
  const rows: GatewayUsageRequestWire[] = [];
  let offset = 0;
  for (;;) {
    const result = await client.getGatewayUsage({
      ...usageRequestBody(period, filters),
      limit: 500,
      offset,
    });
    if (result.report === null) {
      throw new Error(result.error ?? unreadableMessage);
    }
    rows.push(...result.report.requests.rows);
    offset += result.report.requests.rows.length;
    if (offset >= result.report.requests.total || rows.length >= EXPORT_ROW_LIMIT) {
      return rows.slice(0, EXPORT_ROW_LIMIT);
    }
    if (result.report.requests.rows.length === 0) {
      return rows;
    }
  }
}

export { CSV_COLUMNS, usageCsv, usageExportName, usageCsvTime } from "./usage-csv";

/** A count in the reader's own form: 1.9M, or 185万 when Chinese units are on. */
export function formatCompact(value: number, locale: string | undefined): string {
  return formatCount(value, locale);
}

/**
 * What a call cost: cents for the ordinary, more digits for the tiny. Costs
 * are stored in USD and only what is shown follows the currency setting.
 */
export function formatUsd(value: number, locale: string | undefined): string {
  const currency = getDisplayPreferences().currency === "cny" ? "CNY" : "USD";
  const shown = currency === "CNY" ? value * cnyPerUsd() : value;
  if (value === 0) {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(0);
  }
  let digits = 2;
  if (shown < 0.01) {
    digits = 4;
  } else if (shown < 1) {
    digits = 3;
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: shown < 0.01 ? 2 : digits,
    maximumFractionDigits: digits,
  }).format(shown);
}

export function formatMs(ms: number): string {
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1).replace(/\.0$/, "")}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** The time of a call; the day too when it was not today. */
export function formatCallTime(iso: string, locale: string | undefined, now: number): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) {
    return "—";
  }
  const sameDay = at.toDateString() === new Date(now).toDateString();
  return at.toLocaleString(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatPercent(rate: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(rate);
}
