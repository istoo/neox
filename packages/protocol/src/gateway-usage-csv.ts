/**
 * myna's usage CSV, shared by the CLI's `usage report --csv` and the App's
 * export: one column list and one projection, as myna's GUI and CLI both go
 * through `usage.WriteCSV` (internal/gui/usage.go:210).
 */

/** myna's ledger columns (internal/usage/ledger.go:620), in its order. */
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

/** A row either surface can supply; every myna-only column stays empty when absent. */
export interface UsageCsvRow {
  time: string;
  client: string;
  requested: string;
  provider: string;
  model: string;
  account?: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  reasoningTokens: number;
  costUsd: number;
  priced?: boolean;
  durationMs: number;
  ttftMs?: number;
  status: number;
  ok: boolean;
  attempts: number;
  handedOn: boolean;
  session?: string;
  requestId?: string;
  responseId?: string;
  upstreamProtocol?: string;
  key?: string | null;
  keyLabel?: string;
  /** The ledger columns the gateway records when it knows them. */
  host?: string;
  effort?: string;
  kind?: string;
  providerKeyId?: string;
  providerKeyName?: string;
  routeId?: number;
  endpoint?: string;
  errorMessage?: string;
  errorType?: string;
  tierAsked?: string;
  tierSent?: string;
  tierServed?: string;
  upstreamStop?: string;
  credits?: number;
  sessionProvider?: string;
  sessionAccount?: string;
}

/**
 * A call's time as myna's CSV writes it: RFC 3339 on this computer's clock,
 * its offset after it. The ledger keeps UTC, which does not say which day the
 * call was for its reader.
 */
export function usageCsvTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) {
    return iso;
  }
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
    `${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
  ].join("");
}

/** A cell Neolix has no value for stays empty, as myna writes a missing one. */
function csvText(value: string | null | undefined): string {
  return value ?? "";
}

function csvNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function csvCost(row: UsageCsvRow): string {
  return row.priced === false ? "" : row.costUsd.toFixed(6);
}

function csvTries(row: UsageCsvRow): string {
  return row.attempts > 0 ? String(row.attempts) : "";
}

/** One CSV cell, quoted when it holds a comma, quote or newline. */
export function usageCsvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** myna's rows, a header first; the caller adds its own line ending. */
export function formatUsageCsvRows(rows: readonly unknown[]): string {
  const lines = [USAGE_CSV_COLUMNS.join(",")];
  for (const raw of rows) {
    const row = raw as UsageCsvRow;
    const cacheWrite = Math.max(0, row.cacheWriteTokens ?? 0);
    const cacheWrite1h = Math.min(Math.max(0, row.cacheWrite1hTokens ?? 0), cacheWrite);
    const cells = [
      usageCsvTime(row.time),
      row.client,
      row.requested,
      row.provider,
      csvText(row.host),
      row.model,
      // Neolix keeps the model the call was sent with; it doesn't record a
      // reply naming another one, so served_model stays empty.
      "",
      String(row.requested !== row.model),
      csvText(row.effort),
      String(row.inputTokens),
      String(row.outputTokens),
      String(row.cacheWriteTokens),
      String(row.cacheReadTokens),
      String(row.reasoningTokens),
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
      // Gateway rows are myna's source ""; none is a rejected call, and
      // none comes from an agent session file.
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
      String(row.handedOn),
      csvText(row.tierAsked),
      csvText(row.tierSent),
      csvText(row.tierServed),
      csvText(row.upstreamStop),
      csvNumber(row.credits),
    ];
    lines.push(cells.map(usageCsvCell).join(","));
  }
  return lines.join("\n");
}
