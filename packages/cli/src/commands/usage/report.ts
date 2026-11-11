import { Command } from "commander";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type {
  GatewayUsageGroupWire,
  GatewayUsagePeriodWire,
  GatewayUsageReportWire,
  GatewayUsageTotalsWire,
} from "@neolix/protocol/gateway";
import { formatUsageCsvRows } from "@neolix/protocol/gateway-usage-csv";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import {
  addDaemonHostOption,
  addJsonOption,
  withGlobalOptions,
} from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";

/**
 * `neolix usage report` — myna's `myna usage` (internal/cli/usage_cli.go:37):
 * the tokens and cost of the gateway's calls, by agent, model, provider,
 * account, key and conversation, or every call of the period as CSV.
 *
 * myna's own command is `myna usage`; in Neolix `usage` is myna's `quota`
 * (see usage/index.ts), so the token report lives one word down.
 */

const DAY_MS = 86_400_000;
/** The gateway report's page size; its ceiling is 500. */
const PAGE = 500;

interface ReportClient {
  getLastServerInfoMessage(): {
    features?: { gatewayUsageReport?: boolean; gatewayUsageWindow?: boolean };
  } | null;
  getGatewayUsage: DaemonClient["getGatewayUsage"];
  close: DaemonClient["close"];
}
type ConnectReport = (options: ConnectOptions) => Promise<ReportClient>;

interface ReportOptions extends CommandOptions {
  csv?: boolean;
  account?: string;
  days?: string;
  last?: string;
}

export interface UsageReportSelection {
  period: GatewayUsagePeriodWire;
  from?: string;
  to?: string;
  /** "last N local days", when a rolling window was asked for. */
  days?: number;
  /** A rolling window shorter than a day, by the millisecond. */
  since?: number;
  until?: number;
  lastMs?: number;
}

function usageError(message: string): never {
  throw { code: "INVALID_OPTIONS", message };
}

function localDay(at: number, offsetMinutes: number): string {
  const date = new Date(at + offsetMinutes * 60_000);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

function periodOf(name: string | undefined): GatewayUsagePeriodWire {
  switch ((name ?? "30d").toLowerCase()) {
    case "today":
    case "day":
      return "today";
    case "7d":
    case "week":
      return "7d";
    case "30d":
    case "month":
      return "30d";
    case "all":
      return "all";
    default:
      return usageError(
        "usage: neox usage report [today|7d|30d|all] [--csv [--account <name>]] [--days <n>|--last <dur>]",
      );
  }
}

/** "--days" as whole local days, or "--last" as a window length. */
function windowAsked(options: ReportOptions): { days: number } | { ms: number } | undefined {
  if (options.days !== undefined && options.last !== undefined) {
    usageError("Take --days or --last, not both.");
  }
  if (options.days !== undefined) {
    const days = Number(options.days);
    if (!Number.isInteger(days) || days <= 0) {
      usageError(
        `${"--days"} takes a whole number of local days greater than zero, not ${JSON.stringify(options.days)}.`,
      );
    }
    return { days };
  }
  if (options.last !== undefined) {
    const text = options.last.trim().toLowerCase();
    const parts = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
    if (
      parts === null ||
      (parts[1] === undefined &&
        parts[2] === undefined &&
        parts[3] === undefined &&
        parts[4] === undefined)
    ) {
      usageError(`--last takes a duration such as 24h or 7d, not ${JSON.stringify(options.last)}.`);
    }
    const ms =
      (Number(parts[1] ?? 0) * 24 +
        Number(parts[2] ?? 0) * 60 +
        Number(parts[3] ?? 0) +
        Number(parts[4] ?? 0) / 60) *
      60_000;
    if (ms <= 0) {
      usageError(`--last takes a duration greater than zero, not ${JSON.stringify(options.last)}.`);
    }
    // Whole days stay local days (the presets' calendar boundary); a window
    // shorter than a day ends now and needs the host's since/until filter.
    return ms % DAY_MS === 0 ? { days: ms / DAY_MS } : { ms };
  }
  return undefined;
}

/** The query one report run asks for, resolved once so pages agree. */
export function reportSelection(
  periodName: string | undefined,
  options: ReportOptions,
  now = Date.now(),
  offsetMinutes = -new Date().getTimezoneOffset(),
): UsageReportSelection {
  const asked = windowAsked(options);
  if (asked !== undefined) {
    if (periodName !== undefined) {
      usageError("Take --days/--last or a period (today, 7d, 30d, all), not both.");
    }
    if ("days" in asked) {
      return {
        period: "custom",
        from: localDay(now - (asked.days - 1) * DAY_MS, offsetMinutes),
        to: localDay(now, offsetMinutes),
        days: asked.days,
      };
    }
    return { period: "custom", since: now - asked.ms, until: now, lastMs: asked.ms };
  }
  return { period: periodOf(periodName) };
}

export async function runUsageReportCommand(
  periodName: string | undefined,
  options: ReportOptions,
  connect: ConnectReport = connectToDaemon,
  now = Date.now(),
): Promise<{ report: GatewayUsageReportWire; rows?: never } | { report?: never; rows: unknown[] }> {
  if (options.account !== undefined && options.csv !== true) {
    usageError("--account goes with --csv, as myna's does.");
  }
  const selection = reportSelection(periodName, options, now);
  const query = {
    period: selection.period,
    ...(selection.from === undefined ? {} : { from: selection.from }),
    ...(selection.to === undefined ? {} : { to: selection.to }),
    ...(selection.since === undefined ? {} : { since: selection.since }),
    ...(selection.until === undefined ? {} : { until: selection.until }),
    ...(options.account === undefined ? {} : { account: options.account }),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
  };
  const client = await connect({ target: options.daemonTarget });
  try {
    const features = client.getLastServerInfoMessage()?.features;
    if (features?.gatewayUsageReport !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to read gateway usage." };
    }
    if (selection.since !== undefined && features.gatewayUsageWindow !== true) {
      throw {
        code: "UNSUPPORTED_HOST",
        message: "Update the host to read a window shorter than a day.",
      };
    }
    if (options.csv === true) {
      return { rows: await readAllRows(client, query) };
    }
    const report = await readReport(client, { ...query, limit: 1 });
    return { report };
  } finally {
    await client.close().catch(() => {});
  }
}

async function readReport(
  client: ReportClient,
  query: Parameters<DaemonClient["getGatewayUsage"]>[0],
): Promise<GatewayUsageReportWire> {
  const payload = await client.getGatewayUsage(query);
  if (payload.report === null) {
    throw {
      code: "USAGE_UNAVAILABLE",
      message: payload.error ?? "The host could not read its usage ledger.",
    };
  }
  return payload.report;
}

async function readAllRows(
  client: ReportClient,
  query: Parameters<DaemonClient["getGatewayUsage"]>[0],
): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; ; ) {
    const report = await readReport(client, { ...query, offset, limit: PAGE });
    rows.push(...report.requests.rows);
    offset += report.requests.rows.length;
    if (report.requests.rows.length === 0 || offset >= report.requests.total) {
      return rows;
    }
  }
}

function tokensOf(totals: GatewayUsageTotalsWire): number {
  return totals.inputTokens + totals.outputTokens;
}

/** myna's fmtTokens. */
function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1e9).toFixed(2)}B`;
  }
  if (tokens >= 10_000_000) {
    return `${Math.round(tokens / 1e6)}M`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1e6).toFixed(1)}M`;
  }
  if (tokens >= 100_000) {
    return `${Math.round(tokens / 1e3)}K`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1e3).toFixed(1)}K`;
  }
  return String(tokens);
}

/** myna's FormatCost. */
function fmtCost(usd: number): string {
  if (usd >= 100) {
    return `$${Math.round(usd)}`;
  }
  if (usd >= 1) {
    return `$${usd.toFixed(2)}`;
  }
  return `$${usd.toFixed(3)}`;
}

function plural(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

/** myna's humanWindow: whole days as days, whole hours as hours, else minutes. */
function humanWindow(ms: number): string {
  if (ms % DAY_MS === 0) {
    return plural(ms / DAY_MS, "day");
  }
  const hourMs = 3_600_000;
  if (ms % hourMs === 0) {
    return plural(ms / hourMs, "hour");
  }
  return plural(Math.ceil(ms / 60_000), "minute");
}

interface ReportWindow {
  days?: number;
  lastMs?: number;
}

function titleOf(report: GatewayUsageReportWire, window: ReportWindow | undefined): string {
  if (window?.lastMs !== undefined) {
    return `last ${humanWindow(window.lastMs)}`;
  }
  if (window?.days !== undefined) {
    return window.days <= 1 ? "today" : `last ${plural(window.days, "day")}`;
  }
  switch (report.period) {
    case "today":
      return "today";
    case "7d":
      return "last 7 days";
    case "all":
      return "all time";
    default:
      return "last 30 days";
  }
}

function costText(totals: GatewayUsageTotalsWire): string {
  if (totals.costUsd === 0 && totals.unpricedCalls > 0) {
    return "no price";
  }
  return `≈${fmtCost(totals.costUsd)}${totals.unpricedCalls > 0 ? "+" : ""}`;
}

function groupLine(group: GatewayUsageGroupWire, totalTokens: number, name: string): string {
  const share =
    totalTokens > 0
      ? `${Math.round((100 * (group.inputTokens + group.outputTokens)) / totalTokens)}%`
      : "";
  const calls = plural(group.calls, "call");
  const ttft = group.meanTtftMs === null ? "" : `  ttft ${Math.round(group.meanTtftMs)}ms`;
  return `  ${name}  ${share.padStart(4)}  ${fmtTokens(group.inputTokens + group.outputTokens).padStart(7)}  ${calls.padEnd(10)}  ${costText(group)}${ttft}`;
}

function table<T extends GatewayUsageGroupWire>(
  head: string,
  groups: T[],
  name: (group: T) => string,
  totalTokens: number,
): string[] {
  const width = groups.reduce((widest, group) => Math.max(widest, name(group).length), 0);
  return [
    "",
    `  ${head}`,
    ...groups.map((group) => groupLine(group, totalTokens, name(group).padEnd(width))),
  ];
}

/** myna's printUsage, for what Neolix's report carries. */
export function formatUsageReport(
  report: GatewayUsageReportWire,
  window: ReportWindow | undefined,
): string {
  const title = titleOf(report, window);
  const totals = report.totals;
  if (totals.calls === 0) {
    return `no calls ${title} · route an agent through Neox's gateway and its usage shows up here\n  ${report.path}`;
  }
  const totalTokens = tokensOf(totals);
  const lines = [
    `${fmtTokens(totalTokens)} tokens ${title} · ${plural(totals.calls, "call")} · ${costText(totals)}`,
    `  in ${fmtTokens(totals.inputTokens)}  out ${fmtTokens(totals.outputTokens)}  cache read ${fmtTokens(totals.cacheReadTokens)}  cache write ${fmtTokens(totals.cacheWriteTokens)}  reasoning ${fmtTokens(totals.reasoningTokens)}${totals.failed > 0 ? ` · ${plural(totals.failed, "error")}` : ""}${totals.retried > 0 ? ` · ${totals.retried} answered on a retry` : ""}`,
  ];
  lines.push(...table("agents", report.byClient, (group) => group.name, totalTokens));
  lines.push(
    ...table(
      "models",
      report.byModel,
      (group) => (group.sub === undefined ? group.name : `${group.sub}/${group.name}`),
      totalTokens,
    ),
  );
  if (report.byAccount.length > 0) {
    lines.push(
      ...table(
        "accounts",
        report.byAccount,
        (group) => (group.sub === undefined ? group.name : `${group.sub} / ${group.name}`),
        totalTokens,
      ),
    );
  }
  if (report.byKey.length > 0) {
    lines.push(...table("gateway keys", report.byKey, (group) => group.name, totalTokens));
  }
  if (report.bySession.length > 0) {
    const top = report.bySession.slice(0, 10);
    const head =
      report.bySession.length > top.length
        ? `sessions · top ${top.length} of ${report.bySession.length}`
        : "sessions";
    lines.push(...table(head, top, (group) => group.name, totalTokens));
  }
  lines.push(`  ${report.path}`);
  return lines.join("\n");
}

/** myna's CSV, the same projection the App exports (protocol's gateway-usage-csv). */
export { formatUsageCsvRows as formatUsageCsv };

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

export function createUsageReportCommand(): Command {
  const report = addJsonOption(
    addDaemonHostOption(
      new Command("report")
        .description("Tokens and cost of the gateway's calls, or every call as CSV")
        .argument("[period]", "today, 7d, 30d or all (30d unless given)")
        .option("--csv", "Every call of the period as CSV, one row each")
        .option("--account <name>", "With --csv, only the calls that account answered")
        .option("--days <n>", "The last whole local days, ending today")
        .option("--last <duration>", "A window ending now, such as 90m, 24h or 7d"),
    ),
  );
  report.action(
    withGlobalOptions(async (period: string | undefined, options: ReportOptions) => {
      try {
        const result = await runUsageReportCommand(period, options);
        if (result.rows !== undefined) {
          process.stdout.write(`${formatUsageCsvRows(result.rows)}\n`);
          return;
        }
        const selection = reportSelection(period, options);
        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
        } else {
          process.stdout.write(`${formatUsageReport(result.report, selection)}\n`);
        }
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    }),
  );
  return report;
}
