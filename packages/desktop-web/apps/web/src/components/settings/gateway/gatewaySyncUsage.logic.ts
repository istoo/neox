// FILE: gatewaySyncUsage.logic.ts
// Purpose: Turn the daemon's shared-usage report into the rows the Usage page draws:
//          per-device totals, the shared day series, other computers' recent calls and
//          each merged account's quota history.
// Layer: Settings logic
import type { NeolixSyncUsage, NeolixSyncUsageRow } from "@synara/contracts";

export interface SyncUsageTotalsView {
  tokens: number;
  calls: number;
  cost: number;
}

export interface SyncUsageSeriesPointView {
  key: string;
  label: string;
  tokens: number;
  calls: number;
  cost: number;
}

export interface SyncUsageDeviceView extends SyncUsageTotalsView {
  id: string;
  name: string;
  isThis: boolean;
}

export interface SyncUsageRecentCallView {
  key: string;
  computer: string;
  model: string;
  tokens: number;
  cost: number | null;
  at: string;
}

export interface SyncUsageQuotaPointView {
  at: string;
  left: number;
}

export interface SyncUsageQuotaView {
  key: string;
  provider: string;
  account: string;
  name: string;
  latestLeft: number | null;
  latestAt: string | null;
  points: readonly SyncUsageQuotaPointView[];
}

export interface SyncUsageView {
  totals: SyncUsageTotalsView;
  series: readonly SyncUsageSeriesPointView[];
  devices: readonly SyncUsageDeviceView[];
  recentCalls: readonly SyncUsageRecentCallView[];
  quotas: readonly SyncUsageQuotaView[];
  hasSharedUsage: boolean;
}

/** Tokens a point counts; myna's Usage page adds input and output, not cache reads. */
function tokensOf(value: { input?: number | undefined; output?: number | undefined }): number {
  return (value.input ?? 0) + (value.output ?? 0);
}

function recentCallKey(row: NeolixSyncUsageRow): string {
  return [row.t, row.computer ?? "", row.model, row.in + row.out].join("|");
}

function quotaPoints(
  points: ReadonlyArray<{ at: string; left: number }>,
): SyncUsageQuotaPointView[] {
  return points
    .map((point) => ({ at: point.at, left: point.left }))
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

export function buildSyncUsageView(usage: NeolixSyncUsage): SyncUsageView {
  const series = (usage.series ?? []).map((point) => ({
    key: point.label,
    label: point.label,
    tokens: tokensOf(point),
    calls: point.calls,
    cost: point.cost,
  }));
  const seriesCalls = series.reduce((sum, point) => sum + point.calls, 0);
  const seriesTokens = series.reduce((sum, point) => sum + point.tokens, 0);
  const seriesCost = series.reduce((sum, point) => sum + point.cost, 0);
  const devices = (usage.computers ?? []).map((computer) => ({
    id: computer.id,
    name: computer.name,
    isThis: computer.id === "this",
    tokens: tokensOf(computer),
    calls: computer.calls,
    cost: computer.cost,
  }));
  const recentCalls = (usage.rows ?? [])
    .filter((row) => row.computer !== undefined)
    .slice(0, 5)
    .map((row) => ({
      key: recentCallKey(row),
      computer: row.computerName ?? row.computer ?? "",
      model: row.model,
      tokens: row.in + row.out,
      cost: row.priced ? row.cost : null,
      at: row.t,
    }));
  const quotas = (usage.quotaHistory ?? []).flatMap((history) =>
    history.lines.flatMap((line) => {
      const points = quotaPoints(line.points);
      if (points.length === 0) return [];
      return [
        {
          key: `${history.provider}/${history.user}/${line.name}`,
          provider: history.provider,
          account: history.user,
          name: line.name,
          latestLeft: points[points.length - 1]?.left ?? null,
          latestAt: points[points.length - 1]?.at ?? null,
          points,
        },
      ];
    }),
  );

  return {
    // A period total that survived an older host wins; otherwise the series is the source.
    totals: {
      tokens:
        usage.input === undefined && usage.output === undefined ? seriesTokens : tokensOf(usage),
      calls: usage.calls ?? seriesCalls,
      cost: usage.cost ?? seriesCost,
    },
    series,
    devices,
    recentCalls,
    quotas,
    hasSharedUsage: devices.length > 0 || quotas.length > 0,
  };
}

/**
 * Percent-left readings as an SVG path across `width`, with 100% at the top. A single
 * reading draws a flat line so the newest account still has something to show.
 */
export function sparklinePath(
  points: ReadonlyArray<{ left: number }>,
  width: number,
  height: number,
): string {
  if (points.length === 0) return "";
  const yOf = (left: number) => {
    const clamped = Math.min(100, Math.max(0, left));
    return height - (clamped / 100) * height;
  };
  if (points.length === 1) {
    const y = yOf(points[0]?.left ?? 0);
    return `M0,${y} L${width},${y}`;
  }
  return points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * width;
      return `${index === 0 ? "M" : "L"}${x},${yOf(point.left)}`;
    })
    .join(" ");
}
