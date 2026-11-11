import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import type {
  GatewayUsageGroupWire,
  GatewayUsagePeriodWire,
  GatewayUsagePointWire,
  GatewayUsagePromptWire,
  GatewayUsageReportWire,
  GatewayUsageRequestWire,
  GatewayUsageTotalsWire,
} from "@neolix/protocol/gateway";
import type { UsageRecord } from "./usage.js";

/**
 * The Usage page's figures, summed from `gateway-usage.jsonl`.
 *
 * The ledger is append-only and may be months long, so the file is read as a
 * stream and only the records the window keeps are held. Everything else is
 * derived from those records once, so one read serves the totals, the chart,
 * each ranking and the request page.
 */

/** Records kept in memory for one report: past this the oldest are dropped. */
export const MAX_RECORDS = 200_000;
/** The request page's default and its ceiling. */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

const HOUR_MS = 60 * 60 * 1000;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const DAY_MS = 24 * HOUR_MS;

export interface UsageReportQuery {
  period: GatewayUsagePeriodWire;
  now: number;
  /** The reader's offset from UTC in minutes (UTC+8 is 480). */
  timezoneOffsetMinutes: number;
  offset: number;
  limit: number;
  client?: string;
  model?: string;
  provider?: string;
  account?: string;
  key?: string;
  failedOnly?: boolean;
  retriedOnly?: boolean;
  query?: string;
  /** The first and last days of a custom window, `YYYY-MM-DD`, in the reader's zone. */
  from?: string;
  to?: string;
  /** A window by the millisecond, for one shorter than a day (myna's --last). */
  since?: number;
  until?: number;
}

interface UsageAccumulator {
  calls: number;
  failed: number;
  /** Failed tries a later try of the same request took over. */
  handedOn: number;
  retried: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpricedCalls: number;
  timedCalls: number;
  ttftMs: number;
  /** The prompt: input, cache read and cache write, cache counted once. */
  promptTokens: number;
  /** What the prompts were made of, for the calls whose prompt was read. */
  promptCalls: number;
  promptBySlice: Map<string, number>;
}

interface SeriesBucket extends UsageAccumulator {
  label: string;
  start: number;
}

/**
 * Reads the ledger, keeping the records at or after `since` (capped at
 * MAX_RECORDS, oldest dropped).
 *
 * debt: every request re-reads the file from the start. That is fine for the
 * ledger the gateway writes (thousands of lines); on a years-long one, index
 * the file once and keep the index keyed by its size and mtime instead.
 */
export async function readUsageRecords(filePath: string, since: number): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let failure: unknown = null;
  stream.on("error", (error: unknown) => {
    failure = error;
  });
  try {
    for await (const line of lines) {
      const record = parseRecord(line);
      if (record === null) {
        continue;
      }
      const at = Date.parse(record.time);
      if (!Number.isFinite(at) || at < since) {
        continue;
      }
      records.push(record);
      if (records.length > MAX_RECORDS) {
        // Drop a chunk at a time: shifting one per line is quadratic.
        records.splice(0, 1024);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    lines.close();
    stream.destroy();
  }
  // A ledger that is not there yet is an empty one; anything else is a real
  // read failure the caller should hear about.
  if (failure !== null && !isMissingFile(failure)) {
    throw failure;
  }
  return records;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseRecord(line: string): UsageRecord | null {
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
  const record = parsed as Partial<UsageRecord>;
  if (typeof record.time !== "string") {
    return null;
  }
  return record as UsageRecord;
}

/** The records at the effective price, when one is given. */
function costRecords(
  records: readonly UsageRecord[],
  priceOf: PricedRecord | undefined,
): readonly UsageRecord[] {
  if (priceOf === undefined) {
    return records;
  }
  const costed: UsageRecord[] = [];
  for (const record of records) {
    const cost = priceOf(record);
    costed.push(cost === null ? record : { ...record, costUsd: cost.costUsd, priced: cost.priced });
  }
  return costed;
}

/** What a record costs at today's price, and whether it has one. */
type PricedRecord = (record: UsageRecord) => { costUsd: number; priced: boolean } | null;

/** Builds the report from records already read. Pure, so tests need no file. */
export function buildUsageReport(
  records: readonly UsageRecord[],
  query: UsageReportQuery,
  options: {
    filePath: string;
    /** Raw gateway key → the label its config gives it. */
    keyLabels?: ReadonlyMap<string, string>;
    /**
     * Prices a record at the effective price now, as myna re-prices history:
     * the ledger's stored cost is what the price was when the call was made.
     * Null leaves the stored cost, for a record no price is known for.
     */
    priceOf?: PricedRecord;
    /**
     * The id a model's usage is grouped and shown under, myna's
     * UsageAliases: two ids of one model are one row. Prices are still
     * resolved from the id the call was made under, as myna does.
     */
    modelName?: (model: string) => string;
  },
): GatewayUsageReportWire {
  const { since, until } = windowOf(query);
  const windowed = records.filter((record) => {
    const at = Date.parse(record.time);
    return Number.isFinite(at) && at >= since && at <= until;
  });
  const kept = costRecords(
    windowed.filter((record) => record.probe === undefined),
    options.priceOf,
  );
  // The request log shows Neolix's own probes too, but a model list that
  // answered is left out of it (myna's quietProbe): myna asks for lists all
  // day and they would bury the agents' calls. A probe keeps its stored cost
  // (none), while the agents' rows are re-priced with the rest.
  const logged = [
    ...kept,
    ...windowed.filter(
      (record) => record.probe !== undefined && !(record.probe === "list" && record.ok),
    ),
  ];
  const handedOnIds = succeededRequestIds(kept);
  const totals = emptyTotals();
  for (const record of kept) {
    addRecord(totals, record, handedOnIds);
  }

  const bucket = bucketFor(query.period, kept, query.now, since, until);
  const series = buildSeries(kept, since, until, query.timezoneOffsetMinutes, bucket, handedOnIds);
  const byClient = rank(
    kept,
    (record) => clientOf(record),
    (record) => clientOf(record),
    undefined,
    handedOnIds,
  );
  const byProvider = rank(
    kept,
    (record) => record.provider,
    (record) => record.provider,
    undefined,
    handedOnIds,
  );
  const nameOfModel = options.modelName ?? ((model: string) => model);
  const byModel = rank(
    kept,
    (record) => nameOfModel(record.model),
    (record) => nameOfModel(record.model),
    (record) => ({ sub: record.provider }),
    handedOnIds,
  );
  const byAccount = rank(
    kept,
    (record) => record.account ?? "",
    (record) => record.account ?? "",
    undefined,
    handedOnIds,
  );
  const byKey = rank(
    kept,
    (record) => maskKey(record.key ?? ""),
    (record) => keyName(record.key, options.keyLabels),
    undefined,
    handedOnIds,
  );
  const bySession = rank(
    kept.filter((record) => record.session !== undefined && record.session.length > 0),
    (record) => record.session ?? "",
    (record) => record.session ?? "",
    (record) => ({ sub: clientOf(record) }),
    handedOnIds,
  );

  const requests = requestPage(logged, query, options.keyLabels, handedOnIds);
  const prompt = finishPrompt(totals);
  return {
    period: query.period,
    since: new Date(since === Number.NEGATIVE_INFINITY ? 0 : since).toISOString(),
    until: new Date(until === Number.POSITIVE_INFINITY ? query.now : until).toISOString(),
    ...(query.period === "custom" && query.from !== undefined ? { from: query.from } : {}),
    ...(query.period === "custom" && query.to !== undefined ? { to: query.to } : {}),
    bucket,
    totals: finishTotals(totals),
    prompt: prompt ?? { tokens: 0, calls: 0, parts: [] },
    series,
    byClient,
    byModel,
    byProvider,
    byAccount,
    byKey,
    bySession,
    requests,
    path: tildePath(options.filePath),
  };
}

function clientOf(record: UsageRecord): string {
  return record.client ?? "other";
}

function keyName(
  key: string | null | undefined,
  labels: ReadonlyMap<string, string> | undefined,
): string {
  if (key === null || key === undefined) {
    return "";
  }
  return labels?.get(key) ?? maskKey(key);
}

function maskKey(key: string | null | undefined): string {
  if (key === null || key === undefined) {
    return "";
  }
  if (key.length <= 8) {
    return "…";
  }
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function tildePath(filePath: string): string {
  const home = homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

export function periodStart(
  period: GatewayUsagePeriodWire,
  now: number,
  timezoneOffsetMinutes: number,
): number {
  if (period === "all") {
    return Number.NEGATIVE_INFINITY;
  }
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const local = new Date(now + offsetMs);
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const todayStart = dayStartLocal - offsetMs;
  switch (period) {
    case "today":
      return todayStart;
    case "7d":
      return todayStart - 6 * DAY_MS;
    case "30d":
      return todayStart - 29 * DAY_MS;
    case "custom":
      // A custom window without its days falls back to a month, as the page does.
      return todayStart - 29 * DAY_MS;
  }
}

/** The window a query asks for: a preset, or the days it picked. */
export function windowOf(query: {
  period: GatewayUsagePeriodWire;
  now: number;
  timezoneOffsetMinutes: number;
  from?: string;
  to?: string;
  since?: number;
  until?: number;
}): { since: number; until: number } {
  if (
    query.since !== undefined &&
    query.until !== undefined &&
    Number.isFinite(query.since) &&
    Number.isFinite(query.until) &&
    query.since <= query.until
  ) {
    return { since: query.since, until: Math.min(query.now, query.until) };
  }
  if (query.period === "custom" && query.from !== undefined && query.to !== undefined) {
    const since = startOfDay(query.from, query.timezoneOffsetMinutes);
    const dayEnd = startOfDay(query.to, query.timezoneOffsetMinutes);
    if (since !== null && dayEnd !== null) {
      const until = Math.min(query.now, dayEnd + DAY_MS - 1);
      if (since <= until) {
        return { since, until };
      }
    }
  }
  return {
    since: periodStart(
      query.period === "custom" ? "30d" : query.period,
      query.now,
      query.timezoneOffsetMinutes,
    ),
    until: query.now,
  };
}

/** The instant a `YYYY-MM-DD` day starts in the reader's zone. */
function startOfDay(day: string, timezoneOffsetMinutes: number): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return null;
  }
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(utc) ? utc - timezoneOffsetMinutes * 60_000 : null;
}

/**
 * The request ids with a call that succeeded. A failed try of one of them was
 * taken over by a later try, so it is in neither `calls` nor `failed` — myna's
 * rule for a request answered on a retry.
 */
function succeededRequestIds(records: readonly UsageRecord[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.ok && record.requestId !== undefined) {
      ids.add(record.requestId);
    }
  }
  return ids;
}

function bucketFor(
  period: GatewayUsagePeriodWire,
  records: readonly UsageRecord[],
  now: number,
  since: number,
  until: number,
): "hour" | "day" | "week" {
  if (period === "today") {
    return "hour";
  }
  if (period === "custom") {
    return until - since <= DAY_MS ? "hour" : "day";
  }
  if (period !== "all") {
    return "day";
  }
  const first = records.reduce((earliest, record) => {
    const at = Date.parse(record.time);
    return Number.isFinite(at) && at < earliest ? at : earliest;
  }, now);
  return now - first > 90 * DAY_MS ? "week" : "day";
}

function buildSeries(
  records: readonly UsageRecord[],
  since: number,
  until: number,
  timezoneOffsetMinutes: number,
  bucket: "hour" | "day" | "week",
  handedOnIds: ReadonlySet<string>,
): GatewayUsagePointWire[] {
  let step = HOUR_MS;
  if (bucket === "day") {
    step = DAY_MS;
  } else if (bucket === "week") {
    step = 7 * DAY_MS;
  }
  const offsetMs = timezoneOffsetMinutes * 60_000;
  const start = since === Number.NEGATIVE_INFINITY ? firstRecordTime(records, until) : since;
  const aligned = alignLocal(start, bucket, offsetMs);
  const buckets = new Map<number, SeriesBucket>();
  const count = Math.min(Math.ceil((until - aligned) / step) + 1, 400);
  for (let index = 0; index < count; index += 1) {
    const at = aligned + index * step;
    buckets.set(at, {
      ...emptyAccumulator(),
      label: labelOf(at, bucket, offsetMs),
      start: at,
    });
  }
  for (const record of records) {
    const at = Date.parse(record.time);
    if (!Number.isFinite(at)) {
      continue;
    }
    const key = aligned + Math.floor((at - aligned) / step) * step;
    const bucketAcc = buckets.get(key);
    if (bucketAcc !== undefined) {
      addRecord(bucketAcc, record, handedOnIds);
    }
  }
  return [...buckets.values()].map((entry) => ({
    label: entry.label,
    start: new Date(entry.start).toISOString(),
    calls: entry.calls,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    costUsd: entry.costUsd,
  }));
}

function firstRecordTime(records: readonly UsageRecord[], fallback: number): number {
  return records.reduce((earliest, record) => {
    const at = Date.parse(record.time);
    return Number.isFinite(at) && at < earliest ? at : earliest;
  }, fallback);
}

function alignLocal(at: number, bucket: "hour" | "day" | "week", offsetMs: number): number {
  if (bucket === "hour") {
    return Math.floor(at / HOUR_MS) * HOUR_MS;
  }
  const local = new Date(at + offsetMs);
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const dayStart = dayStartLocal - offsetMs;
  if (bucket === "day") {
    return dayStart;
  }
  const weekday = (new Date(dayStart + offsetMs).getUTCDay() + 6) % 7;
  return dayStart - weekday * DAY_MS;
}

function labelOf(at: number, bucket: "hour" | "day" | "week", offsetMs: number): string {
  const local = new Date(at + offsetMs);
  if (bucket === "hour") {
    return String(local.getUTCHours()).padStart(2, "0");
  }
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function emptyAccumulator(): UsageAccumulator {
  return {
    calls: 0,
    failed: 0,
    handedOn: 0,
    retried: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
    timedCalls: 0,
    ttftMs: 0,
    promptTokens: 0,
    promptCalls: 0,
    promptBySlice: new Map(),
  };
}

function emptyTotals(): UsageAccumulator {
  return emptyAccumulator();
}

/**
 * Adds one call. `inputTokens` is displayed without its cache reads: the
 * Anthropic shape reports them apart, the OpenAI and Gemini shapes count them
 * in the prompt. The record names the protocol it went upstream in, so the two
 * are told apart even when the client spoke another one.
 */
function addRecord(
  target: UsageAccumulator,
  record: UsageRecord,
  handedOnIds: ReadonlySet<string> = EMPTY_IDS,
): void {
  const cacheRead = Math.max(0, record.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, record.cacheWriteTokens ?? 0);
  const cacheInPrompt = (record.upstreamProtocol ?? record.protocol) !== "anthropic";
  const input = cacheInPrompt ? Math.max(0, record.inputTokens - cacheRead) : record.inputTokens;
  target.inputTokens += input;
  target.outputTokens += record.outputTokens;
  target.cacheReadTokens += cacheRead;
  target.cacheWriteTokens += cacheWrite;
  target.reasoningTokens += Math.max(0, record.reasoningTokens ?? 0);
  target.promptTokens += input + cacheRead + cacheWrite;
  target.costUsd += Number.isFinite(record.costUsd) ? record.costUsd : 0;
  if (record.ok) {
    target.calls += 1;
    if (record.attempts > 1) {
      target.retried += 1;
    }
    if (!recordPriced(record) && record.inputTokens + record.outputTokens > 0) {
      target.unpricedCalls += 1;
    }
  } else if (record.requestId !== undefined && handedOnIds.has(record.requestId)) {
    target.handedOn += 1;
  } else {
    target.failed += 1;
  }
  if (record.prompt !== undefined) {
    target.promptCalls += 1;
    for (const part of record.prompt.parts) {
      target.promptBySlice.set(part.kind, (target.promptBySlice.get(part.kind) ?? 0) + part.tokens);
    }
  }
  if (record.ttftMs !== undefined && record.ttftMs >= 0) {
    target.timedCalls += 1;
    target.ttftMs += record.ttftMs;
  }
}

/**
 * Whether a call was priced. Records written before the flag existed can only
 * be told by their cost: a positive one was priced, zero may not have been.
 */
function recordPriced(record: UsageRecord): boolean {
  return record.priced ?? record.costUsd > 0;
}

function finishTotals(source: UsageAccumulator): GatewayUsageTotalsWire {
  return {
    calls: source.calls,
    failed: source.failed,
    handedOn: source.handedOn,
    retried: source.retried,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cacheReadTokens: source.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens,
    reasoningTokens: source.reasoningTokens,
    costUsd: source.costUsd,
    unpricedCalls: source.unpricedCalls,
    cacheHitRate: source.promptTokens > 0 ? source.cacheReadTokens / source.promptTokens : null,
    meanTtftMs: source.timedCalls > 0 ? source.ttftMs / source.timedCalls : null,
  };
}

/** What a group's prompts held, or null when none of its calls was read. */
function finishPrompt(source: UsageAccumulator): GatewayUsagePromptWire | null {
  if (source.promptCalls === 0) {
    return null;
  }
  const order = ["system", "tools", "results", "chat", "other"] as const;
  let tokens = 0;
  for (const value of source.promptBySlice.values()) {
    tokens += value;
  }
  return {
    tokens,
    calls: source.promptCalls,
    parts: order.flatMap((kind) => {
      const partTokens = source.promptBySlice.get(kind);
      return partTokens === undefined ? [] : [{ kind, tokens: partTokens }];
    }),
  };
}

/** Groups records by `keyOf`, most tokens first, with at most 40 groups. */
function rank(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
  nameOf: (record: UsageRecord) => string,
  extra: ((record: UsageRecord) => { id?: string; sub?: string }) | undefined,
  handedOnIds: ReadonlySet<string>,
): GatewayUsageGroupWire[] {
  const groups = new Map<string, { name: string; sub?: string; totals: UsageAccumulator }>();
  for (const record of records) {
    const key = keyOf(record);
    const found = groups.get(key);
    if (found === undefined) {
      const sub = extra?.(record)?.sub;
      const totals = emptyAccumulator();
      addRecord(totals, record, handedOnIds);
      groups.set(key, {
        name: nameOf(record),
        ...(sub === undefined || sub.length === 0 ? {} : { sub }),
        totals,
      });
      continue;
    }
    addRecord(found.totals, record, handedOnIds);
  }
  const ranked: GatewayUsageGroupWire[] = [];
  for (const [id, group] of groups) {
    const prompt = finishPrompt(group.totals);
    ranked.push({
      id,
      name: group.name,
      ...(group.sub === undefined ? {} : { sub: group.sub }),
      ...finishTotals(group.totals),
      ...(prompt === null ? {} : { prompt }),
    });
  }
  return ranked.sort((left, right) => tokensOf(right) - tokensOf(left)).slice(0, 40);
}

function tokensOf(group: GatewayUsageTotalsWire): number {
  return group.inputTokens + group.outputTokens;
}

function requestPage(
  records: readonly UsageRecord[],
  query: UsageReportQuery,
  keyLabels: ReadonlyMap<string, string> | undefined,
  handedOnIds: ReadonlySet<string>,
): GatewayUsageReportWire["requests"] {
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), MAX_PAGE_LIMIT);
  const needle = (query.query ?? "").trim().toLowerCase();
  const filtered = records
    .filter((record) => matchesFilters(record, query, needle, handedOnIds))
    .sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
  const offset = Math.min(Math.max(Math.trunc(query.offset), 0), filtered.length);
  const rows = filtered
    .slice(offset, offset + limit)
    .map((record) => requestRow(record, keyLabels, handedOnIds));
  return { rows, total: filtered.length, offset, limit };
}

/** The picked dimension, each one optional: an unset filter keeps every call. */
function matchesDimensions(record: UsageRecord, query: UsageReportQuery): boolean {
  if (query.client !== undefined && clientOf(record) !== query.client) {
    return false;
  }
  if (query.model !== undefined && record.model !== query.model) {
    return false;
  }
  if (query.provider !== undefined && record.provider !== query.provider) {
    return false;
  }
  if (query.account !== undefined && (record.account ?? "") !== query.account) {
    return false;
  }
  return query.key === undefined || maskKey(record.key ?? "") === query.key;
}

function matchesFilters(
  record: UsageRecord,
  query: UsageReportQuery,
  needle: string,
  handedOnIds: ReadonlySet<string>,
): boolean {
  if (!matchesDimensions(record, query)) {
    return false;
  }
  if (query.failedOnly === true) {
    const handedOn =
      !record.ok && record.requestId !== undefined && handedOnIds.has(record.requestId);
    if (record.ok || handedOn) {
      return false;
    }
  }
  if (query.retriedOnly === true && (!record.ok || record.attempts <= 1)) {
    return false;
  }
  if (needle.length === 0) {
    return true;
  }
  return [
    clientOf(record),
    record.model,
    record.requested,
    record.provider,
    record.account ?? "",
  ].some((value) => value.toLowerCase().includes(needle));
}

function requestRow(
  record: UsageRecord,
  keyLabels: ReadonlyMap<string, string> | undefined,
  handedOnIds: ReadonlySet<string>,
): GatewayUsageRequestWire {
  const cacheRead = Math.max(0, record.cacheReadTokens ?? 0);
  const cacheInPrompt = (record.upstreamProtocol ?? record.protocol) !== "anthropic";
  return {
    time: record.time,
    client: clientOf(record),
    requested: record.requested,
    model: record.model,
    provider: record.provider,
    account: record.account ?? null,
    protocol: record.protocol,
    ...(record.upstreamProtocol === undefined ? {} : { upstreamProtocol: record.upstreamProtocol }),
    ...(record.gatewayCallId === undefined ? {} : { gatewayCallId: record.gatewayCallId }),
    status: record.status,
    ok: record.ok,
    attempts: record.attempts,
    durationMs: record.durationMs,
    inputTokens: cacheInPrompt ? Math.max(0, record.inputTokens - cacheRead) : record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: Math.max(0, record.cacheWriteTokens ?? 0),
    ...(record.cacheWrite1hTokens === undefined
      ? {}
      : { cacheWrite1hTokens: Math.max(0, record.cacheWrite1hTokens) }),
    reasoningTokens: Math.max(0, record.reasoningTokens ?? 0),
    costUsd: Number.isFinite(record.costUsd) ? record.costUsd : 0,
    priced: recordPriced(record),
    ...(record.ttftMs === undefined ? {} : { ttftMs: record.ttftMs }),
    handedOn: !record.ok && record.requestId !== undefined && handedOnIds.has(record.requestId),
    key: record.key === null || record.key === undefined ? null : maskKey(record.key),
    ...(record.key === null || record.key === undefined
      ? {}
      : { keyLabel: keyLabels?.get(record.key) ?? maskKey(record.key) }),
    ...extraFields(record),
  };
}

/**
 * The fields a row has only when its call did: Neolix's probe, the reply id,
 * the archive, and myna's ledger columns the gateway records when it knows
 * them (host, effort, tier, errors, credits, the session's own provider).
 */
function extraFields(record: UsageRecord): Partial<GatewayUsageRequestWire> {
  return {
    ...(record.probe === undefined ? {} : { probe: record.probe }),
    ...(record.responseId === undefined ? {} : { responseId: record.responseId }),
    ...(record.archive === undefined ? {} : { archive: record.archive }),
    ...(record.host === undefined ? {} : { host: record.host }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    ...(record.kind === undefined ? {} : { kind: record.kind }),
    ...(record.providerKeyId === undefined ? {} : { providerKeyId: record.providerKeyId }),
    ...(record.providerKeyName === undefined ? {} : { providerKeyName: record.providerKeyName }),
    ...(record.routeId === undefined ? {} : { routeId: record.routeId }),
    ...(record.endpoint === undefined ? {} : { endpoint: record.endpoint }),
    ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
    ...(record.errorType === undefined ? {} : { errorType: record.errorType }),
    ...(record.tierAsked === undefined ? {} : { tierAsked: record.tierAsked }),
    ...(record.tierSent === undefined ? {} : { tierSent: record.tierSent }),
    ...(record.tierServed === undefined ? {} : { tierServed: record.tierServed }),
    ...(record.upstreamStop === undefined ? {} : { upstreamStop: record.upstreamStop }),
    ...(record.credits === undefined ? {} : { credits: record.credits }),
    ...(record.sessionProvider === undefined ? {} : { sessionProvider: record.sessionProvider }),
    ...(record.sessionAccount === undefined ? {} : { sessionAccount: record.sessionAccount }),
  };
}
