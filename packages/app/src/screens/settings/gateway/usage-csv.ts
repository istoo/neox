import type { GatewayUsagePeriodWire, GatewayUsageRequestWire } from "@neolix/protocol/gateway";
import {
  formatUsageCsvRows,
  USAGE_CSV_COLUMNS,
  usageCsvTime,
} from "@neolix/protocol/gateway-usage-csv";

// One column list and one projection with the CLI: myna's GUI and CLI both
// go through usage.WriteCSV.
export const CSV_COLUMNS = USAGE_CSV_COLUMNS;
export { usageCsvTime };

/** myna's rows, with the file's trailing newline. */
export function usageCsv(rows: readonly GatewayUsageRequestWire[]): string {
  return `${formatUsageCsvRows(rows)}\n`;
}

export function usageExportName(period: GatewayUsagePeriodWire, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `neolix-usage-${period}-${day}.csv`;
}
