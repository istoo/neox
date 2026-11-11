import { appendFile, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { MaskHit } from "./masking.js";

/** What masking swapped in one request, kept for the settings page. */
const KEEP_DAYS = 30;
const MAX_RECORDS = 5000;
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DAY_MS = 86_400_000;

export interface MaskingValue {
  /** The placeholder the value went as. */
  p: string;
  /** Its kind. */
  k: string;
  /** The finder: a built-in rule or one the user wrote. */
  b: string;
  /** As much of the value as may be kept: a key's prefix, or its first character. */
  h?: string;
  /** Its length in characters. */
  l: number;
  /** The places this request had it. */
  n: number;
  /** warn: sent as written; block: the request was held back. */
  a?: "mask" | "warn" | "block";
}

export interface MaskingRecord {
  key: string;
  t: string;
  /** The client call this masking belonged to, when the caller named one. */
  gatewayCallId?: string;
  /** The client as its User-Agent names it. */
  agent?: string;
  provider?: string;
  model?: string;
  /** Values swapped, each place counted. Warn-only values are not swapped. */
  n: number;
  /** How long masking took, in milliseconds. */
  took?: number;
  blocked?: boolean;
  values: MaskingValue[];
  /** By stand-in, how often the reply had it put back. */
  back?: Record<string, number>;
}

export interface MaskingRecordInput {
  /** The client call this masking belonged to. */
  gatewayCallId?: string;
  agent?: string;
  provider?: string;
  model?: string;
  hits: readonly MaskHit[];
  tookMs?: number;
  blocked: boolean;
  back?: Record<string, number>;
  at?: number;
}

export interface MaskingRecordFilter {
  /** Only the records masking wrote for this client call. */
  gatewayCallId?: string;
  before?: string;
  limit?: number;
  kinds?: readonly string[];
  by?: "rule" | "yours";
  agent?: string;
  provider?: string;
  blocked?: boolean;
}

export interface MaskingDayBucket {
  day: string;
  n: number;
  requests: number;
}

export interface MaskingSummary {
  n: number;
  distinct: number;
  requests: number;
  blocked: number;
  /** Places put back in replies. */
  restored: number;
  days: MaskingDayBucket[];
  kinds: Array<{ name: string; n: number }>;
  agents: Array<{ name: string; n: number }>;
  providers: Array<{ name: string; n: number }>;
  values: Array<{
    p: string;
    k: string;
    b: string;
    h?: string;
    l: number;
    n: number;
    requests: number;
    last: string;
  }>;
  by: { rule: number; yours: number; model: number };
}

function dayOf(time: Date): string {
  const year = time.getFullYear();
  const month = String(time.getMonth() + 1).padStart(2, "0");
  const day = String(time.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseLine(line: string): MaskingRecord | null {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    const entry: unknown = JSON.parse(line);
    return isRecordEntry(entry) ? entry : null;
  } catch {
    // A torn last line is from a crash; the rest of the day is good.
    return null;
  }
}

function isRecordEntry(value: unknown): value is MaskingRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Partial<MaskingRecord>;
  return (
    typeof entry.key === "string" &&
    typeof entry.t === "string" &&
    typeof entry.n === "number" &&
    Array.isArray(entry.values)
  );
}

/**
 * Keeps what masking did, never the values themselves: each record holds a
 * placeholder's kind, finder, length and first characters. Days live under
 * `$NEOLIX_HOME/gateway-masking`, one request a line, kept 30 days.
 */
export class MaskingRecordStore {
  private readonly dir: string;
  private readonly logger: Logger;
  private records: MaskingRecord[] = [];
  private lastKey = 0;
  private readonly listeners = new Set<(record: MaskingRecord) => void>();
  /** By placeholder, the key of the first record that had it. */
  private readonly firstKeys = new Map<string, number>();

  constructor(options: { neolixHome: string; logger: Logger }) {
    this.dir = path.join(options.neolixHome, "gateway-masking");
    this.logger = options.logger;
  }

  /** Told of each record as it is made; the masking alert's way in. */
  public subscribe(listener: (record: MaskingRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async start(): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const names = (await readdir(this.dir)).filter((name) => DAY_FILE.test(name)).sort();
      const oldest = dayOf(new Date(Date.now() - (KEEP_DAYS - 1) * DAY_MS));
      for (const name of names) {
        const day = name.slice(0, 10);
        if (day < oldest) {
          await unlink(path.join(this.dir, name)).catch(() => undefined);
          continue;
        }
        const body = await readFile(path.join(this.dir, name), "utf8").catch(() => "");
        for (const line of body.split("\n")) {
          const entry = parseLine(line);
          if (entry !== null) {
            this.records.push(entry);
          }
        }
      }
      this.records.sort((left, right) => Number(left.key) - Number(right.key));
      if (this.records.length > MAX_RECORDS) {
        this.records = this.records.slice(this.records.length - MAX_RECORDS);
      }
      this.firstKeys.clear();
      for (const record of this.records) {
        this.rememberFirst(record);
      }
      const last = this.records.at(-1);
      this.lastKey = last === undefined ? 0 : Number(last.key);
    } catch (error) {
      this.logger.error({ err: error, dir: this.dir }, "Cannot read LLM gateway masking records");
    }
  }

  /** Records one request; returns null when masking found nothing worth keeping. */
  public add(input: MaskingRecordInput): MaskingRecord | null {
    if (input.hits.length === 0) {
      return null;
    }
    const byValue = new Map<string, MaskingValue>();
    let n = 0;
    for (const hit of input.hits) {
      if (hit.action !== "warn") {
        n += 1;
      }
      const existing = byValue.get(hit.placeholder);
      if (existing !== undefined) {
        existing.n += 1;
        continue;
      }
      byValue.set(hit.placeholder, {
        p: hit.placeholder,
        k: hit.kind,
        b: hit.by,
        ...(hit.head.length === 0 ? {} : { h: hit.head }),
        l: hit.length,
        n: 1,
        ...(hit.action === undefined ? {} : { a: hit.action }),
      });
    }
    const at = input.at ?? Date.now();
    const key = String(Math.max(at, this.lastKey + 1));
    this.lastKey = Number(key);
    const record: MaskingRecord = {
      key,
      t: new Date(at).toISOString(),
      ...(input.gatewayCallId === undefined ? {} : { gatewayCallId: input.gatewayCallId }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.model === undefined ? {} : { model: input.model }),
      n,
      ...(input.tookMs === undefined ? {} : { took: input.tookMs }),
      ...(input.blocked ? { blocked: true } : {}),
      ...(input.back === undefined ? {} : { back: input.back }),
      values: [...byValue.values()].sort((left, right) => right.n - left.n),
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RECORDS);
    }
    this.rememberFirst(record);
    this.write(record);
    for (const listener of this.listeners) {
      listener(record);
    }
    return record;
  }

  private rememberFirst(record: MaskingRecord): void {
    const key = Number(record.key);
    for (const value of record.values) {
      if (!this.firstKeys.has(value.p)) {
        this.firstKeys.set(value.p, key);
      }
    }
  }

  /** The values this record masked for the first time; warn-only ones are no news. */
  public freshValues(record: MaskingRecord): MaskingValue[] {
    const key = Number(record.key);
    return record.values.filter(
      (value) => value.a !== "warn" && this.firstKeys.get(value.p) === key,
    );
  }

  private write(record: MaskingRecord): void {
    const file = path.join(this.dir, `${dayOf(new Date(record.t))}.jsonl`);
    void appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 }).catch(
      (error: unknown) => {
        this.logger.warn({ err: error, file }, "Cannot write an LLM gateway masking record");
      },
    );
  }

  public get(key: string): MaskingRecord | null {
    return this.records.find((record) => record.key === key) ?? null;
  }

  public list(filter: MaskingRecordFilter): { records: MaskingRecord[]; more: boolean } {
    const limit = Math.min(Math.max(filter.limit ?? 40, 1), 200);
    const before = filter.before === undefined ? null : Number(filter.before);
    const kinds = filter.kinds ?? [];
    const matching = this.records
      .filter((record) => {
        if (before !== null && Number(record.key) >= before) {
          return false;
        }
        if (filter.blocked === true && record.blocked !== true) {
          return false;
        }
        if (filter.blocked === false && record.blocked === true) {
          return false;
        }
        if (filter.gatewayCallId !== undefined && record.gatewayCallId !== filter.gatewayCallId) {
          return false;
        }
        if (filter.agent !== undefined && record.agent !== filter.agent) {
          return false;
        }
        if (filter.provider !== undefined && record.provider !== filter.provider) {
          return false;
        }
        return record.values.some(
          (value) =>
            (kinds.length === 0 || kinds.includes(value.k)) &&
            (filter.by === undefined || value.b === filter.by),
        );
      })
      .toReversed();
    return { records: matching.slice(0, limit), more: matching.length > limit };
  }

  public summary(days: number, now = Date.now()): MaskingSummary {
    const span = Math.min(Math.max(days, 1), KEEP_DAYS);
    const first = new Date(startOfDay(now));
    first.setDate(first.getDate() - (span - 1));
    const start = first.getTime();
    const selected = this.records.filter((record) => new Date(record.t).getTime() >= start);
    const buckets = new Map<string, MaskingDayBucket>();
    for (let index = 0; index < span; index += 1) {
      const day = new Date(startOfDay(now));
      day.setDate(day.getDate() - (span - 1) + index);
      const key = dayOf(day);
      buckets.set(key, { day: key, n: 0, requests: 0 });
    }
    const kinds = new Map<string, number>();
    const agents = new Map<string, number>();
    const providers = new Map<string, number>();
    const values = new Map<
      string,
      {
        p: string;
        k: string;
        b: string;
        h?: string;
        l: number;
        n: number;
        requests: number;
        last: string;
      }
    >();
    const distinct = new Set<string>();
    const by = { rule: 0, yours: 0, model: 0 };
    let n = 0;
    let blocked = 0;
    let restored = 0;
    for (const record of selected) {
      for (const count of Object.values(record.back ?? {})) {
        restored += count;
      }
      const time = new Date(record.t);
      const bucket = buckets.get(dayOf(time));
      if (bucket !== undefined) {
        bucket.n += record.n;
        bucket.requests += 1;
      }
      n += record.n;
      if (record.blocked === true) {
        blocked += 1;
      }
      if (record.agent !== undefined) {
        agents.set(record.agent, (agents.get(record.agent) ?? 0) + record.n);
      }
      if (record.provider !== undefined) {
        providers.set(record.provider, (providers.get(record.provider) ?? 0) + record.n);
      }
      for (const value of record.values) {
        distinct.add(`${value.k}\u0000${value.p}`);
        kinds.set(value.k, (kinds.get(value.k) ?? 0) + value.n);
        if (value.b === "yours") {
          by.yours += value.n;
        } else if (value.b === "model") {
          by.model += value.n;
        } else {
          by.rule += value.n;
        }
        const seen = values.get(value.p);
        if (seen === undefined) {
          values.set(value.p, {
            p: value.p,
            k: value.k,
            b: value.b,
            ...(value.h === undefined ? {} : { h: value.h }),
            l: value.l,
            n: value.n,
            requests: 1,
            last: record.t,
          });
        } else {
          seen.n += value.n;
          seen.requests += 1;
          seen.last = record.t > seen.last ? record.t : seen.last;
        }
      }
    }
    const ranked = (map: Map<string, number>) =>
      [...map].map(([name, count]) => ({ name, n: count })).sort((left, right) => right.n - left.n);
    return {
      n,
      distinct: distinct.size,
      requests: selected.length,
      blocked,
      restored,
      days: [...buckets.values()],
      kinds: ranked(kinds),
      agents: ranked(agents),
      providers: ranked(providers),
      values: [...values.values()].sort((left, right) => right.n - left.n),
      by,
    };
  }

  public async clear(): Promise<void> {
    this.records = [];
    this.lastKey = 0;
    await rm(this.dir, { recursive: true, force: true }).catch((error: unknown) => {
      this.logger.warn({ err: error, dir: this.dir }, "Cannot clear masking records");
    });
    await mkdir(this.dir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  }
}
