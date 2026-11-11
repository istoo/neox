import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  GATEWAY_QUOTA_HISTORY_FILENAME,
  type QuotaHistoryEntry,
  type QuotaHistoryFilter,
} from "../llm-gateway/quota-history.js";
import { GATEWAY_USAGE_FILENAME, type UsageRecord } from "../llm-gateway/usage.js";
import { readUsageRecords } from "../llm-gateway/usage-report.js";
import { writePrivateFileAtomic } from "../private-files.js";
import { openData, sealData } from "./archive.js";

/**
 * Shared usage (myna `internal/davsync/usage.go`): each computer puts its
 * own calls of a day on the server at `usage/<id>-<day>.neolix-usage`, one
 * file a day sealed with the sync passphrase, and its quota readings at
 * `usage/<id>.neolix-quotas`; every computer brings the others' down and the
 * Usage page reads all of them. A computer writes and deletes its own files
 * alone, so none is ever written over by another. None of it is in a backup
 * or a restore: losing it costs a chart, not a setup.
 */
export const USAGE_DIR = "usage";
/** myna's `.myna-usage` / `.myna-quotas`, under Neolix's own names. */
export const USAGE_FILE_EXT = ".neolix-usage";
export const QUOTAS_FILE_EXT = ".neolix-quotas";
/** How many days of calls a computer keeps on the server (myna SharedDays). */
export const SHARED_DAYS = 90;
/** How many days of quota readings are shared (myna keeps 45). */
export const QUOTA_DAYS = 45;
/** How often a sync shares usage; a sync asked for shares it whatever the time. */
export const USAGE_EVERY_MS = 15 * 60_000;
/** The rows one `sync.usage.get` answers with, as myna's ledger page does. */
const MAX_REPORT_ROWS = 500;

const DEVICE_FILENAME = "sync-usage-device.json";
const OTHERS_DIR = "usage-others";
const QUOTAS_LOCAL_FILENAME = "quotas.json";

/**
 * One call as the shared ledger has it: myna's `usage.Record` field names,
 * never a request's content.
 */
export interface SharedUsageCall {
  t: string;
  agent: string;
  provider: string;
  providerAccount?: string;
  model: string;
  /** The model the agent asked for, when it differs from the one served. */
  req?: string;
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  reasoning?: number;
  ms: number;
  status: number;
  cost: number;
  priced: boolean;
  /** myna's `source`: "log" for one read from an agent's session file. */
  source?: string;
}

/** One computer's calls of one day (myna `usage.SharedDay`). */
export interface SharedUsageDay {
  computer: string;
  name: string;
  day: string;
  calls: SharedUsageCall[];
}

/** One computer's quota readings, as its `<id>.neolix-quotas` file carries them. */
export interface SharedQuotas {
  version: 1;
  computer: string;
  name: string;
  entries: Record<string, QuotaHistoryEntry[]>;
}

/** What was shared and brought in, kept with the sync's state (myna `usageState`). */
export interface UsageSyncState {
  /** This computer's clock when usage was last shared. */
  at?: string;
  /** This computer's days put on the server, each hashed as sent. */
  sent?: Record<string, string>;
  /** The others' files brought in, each at the version listed. */
  got?: Record<string, string>;
  /** The whole window was put once; after it, only yesterday and today are remade. */
  whole?: boolean;
  /** This computer's quota file as last put, hashed. */
  quotasSent?: string;
  /** The others' quota files brought in, each at the version listed. */
  quotas?: Record<string, string>;
}

/** A remote's usage folder: its files listed with a version each, read, written and deleted by name. */
export interface UsageRemoteFiles {
  list(): Promise<Map<string, string>>;
  read(name: string): Promise<Buffer>;
  write(name: string, data: Buffer): Promise<void>;
  remove(name: string): Promise<void>;
}

/** The Usage page's per-model figures inside a legacy day. */
export interface UsageModelDay {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A day summed from the shared calls, kept for clients that read the old shape. */
export interface UsageDay {
  day: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpricedCalls: number;
  byModel: Record<string, UsageModelDay>;
  updatedAt: string;
}

/**
 * This computer's id: made once and kept, so two computers with the same
 * host name stay apart (myna's `usage-computer.json`). Only the name follows
 * the sync setup.
 */
export async function usageDevice(
  neolixHome: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const file = path.join(neolixHome, DEVICE_FILENAME);
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (isRecord(parsed) && typeof parsed.id === "string" && parsed.id.length > 0) {
      if (parsed.name !== name) {
        await writePrivateFileAtomic(file, `${JSON.stringify({ id: parsed.id, name })}\n`);
      }
      return { id: parsed.id, name };
    }
  } catch {
    // none kept yet
  }
  const created = { id: randomUUID(), name };
  await mkdir(neolixHome, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(file, `${JSON.stringify(created)}\n`);
  await chmod(file, 0o600).catch(() => {});
  return created;
}

function othersRoot(neolixHome: string): string {
  return path.join(neolixHome, OTHERS_DIR);
}

function otherDayFile(neolixHome: string, computer: string, day: string): string {
  return path.join(othersRoot(neolixHome), computer, `${day}.json`);
}

function otherQuotasFile(neolixHome: string, computer: string): string {
  return path.join(othersRoot(neolixHome), computer, QUOTAS_LOCAL_FILENAME);
}

function otherNameFile(neolixHome: string, computer: string): string {
  return path.join(othersRoot(neolixHome), computer, "name");
}

/** The days another computer's folder keeps here. */
async function otherDays(neolixHome: string, computer: string): Promise<string[]> {
  try {
    return (await readdir(path.join(othersRoot(neolixHome), computer)))
      .filter((name) => name.endsWith(".json") && name !== QUOTAS_LOCAL_FILENAME)
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

async function latestSharedDay(neolixHome: string, computer: string): Promise<string> {
  return (await otherDays(neolixHome, computer)).at(-1) ?? "";
}

/** Keeps another computer's day here, over the one kept before (myna `KeepShared`). */
export async function keepShared(neolixHome: string, day: SharedUsageDay): Promise<void> {
  if (!validComputer(day.computer) || !validDay(day.day)) {
    throw new Error("A shared usage day is named for another computer or day");
  }
  const dir = path.join(othersRoot(neolixHome), day.computer);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = otherDayFile(neolixHome, day.computer, day.day);
  await writePrivateFileAtomic(target, `${JSON.stringify(day)}\n`);
  await chmod(target, 0o600).catch(() => {});
  if (day.name.length > 0 && day.day >= (await latestSharedDay(neolixHome, day.computer))) {
    await writePrivateFileAtomic(otherNameFile(neolixHome, day.computer), day.name);
  }
}

/** The other computers a folder here holds, whether days or quota readings. */
async function otherComputers(neolixHome: string): Promise<string[]> {
  try {
    return (await readdir(othersRoot(neolixHome), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && validComputer(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The other computers' days kept here, as `<id>/<day>`. */
export async function sharedKept(neolixHome: string): Promise<string[]> {
  const out: string[] = [];
  for (const computer of await otherComputers(neolixHome)) {
    for (const day of await otherDays(neolixHome, computer)) {
      if (validDay(day)) {
        out.push(`${computer}/${day}`);
      }
    }
  }
  return out;
}

/** Lets another computer's day go, and its folder with its last one (myna `DropShared`). */
export async function dropShared(neolixHome: string, computer: string, day: string): Promise<void> {
  if (!validComputer(computer)) {
    return;
  }
  await rm(otherDayFile(neolixHome, computer, day), { force: true });
  if ((await otherDays(neolixHome, computer)).length === 0) {
    await rm(otherQuotasFile(neolixHome, computer), { force: true });
    await rm(otherNameFile(neolixHome, computer), { force: true });
    await rm(path.join(othersRoot(neolixHome), computer), { recursive: true, force: true });
  }
}

/** Lets every other computer's usage go: sync, or its sharing of usage, was turned off. */
export async function dropOtherUsage(neolixHome: string): Promise<void> {
  await rm(othersRoot(neolixHome), { recursive: true, force: true });
}

async function keptOtherDay(
  neolixHome: string,
  computer: string,
  day: string,
): Promise<SharedUsageDay | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(otherDayFile(neolixHome, computer, day), "utf8"),
    );
    return sharedDayOf(parsed);
  } catch {
    return null;
  }
}

async function keepOtherQuotas(
  neolixHome: string,
  computer: string,
  value: SharedQuotas,
): Promise<void> {
  const dir = path.join(othersRoot(neolixHome), computer);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = otherQuotasFile(neolixHome, computer);
  await writePrivateFileAtomic(target, `${JSON.stringify(value)}\n`);
  await chmod(target, 0o600).catch(() => {});
}

async function otherName(neolixHome: string, computer: string): Promise<string> {
  try {
    const name = (await readFile(otherNameFile(neolixHome, computer), "utf8")).trim();
    return name.length > 0 ? name : computer;
  } catch {
    return computer;
  }
}

async function keptOtherQuotas(neolixHome: string, computer: string): Promise<SharedQuotas | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(otherQuotasFile(neolixHome, computer), "utf8"),
    );
    return sharedQuotasOf(parsed);
  } catch {
    return null;
  }
}

/** This computer's calls since the day of `sinceDay`, by day (myna `OwnDays`). */
export async function readOwnSharedDays(
  neolixHome: string,
  sinceDay: string,
): Promise<Map<string, SharedUsageCall[]>> {
  const since = dayStart(sinceDay);
  const filePath = path.join(neolixHome, GATEWAY_USAGE_FILENAME);
  let records: UsageRecord[] = [];
  try {
    records = await readUsageRecords(filePath, since);
  } catch {
    records = [];
  }
  const byDay = new Map<string, SharedUsageCall[]>();
  for (const record of records) {
    // A probe is Neolix's own test, as myna's probelog: no agent made the call.
    if (record.probe !== undefined) {
      continue;
    }
    const at = Date.parse(record.time);
    if (!Number.isFinite(at) || at < since) {
      continue;
    }
    const day = localDayOf(at);
    const list = byDay.get(day) ?? [];
    list.push(sharedCallOf(record));
    byDay.set(day, list);
  }
  for (const list of byDay.values()) {
    list.sort((left, right) => Date.parse(left.t) - Date.parse(right.t));
  }
  return byDay;
}

function sharedCallOf(record: UsageRecord): SharedUsageCall {
  return {
    t: record.time,
    agent: record.client && record.client.length > 0 ? record.client : "neolix",
    provider: record.provider,
    ...(record.account ? { providerAccount: record.account } : {}),
    model: record.model,
    ...(record.requested && record.requested !== record.model ? { req: record.requested } : {}),
    in: record.inputTokens,
    out: record.outputTokens,
    cache_read: record.cacheReadTokens ?? 0,
    cache_write: record.cacheWriteTokens ?? 0,
    ...(record.reasoningTokens ? { reasoning: record.reasoningTokens } : {}),
    ms: record.durationMs,
    status: record.status,
    cost: record.costUsd,
    priced: record.priced === true,
  };
}

function localDayOf(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The local midnight of a `YYYY-MM-DD` day. */
function dayStart(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return Number.NaN;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

function todayOf(now: number): string {
  return localDayOf(now);
}

function addDays(day: string, count: number): string {
  const start = new Date(dayStart(day));
  start.setDate(start.getDate() + count);
  return todayOf(start.getTime());
}

function validDay(day: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const parsed = new Date(year, month, date);
  return parsed.getFullYear() === year && parsed.getMonth() === month && parsed.getDate() === date;
}

function validComputer(id: string): boolean {
  return /^[0-9a-f-]{8,64}$/i.test(id);
}

async function readOwnQuotas(
  neolixHome: string,
  now: number,
): Promise<Record<string, QuotaHistoryEntry[]>> {
  const cutoff = now - QUOTA_DAYS * 24 * 60 * 60_000;
  const grouped = new Map<string, QuotaHistoryEntry[]>();
  let lines: string[];
  try {
    lines = (await readFile(path.join(neolixHome, GATEWAY_QUOTA_HISTORY_FILENAME), "utf8")).split(
      "\n",
    );
  } catch {
    return {};
  }
  for (const line of lines) {
    const entry = parseQuotaEntry(line);
    if (entry === null || entry.at < cutoff) {
      continue;
    }
    const key = `${entry.provider}/${entry.account}`;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }
  const out: Record<string, QuotaHistoryEntry[]> = {};
  for (const [key, list] of grouped) {
    list.sort((left, right) => left.at - right.at);
    out[key] = list;
  }
  return out;
}

function parseQuotaEntry(line: string): QuotaHistoryEntry | null {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      return null;
    }
    if (typeof parsed.at !== "number" || typeof parsed.provider !== "string") {
      return null;
    }
    if (typeof parsed.account !== "string") {
      return null;
    }
    const num = (value: unknown): number | null =>
      typeof value === "number" && Number.isFinite(value) ? value : null;
    return {
      at: parsed.at,
      provider: parsed.provider,
      account: parsed.account,
      remaining: num(parsed.remaining),
      limit: num(parsed.limit),
      resetAt: num(parsed.resetAt),
      usedPercent: num(parsed.usedPercent),
    };
  } catch {
    return null;
  }
}

/**
 * Merges every computer's readings into one history (myna
 * `provider.MergeQuotaHistory`): the union, a point kept once by account and
 * when it was read, sorted, and everything older than 45 days gone. No
 * downsampling: myna keeps every point.
 */
function mergeQuotaMaps(
  maps: readonly Record<string, QuotaHistoryEntry[]>[],
  now: number,
): Record<string, QuotaHistoryEntry[]> {
  const cutoff = now - QUOTA_DAYS * 24 * 60 * 60_000;
  const seen = new Map<string, QuotaHistoryEntry>();
  for (const map of maps) {
    for (const list of Object.values(map)) {
      for (const entry of list) {
        if (entry.at < cutoff) {
          continue;
        }
        seen.set(`${entry.provider}\0${entry.account}\0${entry.at}`, entry);
      }
    }
  }
  const out: Record<string, QuotaHistoryEntry[]> = {};
  for (const entry of [...seen.values()].sort((left, right) => left.at - right.at)) {
    const key = `${entry.provider}/${entry.account}`;
    const list = out[key] ?? [];
    list.push(entry);
    out[key] = list;
  }
  return out;
}

/**
 * The other computers' readings kept here, each saying which computer it
 * came from, for `QuotaHistoryStore`'s read-side overlay. The gateway's own
 * file is not one of them: that history is the store's.
 */
export async function readOtherQuotaReadings(
  neolixHome: string,
  since: number,
  filter: QuotaHistoryFilter = {},
  now = Date.now(),
): Promise<QuotaHistoryEntry[]> {
  const cutoff = Math.max(since, now - QUOTA_DAYS * 24 * 60 * 60_000);
  const wantedAccount = filter.account?.toLowerCase();
  const seen = new Map<string, QuotaHistoryEntry>();
  for (const computer of await otherComputers(neolixHome)) {
    const shared = await keptOtherQuotas(neolixHome, computer);
    for (const list of Object.values(shared?.entries ?? {})) {
      for (const entry of list) {
        if (entry.at < cutoff) {
          continue;
        }
        if (filter.provider !== undefined && entry.provider !== filter.provider) {
          continue;
        }
        if (wantedAccount !== undefined && entry.account.toLowerCase() !== wantedAccount) {
          continue;
        }
        const key = `${entry.provider}\0${entry.account}\0${entry.at}`;
        if (!seen.has(key)) {
          seen.set(key, { ...entry, device: computer });
        }
      }
    }
  }
  return [...seen.values()].sort((left, right) => left.at - right.at);
}

/** This computer's readings and every other computer's kept here, merged. */
export async function readMergedQuotas(
  neolixHome: string,
  now = Date.now(),
): Promise<Record<string, QuotaHistoryEntry[]>> {
  const maps = [await readOwnQuotas(neolixHome, now)];
  for (const computer of await otherComputers(neolixHome)) {
    const quotas = await keptOtherQuotas(neolixHome, computer);
    if (quotas !== null) {
      maps.push(quotas.entries);
    }
  }
  return mergeQuotaMaps(maps, now);
}

/**
 * Puts this computer's days and quota readings on the server and brings the
 * others' in (myna `shareWith`). The whole 90-day window goes the first time;
 * after that only yesterday and today are made again, and a file whose day
 * did not change is not sent again.
 */
// eslint-disable-next-line complexity -- one branch per file kind and state, as myna's shareWith.
export async function shareUsage(options: {
  neolixHome: string;
  passphrase: string;
  device: { id: string; name: string };
  state: UsageSyncState;
  files: UsageRemoteFiles;
  now?: number;
}): Promise<void> {
  const { neolixHome, passphrase, device, state, files } = options;
  const now = options.now ?? Date.now();
  const today = todayOf(now);
  const from = addDays(today, 1 - SHARED_DAYS);
  const since = state.whole === true ? addDays(today, -1) : from;
  state.sent ??= {};
  state.got ??= {};
  state.quotas ??= {};

  const ownDays = await readOwnSharedDays(neolixHome, since);
  for (const day of [...ownDays.keys()].sort()) {
    if (day < from) {
      continue;
    }
    const shared: SharedUsageDay = {
      computer: device.id,
      name: device.name,
      day,
      calls: ownDays.get(day) ?? [],
    };
    const plain = JSON.stringify(shared);
    const digest = hashOf(plain);
    if (state.sent[day] === digest) {
      continue;
    }
    await files.write(
      `${device.id}-${day}${USAGE_FILE_EXT}`,
      sealData(Buffer.from(plain), passphrase),
    );
    state.sent[day] = digest;
  }
  state.whole = true;

  const listed = await files.list();
  const kept = new Set(await sharedKept(neolixHome));
  const there = new Set<string>();
  for (const [file, version] of [...listed.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const named = parseUsageName(file);
    if (named === null) {
      continue;
    }
    const { computer, day } = named;
    if (computer === device.id) {
      if (day < from) {
        await files.remove(file);
      }
      continue;
    }
    if (day < from) {
      continue;
    }
    const key = `${computer}/${day}`;
    there.add(key);
    if (version.length > 0 && state.got[file] === version && kept.has(key)) {
      continue;
    }
    const shared = await readSharedDay(files, file, passphrase);
    if (shared.computer !== computer || shared.day !== day) {
      continue; // named for another: left alone
    }
    await keepShared(neolixHome, shared);
    state.got[file] = version;
  }
  for (const day of Object.keys(state.sent)) {
    if (day < from) {
      delete state.sent[day];
    }
  }
  // What the server no longer has goes here too.
  for (const key of kept) {
    if (!there.has(key)) {
      const cut = key.indexOf("/");
      await dropShared(neolixHome, key.slice(0, cut), key.slice(cut + 1));
    }
  }
  for (const file of Object.keys(state.got)) {
    const named = parseUsageName(file);
    if (named === null || !there.has(`${named.computer}/${named.day}`)) {
      delete state.got[file];
    }
  }
  await shareQuotas(neolixHome, passphrase, device, state, files, listed, now);
  state.at = new Date(now).toISOString();
}

async function readSharedDay(
  files: UsageRemoteFiles,
  name: string,
  passphrase: string,
): Promise<SharedUsageDay> {
  const parsed: unknown = JSON.parse(openData(await files.read(name), passphrase).toString("utf8"));
  return sharedDayOf(parsed);
}

/**
 * Merges the others' quota histories into this one's, then puts this one's
 * up when it changed (myna `shareQuotas`). The merge keeps each point once,
 * so what came from another and goes up again with this one's is nothing
 * twice.
 */
async function shareQuotas(
  neolixHome: string,
  passphrase: string,
  device: { id: string; name: string },
  state: UsageSyncState,
  files: UsageRemoteFiles,
  listed: ReadonlyMap<string, string>,
  now: number,
): Promise<void> {
  const quotas = state.quotas ?? {};
  for (const [file, version] of [...listed.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const computer = parseQuotasName(file);
    if (computer === null || computer === device.id) {
      continue;
    }
    if (version.length > 0 && quotas[file] === version) {
      continue;
    }
    const parsed: unknown = JSON.parse(
      openData(await files.read(file), passphrase).toString("utf8"),
    );
    const shared = sharedQuotasOf(parsed);
    if (shared === null || shared.computer !== computer) {
      continue;
    }
    await keepOtherQuotas(neolixHome, computer, shared);
    quotas[file] = version;
  }
  for (const file of Object.keys(quotas)) {
    if (!listed.has(file)) {
      const computer = parseQuotasName(file);
      if (computer !== null) {
        await rm(otherQuotasFile(neolixHome, computer), { force: true });
      }
      delete quotas[file];
    }
  }
  state.quotas = quotas;

  const merged = await readMergedQuotas(neolixHome, now);
  if (Object.keys(merged).length === 0) {
    return;
  }
  const plain = JSON.stringify({
    version: 1,
    computer: device.id,
    name: device.name,
    entries: sortedQuotas(merged),
  });
  const digest = hashOf(plain);
  if (state.quotasSent === digest) {
    return;
  }
  await files.write(
    `${device.id}${QUOTAS_FILE_EXT}`,
    sealData(Buffer.from(plain, "utf8"), passphrase),
  );
  state.quotasSent = digest;
}

function sortedQuotas(
  entries: Record<string, QuotaHistoryEntry[]>,
): Record<string, QuotaHistoryEntry[]> {
  const out: Record<string, QuotaHistoryEntry[]> = {};
  for (const key of Object.keys(entries).sort()) {
    out[key] = entries[key]!;
  }
  return out;
}

interface UsageTotals {
  calls: number;
  errors: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost: number;
  unpriced: number;
}

export interface UsageShare extends UsageTotals {
  id: string;
  name: string;
}

export interface UsageSeriesPoint extends UsageTotals {
  label: string;
  time: string;
}

/** A call as the Usage page's ledger reads it (myna `usageapi.Row`). */
export interface UsageReportRow extends SharedUsageCall {
  computer?: string;
  computerName?: string;
}

/** One reading of an account's window over time (myna `provider.QuotaPoint`). */
export interface UsageQuotaPoint {
  at: string;
  /** Percent left. */
  left: number;
  resetsAt?: string;
}

/** One account's windows (myna `provider.QuotaHistory`); Neolix has one allowance window. */
export interface UsageQuotaHistory {
  provider: string;
  user: string;
  lines: { name: string; points: UsageQuotaPoint[] }[];
}

/**
 * What `sync.usage.get` returns: every computer's days summed as myna's
 * `Usage` page reads them — the shared totals, the day series, the computers
 * and their calls — beside the legacy per-device days and the quota readings.
 * The calls are the page's first 500, newest first, as myna's ledger pages.
 */
// eslint-disable-next-line complexity -- one pass over days, calls, computers and quotas.
export async function usageReport(
  neolixHome: string,
  device: { id: string; name: string },
  now = Date.now(),
): Promise<{
  period: "90d";
  since: string;
  calls: number;
  errors: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  reasoning: number;
  cost: number;
  unpriced: number;
  bucket: "day";
  series: UsageSeriesPoint[];
  computers?: UsageShare[];
  rows: UsageReportRow[];
  total: number;
  offset: number;
  devices: { id: string; name: string; days: UsageDay[] }[];
  quotas: { device: string; account: string; entries: QuotaHistoryEntry[] }[];
  quotaHistory: UsageQuotaHistory[];
}> {
  const from = addDays(todayOf(now), 1 - SHARED_DAYS);
  const devices = new Map<string, { name: string; days: Map<string, SharedUsageCall[]> }>();
  devices.set(device.id, { name: device.name, days: await readOwnSharedDays(neolixHome, from) });

  const kept = await sharedKept(neolixHome);
  for (const key of kept) {
    const cut = key.indexOf("/");
    const computer = key.slice(0, cut);
    const day = key.slice(cut + 1);
    if (day < from) {
      continue;
    }
    const shared = await keptOtherDay(neolixHome, computer, day);
    if (shared === null) {
      continue;
    }
    const entry = devices.get(computer) ?? { name: shared.name || computer, days: new Map() };
    entry.name = shared.name || entry.name;
    entry.days.set(day, shared.calls);
    devices.set(computer, entry);
  }

  const rows: UsageReportRow[] = [];
  for (const [id, entry] of devices) {
    for (const [day, calls] of entry.days) {
      if (day < from) {
        continue;
      }
      for (const call of calls) {
        rows.push(
          id === device.id
            ? { ...call }
            : { ...call, computer: id, computerName: entry.name || id },
        );
      }
    }
  }
  rows.sort((left, right) => Date.parse(right.t) - Date.parse(left.t));

  const totals = totalsOf(rows);
  const series = seriesOf(rows, from, todayOf(now));
  // The Computer filter lists the others whose days were brought here, as
  // myna's sharedNames does; a file gone from the server is already gone.
  const names = new Map<string, string>();
  for (const key of kept) {
    const id = key.slice(0, key.indexOf("/"));
    if (!names.has(id)) {
      names.set(id, await otherName(neolixHome, id));
    }
  }
  const computers = computersOf(devices, device.id, names);
  const legacy = [...devices.entries()]
    .map(([id, entry]) => ({
      id,
      name: entry.name,
      days: [...entry.days.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, calls]) => usageDayOf(day, calls)),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const quotas: { device: string; account: string; entries: QuotaHistoryEntry[] }[] = [];
  const ownQuotas = await readOwnQuotas(neolixHome, now);
  for (const [account, entries] of Object.entries(ownQuotas).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    quotas.push({ device: device.id, account, entries });
  }
  for (const id of await otherComputers(neolixHome)) {
    const shared = await keptOtherQuotas(neolixHome, id);
    for (const [account, entries] of Object.entries(shared?.entries ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      quotas.push({ device: id, account, entries });
    }
  }

  const quotaHistory = quotaHistoryOf(await readMergedQuotas(neolixHome, now));

  return {
    period: "90d",
    since: new Date(dayStart(from)).toISOString(),
    ...totals,
    bucket: "day",
    series,
    ...(computers === undefined ? {} : { computers }),
    rows: rows.slice(0, MAX_REPORT_ROWS),
    total: rows.length,
    offset: 0,
    devices: legacy,
    quotas,
    quotaHistory,
  };
}

/** The merged readings as myna's quota histories, by provider and account. */
function quotaHistoryOf(entries: Record<string, QuotaHistoryEntry[]>): UsageQuotaHistory[] {
  return Object.keys(entries)
    .sort()
    .map((key) => {
      const cut = key.indexOf("/");
      const provider = cut < 0 ? key : key.slice(0, cut);
      const user = cut < 0 ? "" : key.slice(cut + 1);
      const points = entries[key]!.map((entry) => {
        const point: UsageQuotaPoint = {
          at: new Date(entry.at).toISOString(),
          left: leftPercentOf(entry),
        };
        if (entry.resetAt !== null) {
          point.resetsAt = new Date(entry.resetAt).toISOString();
        }
        return point;
      });
      return { provider, user, lines: [{ name: "allowance", points }] };
    });
}

function leftPercentOf(entry: QuotaHistoryEntry): number {
  if (entry.usedPercent !== null) {
    return (1 - entry.usedPercent) * 100;
  }
  if (entry.remaining !== null && entry.limit !== null && entry.limit > 0) {
    return (entry.remaining / entry.limit) * 100;
  }
  return 0;
}

function totalsOf(rows: readonly SharedUsageCall[]): UsageTotals {
  const totals: UsageTotals = {
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    cost: 0,
    unpriced: 0,
  };
  for (const row of rows) {
    totals.calls += 1;
    if (row.status >= 400) {
      totals.errors += 1;
    }
    totals.input += row.in;
    totals.output += row.out;
    totals.cache_read += row.cache_read;
    totals.cache_write += row.cache_write;
    totals.reasoning += row.reasoning ?? 0;
    if (row.priced) {
      totals.cost += row.cost;
    } else if (row.in + row.out > 0) {
      totals.unpriced += 1;
    }
  }
  return totals;
}

function seriesOf(
  rows: readonly SharedUsageCall[],
  from: string,
  today: string,
): UsageSeriesPoint[] {
  const byDay = new Map<string, SharedUsageCall[]>();
  for (const row of rows) {
    const at = Date.parse(row.t);
    if (!Number.isFinite(at)) {
      continue;
    }
    const day = localDayOf(at);
    const list = byDay.get(day) ?? [];
    list.push(row);
    byDay.set(day, list);
  }
  // Every day of the window, an empty one as a zero point, as myna's chart
  // draws its buckets.
  const out: UsageSeriesPoint[] = [];
  for (let day = from; day <= today; day = addDays(day, 1)) {
    out.push(
      Object.assign(
        { label: day, time: new Date(dayStart(day)).toISOString() },
        totalsOf(byDay.get(day) ?? []),
      ),
    );
  }
  return out;
}

function computersOf(
  devices: ReadonlyMap<string, { name: string; days: Map<string, SharedUsageCall[]> }>,
  own: string,
  others: ReadonlyMap<string, string>,
): UsageShare[] | undefined {
  // None while no other computer's usage came: myna's page then has no
  // Computer filter at all.
  if (others.size === 0) {
    return undefined;
  }
  const out: UsageShare[] = [
    {
      id: "this",
      name: "",
      ...totalsOf([...(devices.get(own)?.days.values() ?? [])].flat()),
    },
  ];
  for (const [id, name] of others) {
    const entry = devices.get(id);
    out.push({
      id,
      name: name || entry?.name || id,
      ...totalsOf([...(entry?.days.values() ?? [])].flat()),
    });
  }
  return out;
}

function usageDayOf(day: string, calls: readonly SharedUsageCall[]): UsageDay {
  const totals = totalsOf(calls);
  const byModel: Record<string, UsageModelDay> = {};
  let updatedAt = `${day}T00:00:00.000Z`;
  for (const call of calls) {
    const group = byModel[call.model] ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    group.calls += 1;
    group.inputTokens += call.in;
    group.outputTokens += call.out;
    group.costUsd += call.priced ? call.cost : 0;
    byModel[call.model] = group;
    if (Date.parse(call.t) > Date.parse(updatedAt)) {
      updatedAt = call.t;
    }
  }
  return {
    day,
    calls: totals.calls,
    failed: totals.errors,
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cache_read,
    cacheWriteTokens: totals.cache_write,
    reasoningTokens: totals.reasoning,
    costUsd: totals.cost,
    unpricedCalls: totals.unpriced,
    byModel,
    updatedAt,
  };
}

function parseUsageName(name: string): { computer: string; day: string } | null {
  if (!name.endsWith(USAGE_FILE_EXT)) {
    return null;
  }
  const base = name.slice(0, -USAGE_FILE_EXT.length);
  if (base.length < 12) {
    return null;
  }
  // The day is the last ten characters, `YYYY-MM-DD`; the dash before it
  // separates it from the computer (myna `usageName`).
  const computer = base.slice(0, -11);
  const day = base.slice(-10);
  if (base.at(-11) !== "-") {
    return null;
  }
  return validComputer(computer) && validDay(day) ? { computer, day } : null;
}

function parseQuotasName(name: string): string | null {
  if (!name.endsWith(QUOTAS_FILE_EXT)) {
    return null;
  }
  const computer = name.slice(0, -QUOTAS_FILE_EXT.length);
  return validComputer(computer) ? computer : null;
}

function sharedDayOf(value: unknown): SharedUsageDay {
  if (!isRecord(value)) {
    throw new Error("A shared usage day is not an object");
  }
  const computer = typeof value.computer === "string" ? value.computer : "";
  const name = typeof value.name === "string" ? value.name : "";
  const day = typeof value.day === "string" ? value.day : "";
  const calls = Array.isArray(value.calls) ? value.calls : [];
  if (!validComputer(computer) || !validDay(day)) {
    throw new Error("A shared usage day is named for another computer or day");
  }
  return { computer, name, day, calls: calls.filter(isSharedCall) };
}

function isSharedCall(value: unknown): value is SharedUsageCall {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.t === "string" &&
    typeof value.agent === "string" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.in === "number" &&
    typeof value.out === "number" &&
    typeof value.cache_read === "number" &&
    typeof value.cache_write === "number" &&
    typeof value.ms === "number" &&
    typeof value.status === "number" &&
    typeof value.cost === "number" &&
    typeof value.priced === "boolean"
  );
}

function sharedQuotasOf(value: unknown): SharedQuotas | null {
  if (!isRecord(value) || !isRecord(value.entries)) {
    return null;
  }
  const computer = typeof value.computer === "string" ? value.computer : "";
  if (!validComputer(computer)) {
    return null;
  }
  const entries: Record<string, QuotaHistoryEntry[]> = {};
  for (const [account, list] of Object.entries(value.entries)) {
    if (Array.isArray(list)) {
      const kept = list.filter(isQuotaEntry);
      if (kept.length > 0) {
        entries[account] = kept;
      }
    }
  }
  return {
    version: 1,
    computer,
    name: typeof value.name === "string" ? value.name : "",
    entries,
  };
}

function isQuotaEntry(value: unknown): value is QuotaHistoryEntry {
  if (!isRecord(value)) {
    return false;
  }
  const number = (entry: unknown): entry is number | null =>
    entry === null || (typeof entry === "number" && Number.isFinite(entry));
  return (
    typeof value.at === "number" &&
    Number.isFinite(value.at) &&
    typeof value.provider === "string" &&
    typeof value.account === "string" &&
    number(value.remaining) &&
    number(value.limit) &&
    number(value.resetAt) &&
    number(value.usedPercent)
  );
}

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
