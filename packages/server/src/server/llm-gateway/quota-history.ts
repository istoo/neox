import { createReadStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "pino";

export const GATEWAY_QUOTA_HISTORY_FILENAME = "gateway-quota-readings.jsonl";

/** What the allowance poller read from an account's own usage endpoint. */
export interface QuotaHistoryEntry {
  at: number;
  provider: string;
  account: string;
  remaining: number | null;
  limit: number | null;
  resetAt: number | null;
  usedPercent: number | null;
  /**
   * The computer the reading came from when the usage sync brought it here
   * (#542): another's id, or "this" for one read here. Absent on a local
   * reading when no other computer's usage is shared.
   */
  device?: string;
}

/** One provider or one account, the account compared without case. */
export interface QuotaHistoryFilter {
  provider?: string;
  account?: string;
}

/**
 * The other computers' readings, as the usage sync merged them. Read at the
 * history's read, never written to `gateway-quota-readings.jsonl`: the file
 * is the gateway's own append log.
 */
export type SharedQuotaHistoryReader = (
  since: number,
  filter: QuotaHistoryFilter,
) => Promise<readonly QuotaHistoryEntry[]>;

/** How long readings are kept, and how many: myna's quotaHistKept, 45 days. */
const KEEP_MS = 45 * 24 * 60 * 60_000;
const KEEP_ENTRIES = 100_000;

/**
 * The readings the allowance poller takes, kept across restarts so an
 * account's allowance can be drawn over time — myna reads its own readings
 * from its history the same way. One JSON line per reading; readings older
 * than 45 days are dropped.
 */
export class QuotaHistoryStore {
  public readonly filePath: string;

  private readonly entries: QuotaHistoryEntry[] = [];
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly logger: Logger;
  private readonly sharedHistory: SharedQuotaHistoryReader | undefined;
  private loggedWriteError = false;

  constructor(options: {
    neolixHome: string;
    logger: Logger;
    /** The other computers' readings; absent reads this computer's alone. */
    sharedHistory?: SharedQuotaHistoryReader;
  }) {
    this.filePath = path.join(options.neolixHome, GATEWAY_QUOTA_HISTORY_FILENAME);
    this.logger = options.logger;
    this.sharedHistory = options.sharedHistory;
  }

  /** Reads what was kept. A missing file is an empty history. */
  public async start(): Promise<void> {
    let stream;
    try {
      stream = createReadStream(this.filePath, { encoding: "utf8" });
    } catch {
      return;
    }
    const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    let failure: unknown = null;
    stream.on("error", (error: unknown) => {
      failure = error;
    });
    try {
      for await (const line of lines) {
        const entry = parseEntry(line);
        if (entry !== null) {
          this.entries.push(entry);
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      lines.close();
      stream.destroy();
    }
    if (failure !== null && !isMissingFile(failure)) {
      this.logger.warn({ err: failure }, "Cannot read the gateway allowance history");
    }
    this.prune(Date.now());
  }

  public record(
    provider: string,
    account: string,
    reading: {
      remaining: number | null;
      limit: number | null;
      resetAt: number | null;
      usedPercent: number | null;
      readAt: number;
    },
  ): void {
    const entry: QuotaHistoryEntry = {
      at: reading.readAt,
      provider,
      account,
      remaining: reading.remaining,
      limit: reading.limit,
      resetAt: reading.resetAt,
      usedPercent: reading.usedPercent,
    };
    this.entries.push(entry);
    this.prune(entry.at);
    const write = appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8").catch(
      (error: unknown) => {
        if (!this.loggedWriteError) {
          this.loggedWriteError = true;
          this.logger.error(
            { err: error, file: this.filePath },
            "Cannot append an allowance reading",
          );
        }
      },
    );
    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));
  }

  /** Resolves once every line recorded so far has reached the file. */
  public async flush(): Promise<void> {
    await Promise.all(this.pendingWrites);
  }

  /**
   * Every reading at or after `since`, per account — myna's QuotaHistories
   * sends them all, with no downsampling. `provider` and `account` narrow
   * the result, the account compared without case, as myna's user filter is.
   */
  public history(
    since: number,
    filter: { provider?: string; account?: string } = {},
  ): Map<string, QuotaHistoryEntry[]> {
    const wantedAccount = filter.account?.toLowerCase();
    const byAccount = new Map<string, QuotaHistoryEntry[]>();
    for (const entry of this.entries) {
      if (entry.at < since) {
        continue;
      }
      if (filter.provider !== undefined && entry.provider !== filter.provider) {
        continue;
      }
      if (wantedAccount !== undefined && entry.account.toLowerCase() !== wantedAccount) {
        continue;
      }
      const key = `${entry.provider}/${entry.account}`;
      const list = byAccount.get(key);
      if (list === undefined) {
        byAccount.set(key, [entry]);
      } else {
        list.push(entry);
      }
    }
    for (const list of byAccount.values()) {
      list.sort((left, right) => left.at - right.at);
    }
    return byAccount;
  }

  /**
   * This computer's readings and the other computers' brought by the usage
   * sync, merged by provider and account (myna `MergeQuotaHistory`). The
   * others are read at read time, so the local file stays this computer's
   * append log and never races the poller's writes. With no other computer's
   * readings the answer is exactly `history`.
   */
  public async historyWithShared(
    since: number,
    filter: QuotaHistoryFilter = {},
  ): Promise<Map<string, QuotaHistoryEntry[]>> {
    const local = this.history(since, filter);
    if (this.sharedHistory === undefined) {
      return local;
    }
    const shared = await this.sharedHistory(since, filter);
    if (shared.length === 0) {
      return local;
    }
    return mergeSharedQuotaHistory(local, shared);
  }

  private prune(now: number): void {
    const cutoff = now - KEEP_MS;
    let firstFresh = 0;
    while (firstFresh < this.entries.length && this.entries[firstFresh]!.at < cutoff) {
      firstFresh += 1;
    }
    if (firstFresh > 0) {
      this.entries.splice(0, firstFresh);
    }
    if (this.entries.length > KEEP_ENTRIES) {
      this.entries.splice(0, this.entries.length - KEEP_ENTRIES);
    }
  }
}

/**
 * The union of both histories, a point kept once by account and when it was
 * read. The local reading wins a point both computers made; every point says
 * which computer it is from.
 */
function mergeSharedQuotaHistory(
  local: ReadonlyMap<string, readonly QuotaHistoryEntry[]>,
  shared: readonly QuotaHistoryEntry[],
): Map<string, QuotaHistoryEntry[]> {
  const out = new Map<string, QuotaHistoryEntry[]>();
  const seen = new Set<string>();
  const add = (key: string, entry: QuotaHistoryEntry) => {
    const point = `${entry.provider}\0${entry.account}\0${entry.at}`;
    if (seen.has(point)) {
      return;
    }
    seen.add(point);
    const list = out.get(key) ?? [];
    list.push(entry);
    out.set(key, list);
  };
  for (const [key, entries] of local) {
    for (const entry of entries) {
      add(key, { ...entry, device: entry.device ?? "this" });
    }
  }
  for (const entry of shared) {
    if (entry.provider.length === 0 || entry.account.length === 0) {
      continue;
    }
    add(`${entry.provider}/${entry.account}`, { ...entry, device: entry.device ?? "remote" });
  }
  for (const entries of out.values()) {
    entries.sort((left, right) => left.at - right.at);
  }
  return out;
}

function parseEntry(line: string): QuotaHistoryEntry | null {
  if (line.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const entry = parsed as Record<string, unknown>;
  if (
    typeof entry.at !== "number" ||
    typeof entry.provider !== "string" ||
    typeof entry.account !== "string"
  ) {
    return null;
  }
  const number = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    at: entry.at,
    provider: entry.provider,
    account: entry.account,
    remaining: number(entry.remaining),
    limit: number(entry.limit),
    resetAt: number(entry.resetAt),
    usedPercent: number(entry.usedPercent),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
