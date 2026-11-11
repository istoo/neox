// FILE: gatewayUsageCsv.ts
// Purpose: The ledger's CSV export — the same 47 columns the Neox CLI writes,
//          projected from `GatewayUsageRequest` rows the settings page fetched.
// Layer: Settings UI support
//
// The column list and projection mirror `packages/protocol/src/gateway-usage-csv.ts`
// (the CLI's `usage report --csv`); the web app cannot import the protocol package,
// so the two are kept in step by hand. `debt:` import the protocol helper once the
// desktop-web workspace depends on it.

import type { GatewayUsageRequest } from "~/lib/gatewayTypes";

/** myna's ledger columns, in its order. */
export const USAGE_CSV_COLUMNS = [
  "time",
  "agent",
  "requested_model",
  "provider",
  "host",
  "model",
  "served_model",
  "swapped",
  "effort",
  "input_tokens",
  "output_tokens",
  "cache_write_tokens",
  "cache_read_tokens",
  "reasoning_tokens",
  "cost_usd",
  "duration_ms",
  "ttft_ms",
  "status",
  "error",
  "session",
  "kind",
  "provider_key_id",
  "provider_key_name",
  "provider_account",
  "route_id",
  "request_id",
  "endpoint",
  "error_message",
  "error_type",
  "source",
  "rejected",
  "session_provider",
  "session_account",
  "session_official_login",
  "caller_key_id",
  "caller_key_name",
  "response_id",
  "upstream",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "tries",
  "handed_on",
  "tier_asked",
  "tier_sent",
  "tier_served",
  "upstream_stop",
  "credits",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A call's time as myna's CSV writes it: RFC 3339 on this computer's clock. */
function usageCsvTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  return [
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
    `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
  ].join("");
}

function csvText(value: string | null | undefined): string {
  return value ?? "";
}

function csvNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function csvCost(row: GatewayUsageRequest): string {
  return row.priced === false ? "" : row.costUsd.toFixed(6);
}

function csvTries(row: GatewayUsageRequest): string {
  return row.attempts > 0 ? String(row.attempts) : "";
}

/** One CSV cell, quoted when it holds a comma, quote or newline. */
export function usageCsvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** myna's rows, a header first; the caller adds its own line ending. */
export function formatUsageCsvRows(rows: readonly GatewayUsageRequest[]): string {
  const lines = [USAGE_CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const cacheWrite = Math.max(0, row.cacheWriteTokens ?? 0);
    const cacheWrite1h = Math.min(Math.max(0, row.cacheWrite1hTokens ?? 0), cacheWrite);
    const cells = [
      usageCsvTime(row.time),
      row.client,
      row.requested,
      row.provider,
      csvText(typeof row.host === "string" ? row.host : undefined),
      row.model,
      "",
      String(row.requested !== row.model),
      csvText(row.effort),
      String(row.inputTokens),
      String(row.outputTokens),
      String(cacheWrite),
      String(row.cacheReadTokens ?? 0),
      String(row.reasoningTokens ?? 0),
      csvCost(row),
      String(Math.round(row.durationMs)),
      row.ttftMs === undefined ? "" : String(Math.round(row.ttftMs)),
      String(row.status),
      String(!row.ok),
      csvText(row.session),
      csvText(row.kind),
      csvText(row.providerKeyId),
      csvText(row.providerKeyName),
      csvText(row.account),
      csvNumber(row.routeId),
      csvText(row.requestId),
      csvText(row.endpoint),
      csvText(row.errorMessage),
      csvText(row.errorType),
      "",
      "false",
      csvText(row.sessionProvider),
      csvText(row.sessionAccount),
      "false",
      csvText(row.key),
      csvText(row.keyLabel),
      csvText(row.responseId),
      csvText(row.upstreamProtocol),
      String(cacheWrite - cacheWrite1h),
      String(cacheWrite1h),
      csvTries(row),
      String(row.handedOn === true),
      csvText(row.tierAsked),
      csvText(row.tierSent),
      csvText(row.tierServed),
      csvText(row.upstreamStop),
      csvNumber(row.credits),
    ];
    lines.push(cells.map(usageCsvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function downloadUsageCsv(rows: readonly GatewayUsageRequest[], fileName: string): void {
  const blob = new Blob([formatUsageCsvRows(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
