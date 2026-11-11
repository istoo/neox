import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

const FILENAME = "gateway-search.jsonl";
const MAX_REMEMBERED = 1000;

export interface SearchRecord {
  time: string;
  key: string | null;
  status: number;
  /** What the call cost in the provider's own credit unit; one call by default. */
  credits: number;
}

function monthOf(time: number): string {
  return new Date(time).toISOString().slice(0, 7);
}

/**
 * Search calls are billed per request by the search vendor, so the ledger
 * counts them the same way the model ledger counts tokens: append-only, and
 * replayed at start so a restart does not reset a month's allowance.
 */
export class SearchLedger {
  public readonly filePath: string;

  private readonly logger: Logger;
  private readonly records: SearchRecord[] = [];

  constructor(options: { neolixHome: string; logger: Logger }) {
    this.filePath = path.join(options.neolixHome, FILENAME);
    this.logger = options.logger;
  }

  public async start(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        const record = readRecord(parsed);
        if (record !== null) {
          this.records.push(record);
        }
      } catch {
        // A torn last line is the normal crash shape; the rest still counts.
      }
    }
    this.trim();
  }

  public record(record: SearchRecord): void {
    this.records.push(record);
    this.trim();
    void appendFile(this.filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 }).catch(
      (error: unknown) => {
        this.logger.error(
          { err: error, file: this.filePath },
          "Cannot append to the search ledger",
        );
      },
    );
  }

  /** Successful calls; a refused one is not charged. */
  public countThisMonth(key: string | null, now: number): number {
    const month = monthOf(now);
    let total = 0;
    for (const record of this.records) {
      if (record.status < 200 || record.status >= 300) {
        continue;
      }
      if (key !== null && record.key !== key) {
        continue;
      }
      if (monthOf(Date.parse(record.time)) === month) {
        total += record.credits;
      }
    }
    return total;
  }

  public recent(key: string | null): SearchRecord[] {
    return this.records
      .filter((record) => key === null || record.key === key)
      .slice(-20)
      .toReversed();
  }

  private trim(): void {
    if (this.records.length > MAX_REMEMBERED) {
      this.records.splice(0, this.records.length - MAX_REMEMBERED);
    }
  }
}

function readRecord(value: unknown): SearchRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.time !== "string" ||
    typeof record.status !== "number" ||
    typeof record.credits !== "number"
  ) {
    return null;
  }
  return {
    time: record.time,
    key: typeof record.key === "string" ? record.key : null,
    status: record.status,
    credits: record.credits,
  };
}
