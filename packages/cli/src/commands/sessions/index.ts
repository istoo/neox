import { homedir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { Logger } from "pino";
import type { ExternalSession } from "@neolix/protocol/messages";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { GatewayConfigStore } from "@neolix/server/gateway-config";
import {
  foundSessionAgents,
  knownSessionAgents,
  readsSessions,
  sessionAgentName,
  sessionReadsOf,
  sessionRoots,
  setSessionReads,
  type SessionReads,
} from "@neolix/server/sessions-reads";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import {
  addJsonOption,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import type { CommandOptions } from "../../output/index.js";

/**
 * `neolix sessions` — the latest sessions of Claude Code, Codex, Pi, OpenCode
 * and Antigravity; with --days, what they spent day by day. Ported from
 * myna's `myna sessions` (internal/cli/sessions_cli.go:19), with the same
 * flags and the same wording where Neolix records the same facts.
 *
 * `neolix sessions read` is myna's consent list (sessions/access.go): which
 * agents' own session history Neolix may read. It is a setting, so it is read
 * and written in this computer's gateway.json, through the same
 * GatewayConfigStore the daemon watches; no running daemon is needed.
 */

export const SESSIONS_USAGE =
  "usage: neox sessions [--days N|today|all] [--model <model>] [--folder <folder>] [--limit N] [--json]";
export const SESSIONS_READ_USAGE = "usage: neox sessions read [on|off all|<agent>...]";
export const RELOCATE_USAGE =
  "usage: neox sessions relocate-claude --from <absolute-path> --to <absolute-path> [--confirm <preview-token>]";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

export interface SessionsOptions extends CommandOptions {
  days?: string | true;
  stats?: boolean;
  model?: string;
  folder?: string;
  limit?: string;
}

export interface SessionsQuery {
  /** -1 lists sessions; 0 is all time; n > 0 is the last n days. */
  days: number;
  model?: string;
  folder?: string;
  limit: number;
  json: boolean;
}

interface SessionsClient {
  getLastServerInfoMessage(): { features?: { externalSessions?: boolean } } | null;
  listExternalSessions: DaemonClient["listExternalSessions"];
  relocateClaudeProject: DaemonClient["relocateClaudeProject"];
  close: DaemonClient["close"];
}

type ConnectSessions = (options: ConnectOptions) => Promise<SessionsClient>;

export interface SessionsIo {
  write(text: string): void;
  now?: () => Date;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** --home: the daemon home whose gateway.json holds the consent list. */
  neolixHome?: string;
  /** --json: the consent list as data, not prose. */
  json?: boolean;
}

const stdoutIo: SessionsIo = { write: (text) => process.stdout.write(text) };

/** myna's parseSessionsArgs: the range, the filters and the limit. */
export function parseSessionsOptions(options: SessionsOptions): SessionsQuery {
  return {
    days: parseDays(options),
    ...(typeof options.model === "string" && options.model.length > 0
      ? { model: options.model }
      : {}),
    ...(typeof options.folder === "string" && options.folder.length > 0
      ? { folder: options.folder }
      : {}),
    limit: parseLimit(options.limit),
    json: options.json === true || options.format === "json",
  };
}

function parseDays(options: SessionsOptions): number {
  const raw = options.stats === true && options.days === undefined ? "7" : options.days;
  if (raw === undefined) {
    return -1;
  }
  if (raw === true) {
    return 7;
  }
  const value = raw.trim().toLowerCase();
  if (value === "today" || value === "1d") {
    return 1;
  }
  if (value === "all" || value === "0") {
    return 0;
  }
  const trimmed = value.endsWith("d") ? value.slice(0, -1) : value;
  const days = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(days) || days < 0) {
    throw {
      code: "INVALID_OPTIONS",
      message: `--days takes a number of days, today or all\n${SESSIONS_USAGE}`,
    };
  }
  return days;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return 20;
  }
  const limit = /^\d+$/u.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1) {
    throw { code: "INVALID_OPTIONS", message: `--limit takes a number\n${SESSIONS_USAGE}` };
  }
  return limit;
}

/** myna reads a bare `stats` operand as --days 7 and refuses any other word. */
function withStatsArgument(options: SessionsOptions, stats: string | undefined): SessionsOptions {
  if (stats === undefined) {
    return options;
  }
  if (stats !== "stats") {
    throw {
      code: "INVALID_OPTIONS",
      message: `unknown argument ${JSON.stringify(stats)}\n${SESSIONS_USAGE}`,
    };
  }
  return { ...options, stats: true };
}

export async function runSessionsCommand(
  options: SessionsOptions,
  connect: ConnectSessions = connectToDaemon,
  io: SessionsIo = stdoutIo,
): Promise<void> {
  const query = parseSessionsOptions(options);
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.externalSessions !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to use sessions." };
    }
    const all = await collectSessions(client, query.days >= 0 ? query.days : undefined);
    if (query.days >= 0) {
      printStats(all.sessions, query, io);
      return;
    }
    printList(all.sessions, all.names, query, io);
  } finally {
    client.close();
  }
}

interface CollectedSessions {
  sessions: ExternalSession[];
  names: Map<string, string>;
}

/**
 * The list RPC answers one agent at a time; reading each agent is the whole
 * list. There is no all-agents list RPC to call instead.
 */
async function collectSessions(
  client: SessionsClient,
  activityDays?: number,
): Promise<CollectedSessions> {
  const options = activityDays === undefined ? undefined : { activityDays };
  const first = await client.listExternalSessions(undefined, options);
  if (first.error !== null) {
    throw { code: "SESSIONS_FAILED", message: first.error };
  }
  const names = new Map(first.agents.map((entry) => [entry.agent, entry.name]));
  const byAgent = new Map<string, ExternalSession[]>();
  if (first.agent.length > 0) {
    byAgent.set(first.agent, first.sessions);
  }
  for (const entry of first.agents) {
    if (byAgent.has(entry.agent)) {
      continue;
    }
    const page = await client.listExternalSessions(entry.agent, options);
    if (page.error !== null) {
      throw { code: "SESSIONS_FAILED", message: page.error };
    }
    byAgent.set(entry.agent, page.sessions);
  }
  const sessions = [...byAgent.values()].flat().sort((a, b) => b.last.localeCompare(a.last));
  return { sessions, names };
}

function printList(
  all: readonly ExternalSession[],
  names: Map<string, string>,
  query: SessionsQuery,
  io: SessionsIo,
): void {
  const now = (io.now ?? (() => new Date()))();
  const model = resolve("model", query.model ?? "", collectModels(all), io);
  const folder = resolve("folder", query.folder ?? "", collectFolders(all), io);
  const matching = all.filter(
    (session) =>
      (folder === "" || session.cwd === folder) &&
      (model === "" || session.models.some((entry) => entry.model === model)),
  );
  const more = Math.max(0, matching.length - query.limit);
  const shown = matching.slice(0, query.limit);

  if (query.json) {
    io.write(
      `${JSON.stringify(
        shown.map((session) => ({ ...session, path: tildePath(session.path, io) })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (shown.length === 0) {
    printEmpty(all.length, io);
    return;
  }

  const rows = shown.map((session) => ({
    when: agoAt(new Date(session.last), now),
    who: names.get(session.agent) ?? sessionAgentName(session.agent),
    where: path.basename(session.cwd),
    title: truncate(oneLine(session.title), 48),
    tokens: formatTokens(spentOf(session)),
    cost: sessionCost(session),
  }));
  const widths = {
    when: Math.max(...rows.map((row) => row.when.length)),
    who: Math.max(...rows.map((row) => row.who.length)),
    where: Math.max(...rows.map((row) => row.where.length)),
    tokens: Math.max(...rows.map((row) => row.tokens.length)),
  };
  for (const row of rows) {
    io.write(
      ` ${pad(row.when, widths.when)} ${pad(row.who, widths.who)} ${pad(row.where, widths.where)} ` +
        `${pad(row.title, 48)} ${pad(row.tokens, widths.tokens)} ${row.cost}\n`,
    );
  }
  let head = `latest ${shown.length}`;
  if (more > 0) {
    head += ` · ${more} more with --limit`;
  }
  io.write(`  ${head} · --days 7 for what they spent by day · --json for the resume commands\n`);
}

function printEmpty(total: number, io: SessionsIo): void {
  if (total > 0) {
    io.write("no session matches\n");
    return;
  }
  io.write(
    "no sessions yet · Claude Code's, Codex's, OpenCode's, Pi's and Antigravity's sessions on this computer show up here\n",
  );
  const roots = Object.values(sessionRoots(io.homeDir, io.env)).map((root) => tildePath(root, io));
  io.write(`  ${roots.join(" · ")}\n`);
}

interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_TOKENS: SessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function tokensOf(session: ExternalSession): SessionTokens {
  return {
    input: session.tokens.input,
    output: session.tokens.output,
    cacheRead: session.tokens.cacheRead,
    cacheWrite: session.tokens.cacheWrite,
  };
}

function addTokens(left: SessionTokens, right: SessionTokens): SessionTokens {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  };
}

/** myna's Tokens.Spent: the prompt and the reply, not the cache. */
function spent(tokens: SessionTokens): number {
  return tokens.input + tokens.output;
}

interface Share {
  name: string;
  tokens: SessionTokens;
  cost: number;
  priced: boolean;
}

interface DayTotal {
  date: string;
  tokens: SessionTokens;
  cost: number;
  /** null when no session that day carried line timestamps. */
  activeSeconds: number | null;
}

interface RangeStats {
  from: string;
  to: string;
  tokens: SessionTokens;
  cost: number;
  unpriced: string[];
  daysUsed: number;
  /** null when no session in range carried line timestamps. */
  activeSeconds: number | null;
  days: DayTotal[];
  models: Share[];
  folders: Share[];
}

interface SessionContribution {
  tokens: SessionTokens;
  cost: number;
  priced: boolean;
  models: ExternalSession["models"];
}

function printStats(all: readonly ExternalSession[], query: SessionsQuery, io: SessionsIo): void {
  const now = (io.now ?? (() => new Date()))();
  const since = sinceOf(query.days, now);
  const inRange = all.filter((session) => {
    const last = new Date(session.last);
    return since === null || last >= since;
  });
  const model = resolve("model", query.model ?? "", collectModels(inRange), io);
  const folder = resolve("folder", query.folder ?? "", collectFolders(inRange), io);
  const stats = sumRange(inRange, model, folder, query.days, now);

  if (query.json) {
    io.write(`${JSON.stringify(jsonStats(stats, model, folder), null, 2)}\n`);
    return;
  }
  if (spent(stats.tokens) === 0 && stats.tokens.cacheRead === 0) {
    io.write(`nothing ${rangeTitle(query.days, model, folder, io)}\n`);
    return;
  }

  const active = stats.activeSeconds === null ? "—" : formatDuration(stats.activeSeconds);
  io.write(
    `${formatTokens(spent(stats.tokens))} tokens ${rangeTitle(query.days, model, folder, io)} · ` +
      `${rollupCost(stats)} · cache read ${formatTokens(stats.tokens.cacheRead)}` +
      `${hitRate(stats.tokens)} · active ${active} on ${plural(stats.daysUsed, "day")}\n`,
  );
  io.write(
    `  in ${formatTokens(stats.tokens.input)}  out ${formatTokens(stats.tokens.output)}  ` +
      `cache write ${formatTokens(stats.tokens.cacheWrite)}  ${stats.from} – ${stats.to}\n`,
  );
  if (stats.unpriced.length > 0) {
    io.write(`  not priced: ${stats.unpriced.join(", ")}\n`);
  }
  printDays(stats, io);
  if (model === "") {
    printShares("models", stats.models, (name) => name, io);
  }
  if (folder === "") {
    printShares(
      "folders",
      stats.folders,
      (name) => (name === "" ? "(no folder)" : tildePath(name, io)),
      io,
    );
  }
}

function sinceOf(days: number, now: Date): Date | null {
  if (days <= 0) {
    return null;
  }
  const since = startOfDay(now);
  since.setDate(since.getDate() - (days - 1));
  return since;
}

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function dayKey(date: Date): string {
  const padNumber = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

function contributionOf(session: ExternalSession, model: string): SessionContribution | null {
  if (model === "") {
    return {
      tokens: tokensOf(session),
      cost: session.cost,
      priced: session.priced,
      models: session.models,
    };
  }
  const models = session.models.filter((entry) => entry.model === model);
  if (models.length === 0) {
    return null;
  }
  return {
    tokens: models.reduce<SessionTokens>((sum, entry) => addTokens(sum, entry.tokens), ZERO_TOKENS),
    cost: models.reduce((sum, entry) => sum + entry.cost, 0),
    priced: models.every((entry) => entry.priced),
    models,
  };
}

/**
 * Sums the range. Neolix keeps a session's totals, not a per-message log, so
 * a session counts on the day it was last written (myna splits a session
 * across the days its messages were said on).
 */
function sumRange(
  sessions: readonly ExternalSession[],
  model: string,
  folder: string,
  days: number,
  now: Date,
): RangeStats {
  const perDay = new Map<string, DayTotal>();
  const perModel = new Map<string, Share>();
  const perFolder = new Map<string, Share>();
  const unpriced = new Set<string>();
  const since = sinceOf(days, now);
  const fromKey = since === null ? null : dayKey(since);
  let tokens = ZERO_TOKENS;
  let cost = 0;
  for (const session of sessions) {
    if (folder !== "" && session.cwd !== folder) {
      continue;
    }
    const contribution = contributionOf(session, model);
    if (contribution === null) {
      continue;
    }
    tokens = addTokens(tokens, contribution.tokens);
    cost += contribution.cost;
    addShare(perFolder, session.cwd, contribution);
    for (const entry of contribution.models) {
      if (model === "") {
        addShare(perModel, entry.model, entry);
      }
      if (!entry.priced) {
        unpriced.add(entry.model);
      }
    }
    addDay(perDay, session, contribution, model, fromKey);
  }
  const active = [...perDay.values()]
    .map((day) => day.activeSeconds)
    .filter((seconds): seconds is number => seconds !== null);
  const today = startOfDay(now);
  const from = rangeStart(days, perDay, today);
  return {
    from: dayKey(from),
    to: dayKey(today),
    tokens,
    cost,
    unpriced: [...unpriced].sort((a, b) => a.localeCompare(b)),
    daysUsed: [...perDay.values()].filter(
      (day) => spent(day.tokens) > 0 || day.tokens.cacheRead > 0,
    ).length,
    activeSeconds: active.length === 0 ? null : active.reduce((sum, seconds) => sum + seconds, 0),
    days: dayRows(days, from, today, perDay),
    models: sortedShares(perModel),
    folders: sortedShares(perFolder),
  };
}

/**
 * Puts a session's work on the days its transcript lines fell on, when the
 * agent's spans carry timestamps; otherwise on the day it was last written.
 * The host also reports each day's tokens per model, so a model filter uses
 * that model's own tokens, as myna does, rather than a share of the day.
 * Cost stays a share: Neolix keeps a model's total, not a price per line, so
 * each day takes the model's total in proportion to its tokens that day.
 */
function addDay(
  perDay: Map<string, DayTotal>,
  session: ExternalSession,
  contribution: SessionContribution,
  model: string,
  fromKey: string | null,
): void {
  const activity = session.activity;
  if (activity === undefined || activity.length === 0) {
    const day = dayFor(perDay, dayKey(new Date(session.last)));
    day.tokens = addTokens(day.tokens, contribution.tokens);
    day.cost += contribution.cost;
    return;
  }
  const allSpent = spent(tokensOf(session));
  const modelSpent = spent(contribution.tokens);
  const fallbackShare = allSpent > 0 ? modelSpent / allSpent : 0;
  const totals = new Map(session.models.map((entry) => [entry.model, entry]));
  for (const entry of activity) {
    if (fromKey !== null && entry.date < fromKey) {
      continue;
    }
    const day = dayFor(perDay, entry.date);
    if (entry.models === undefined) {
      // A host older than per-day model splits.
      const share = allSpent > 0 ? spent(entry.tokens) / allSpent : 0;
      day.tokens = addTokens(
        day.tokens,
        model === "" ? entry.tokens : scaleTokens(entry.tokens, fallbackShare),
      );
      day.cost += contribution.cost * share;
    } else if (model === "") {
      day.tokens = addTokens(day.tokens, entry.tokens);
      // Lines the transcript didn't name a model for carry no model total;
      // they take the session's share, as before.
      day.cost +=
        entry.models.length === 0
          ? contribution.cost * (allSpent > 0 ? spent(entry.tokens) / allSpent : 0)
          : costOfDay(entry.models, totals);
    } else {
      const onDay = entry.models.find((share) => share.model === model);
      const total = totals.get(model);
      if (onDay !== undefined && total !== undefined) {
        day.tokens = addTokens(day.tokens, onDay.tokens);
        day.cost += shareOfCost(total, onDay.tokens);
      }
    }
    day.activeSeconds = (day.activeSeconds ?? 0) + entry.activeSeconds;
  }
}

/** A day's cost, as each model's total spread over its tokens that day. */
function costOfDay(
  models: readonly { model: string; tokens: SessionTokens }[],
  totals: ReadonlyMap<string, ExternalSession["models"][number]>,
): number {
  let cost = 0;
  for (const share of models) {
    const total = totals.get(share.model);
    if (total !== undefined) {
      cost += shareOfCost(total, share.tokens);
    }
  }
  return cost;
}

function shareOfCost(total: ExternalSession["models"][number], onDay: SessionTokens): number {
  const all = spent(total.tokens);
  return all > 0 ? total.cost * (spent(onDay) / all) : 0;
}

function dayFor(perDay: Map<string, DayTotal>, date: string): DayTotal {
  const found = perDay.get(date);
  if (found !== undefined) {
    return found;
  }
  const day: DayTotal = { date, tokens: ZERO_TOKENS, cost: 0, activeSeconds: null };
  perDay.set(date, day);
  return day;
}

function scaleTokens(tokens: SessionTokens, factor: number): SessionTokens {
  return {
    input: Math.round(tokens.input * factor),
    output: Math.round(tokens.output * factor),
    cacheRead: Math.round(tokens.cacheRead * factor),
    cacheWrite: Math.round(tokens.cacheWrite * factor),
  };
}

interface ShareInput {
  tokens: SessionTokens;
  cost: number;
  priced: boolean;
}

function addShare(shares: Map<string, Share>, name: string, input: ShareInput): void {
  const share = shares.get(name) ?? { name, tokens: ZERO_TOKENS, cost: 0, priced: true };
  share.tokens = addTokens(share.tokens, input.tokens);
  share.cost += input.cost;
  share.priced = share.priced && input.priced;
  shares.set(name, share);
}

function sortedShares(shares: Map<string, Share>): Share[] {
  return [...shares.values()].sort((a, b) => spent(b.tokens) - spent(a.tokens));
}

function rangeStart(days: number, perDay: Map<string, DayTotal>, today: Date): Date {
  if (days > 0) {
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    return start;
  }
  const first = [...perDay.keys()].sort()[0];
  return first === undefined ? today : parseDayKey(first);
}

function dayRows(days: number, from: Date, to: Date, perDay: Map<string, DayTotal>): DayTotal[] {
  // A short range shows every date; a long one only those with anything.
  if (days <= 0 || days > 31) {
    return [...perDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  const rows: DayTotal[] = [];
  let date = new Date(from);
  while (date <= to) {
    const key = dayKey(date);
    rows.push(perDay.get(key) ?? { date: key, tokens: ZERO_TOKENS, cost: 0, activeSeconds: null });
    date = new Date(date);
    date.setDate(date.getDate() + 1);
  }
  return rows;
}

function printDays(stats: RangeStats, io: SessionsIo): void {
  const rows = stats.days;
  if (rows.length === 0) {
    return;
  }
  const top = Math.max(...rows.map((row) => spent(row.tokens)));
  io.write("\n  date          tokens   cost      cache read  active\n");
  for (const row of rows) {
    const label = parseDayKey(row.date)
      .toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      .replace(",", "");
    const costText = row.cost > 0 ? pad(formatCost(row.cost), 9) : pad("—", 9);
    io.write(
      `  ${pad(label, 13)} ${pad(formatTokens(spent(row.tokens)), 8)} ${costText} ` +
        `${pad(formatTokens(row.tokens.cacheRead), 11)} ` +
        `${pad(formatDuration(row.activeSeconds), 8)} ${bar(spent(row.tokens), top, 24)}\n`,
    );
  }
}

function parseDayKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function printShares(
  head: string,
  shares: readonly Share[],
  nameOf: (name: string) => string,
  io: SessionsIo,
): void {
  if (shares.length === 0) {
    return;
  }
  const shown = shares.slice(0, 8);
  let title = head;
  if (shares.length > shown.length) {
    title += ` · top ${shown.length} of ${shares.length}`;
  }
  io.write(`\n  ${title}\n`);
  const width = Math.max(...shown.map((share) => nameOf(share.name).length));
  const total = shares.reduce((sum, share) => sum + spent(share.tokens), 0);
  for (const share of shown) {
    const percent = Math.round((100 * spent(share.tokens)) / Math.max(1, total));
    io.write(
      ` ${pad(nameOf(share.name), width)} ${String(percent).padStart(3)}% ` +
        `${pad(formatTokens(spent(share.tokens)), 7)} ${shareCost(share)}\n`,
    );
  }
}

function jsonStats(stats: RangeStats, model: string, folder: string): Record<string, unknown> {
  return {
    from: stats.from,
    to: stats.to,
    ...(model === "" ? {} : { model }),
    ...(folder === "" ? {} : { folder }),
    ...jsonTokens(stats.tokens),
    cost: stats.cost,
    unpriced: stats.unpriced,
    days_used: stats.daysUsed,
    active: stats.activeSeconds,
    days: stats.days.map((day) => ({
      date: day.date,
      ...jsonTokens(day.tokens),
      cost: day.cost,
      active: day.activeSeconds,
    })),
    models: stats.models.map((share) => ({
      name: share.name,
      ...jsonTokens(share.tokens),
      cost: share.cost,
    })),
    folders: stats.folders.map((share) => ({
      name: share.name,
      ...jsonTokens(share.tokens),
      cost: share.cost,
    })),
  };
}

function jsonTokens(tokens: SessionTokens): Record<string, number> {
  return {
    input: tokens.input,
    output: tokens.output,
    cache_read: tokens.cacheRead,
    cache_write: tokens.cacheWrite,
  };
}

/** myna's resolve: the same, then the same but for case, then the one that contains it. */
export function resolve(
  kind: string,
  typed: string,
  have: readonly string[],
  io: SessionsIo = stdoutIo,
): string {
  if (typed === "") {
    return "";
  }
  const expanded =
    kind === "folder" && typed.startsWith("~")
      ? path.join(io.homeDir ?? homedir(), typed.slice(1))
      : typed;
  const wanted =
    kind === "folder" && (expanded.includes(path.sep) || expanded === ".")
      ? path.resolve(expanded)
      : expanded;
  if (have.includes(wanted)) {
    return wanted;
  }
  const matchers: ((entry: string) => boolean)[] = [
    (entry) => entry.toLowerCase() === wanted.toLowerCase(),
    (entry) => path.basename(entry).toLowerCase() === wanted.toLowerCase(),
    (entry) => entry.toLowerCase().includes(wanted.toLowerCase()),
  ];
  for (const matches of matchers) {
    const found = have.filter((entry) => matches(entry)).sort();
    if (found.length === 1) {
      return found[0] ?? "";
    }
    if (found.length > 1) {
      throw {
        code: "AMBIGUOUS",
        message: `${JSON.stringify(typed)} is more than one ${kind}: ${found.join(", ")}`,
      };
    }
  }
  if (have.length === 0) {
    throw { code: "NOT_FOUND", message: `no ${kind} ${JSON.stringify(typed)}: nothing here` };
  }
  throw {
    code: "NOT_FOUND",
    message: `no ${kind} ${JSON.stringify(typed)}; there are: ${have.join(", ")}`,
  };
}

function collectModels(sessions: readonly ExternalSession[]): string[] {
  const models = new Set<string>();
  for (const session of sessions) {
    for (const entry of session.models) {
      models.add(entry.model);
    }
  }
  return [...models];
}

function collectFolders(sessions: readonly ExternalSession[]): string[] {
  const folders = new Set<string>();
  for (const session of sessions) {
    if (session.cwd.length > 0) {
      folders.add(session.cwd);
    }
  }
  return [...folders];
}

export interface RelocateOptions extends CommandOptions {
  from?: string;
  to?: string;
  confirm?: string;
}

/** myna's `sessions relocate-claude`: preview, then the token runs the move. */
export async function runRelocateClaudeCommand(
  options: RelocateOptions,
  connect: ConnectSessions = connectToDaemon,
  io: SessionsIo = stdoutIo,
): Promise<void> {
  const from = absolutePath("from", options.from);
  const to = absolutePath("to", options.to);
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.externalSessions !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to move Claude Code projects." };
    }
    const result = await client.relocateClaudeProject({
      from,
      to,
      ...(options.confirm === undefined ? {} : { token: options.confirm }),
    });
    if (result.error !== null) {
      throw { code: "RELOCATE_FAILED", message: result.error };
    }
    io.write(
      `${JSON.stringify(
        {
          from: result.preview?.from ?? from,
          to: result.preview?.to ?? to,
          ...(result.preview === null
            ? {}
            : { sessions: result.preview.sessions, bytes: result.preview.bytes }),
          ...(result.token === null ? {} : { token: result.token }),
          ...(result.backup === null ? {} : { backup: result.backup }),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    client.close();
  }
}

function absolutePath(kind: "from" | "to", value: string | undefined): string {
  if (value === undefined || value.length === 0 || !path.isAbsolute(value)) {
    throw {
      code: "INVALID_OPTIONS",
      message: `--${kind} takes an absolute path\n${RELOCATE_USAGE}`,
    };
  }
  return value;
}

export async function runSessionReadCommand(
  change: string | undefined,
  agents: readonly string[],
  io: SessionsIo = stdoutIo,
): Promise<void> {
  const neolixHome = resolveNeolixHome({
    NEOLIX_HOME: io.neolixHome ?? io.env?.NEOLIX_HOME ?? process.env.NEOLIX_HOME,
  });
  const found = await foundSessionAgents(io.homeDir, io.env);
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    const current = sessionReadsOf(store.get());
    if (change === undefined) {
      printReads(current, found, io);
      return;
    }
    const next = applyReadsChange(current, change, agents, found);
    await store.write({ ...store.get(), codexSessionReads: next });
    printReads(next, found, io);
  } finally {
    store.dispose();
  }
}

/** myna's sessionReadsTo: "off all" turns off the agents named before too. */
function applyReadsChange(
  current: SessionReads,
  change: string,
  agents: readonly string[],
  found: readonly string[],
): SessionReads {
  if ((change !== "on" && change !== "off") || agents.length === 0) {
    throw { code: "INVALID_OPTIONS", message: SESSIONS_READ_USAGE };
  }
  const on = change === "on";
  let all: boolean | undefined;
  const named: Record<string, boolean> = {};
  const known = new Set([...knownSessionAgents(), ...found, ...Object.keys(current.agents)]);
  for (const agent of agents) {
    if (agent === "all") {
      all = on;
      for (const entry of found) {
        named[entry] = on;
      }
      continue;
    }
    if (agent.startsWith("-")) {
      throw { code: "INVALID_OPTIONS", message: SESSIONS_READ_USAGE };
    }
    if (!known.has(agent)) {
      throw {
        code: "UNKNOWN_AGENT",
        message: `unknown agent ${JSON.stringify(agent)} (neox sessions read lists them)\n${SESSIONS_READ_USAGE}`,
      };
    }
    named[agent] = on;
  }
  return setSessionReads(current, all, named);
}

function printReads(reads: SessionReads, found: readonly string[], io: SessionsIo): void {
  const agents = [...new Set([...found, ...Object.keys(reads.agents)])].sort();
  if (io.json === true) {
    io.write(
      `${JSON.stringify(
        {
          asked: reads.asked,
          all: reads.all,
          agents: Object.fromEntries(
            agents.map((agent) => [agent, readsSessions(reads, agent)] as const),
          ),
          found,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!reads.asked) {
    io.write("Not asked yet: no agent's sessions are read.\n");
  } else if (reads.all) {
    io.write("Agents found later: read\n");
  } else {
    io.write("Agents found later: not read\n");
  }
  for (const agent of agents) {
    const on = readsSessions(reads, agent) ? "on" : "off";
    io.write(`  ${on.padEnd(3)}  ${sessionAgentName(agent)} (${agent})\n`);
  }
}

export function createSessionsCommand(): Command {
  const command = new Command("sessions")
    .description(
      "The latest Claude Code, Codex, Pi, OpenCode and Antigravity sessions, and what they spent",
    )
    .usage("[--days N|today|all] [--model <model>] [--folder <folder>] [--limit N] [--json]")
    .argument("[stats]", "the same as --days 7")
    .option("-d, --days [days]", "what they spent day by day, over N days (default 7)")
    .option("-m, --model <model>", "only this model")
    .option("-f, --folder <folder>", "only this folder")
    .option("-n, --limit <n>", "how many sessions to list (default 20)")
    .action(
      withGlobalOptions((stats: string | undefined, options: SessionsOptions) =>
        runSessionsCommand(withStatsArgument(options, stats)),
      ),
    );

  const relocate = new Command("relocate-claude")
    .description("Preview or move a Claude Code project's sessions to another folder")
    .requiredOption("--from <path>", "the folder they are in, as Claude Code wrote it")
    .requiredOption("--to <path>", "the folder to move them to")
    .option("--confirm <token>", "the preview token, to run the move")
    .action(withGlobalOptions((options: RelocateOptions) => runRelocateClaudeCommand(options)));

  const read = new Command("read")
    .description("Which agents' session history Neox may read, or change it")
    .usage("[on|off all|<agent>...]")
    .argument("[change]", "on or off")
    .argument("[agents...]", "all, or the agents to change");
  addLocalDaemonOptions(read);
  addJsonOption(read);
  read.action(
    withGlobalOptions(
      async (change: string | undefined, agents: string[], options: CommandOptions) => {
        const target = options.daemonTarget;
        if (target.kind !== "instance") {
          throw {
            code: "LOCAL_OPERATION",
            message: "This is a local operation; use --home. --host is not supported.",
          };
        }
        await runSessionReadCommand(change, agents, {
          write: (text) => process.stdout.write(text),
          neolixHome: target.home,
          json: options.json === true || options.format === "json",
        });
      },
    ),
  );
  command.addCommand(read);
  command.addCommand(relocate);
  return command;
}

/* Formatting, as myna's sessions_cli.go and usage_cli.go write it. */

export function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1e9).toFixed(2)}B`;
  if (count >= 10_000_000) return `${Math.round(count / 1e6)}M`;
  if (count >= 1_000_000) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 100_000) return `${Math.round(count / 1e3)}K`;
  if (count >= 1_000) return `${(count / 1e3).toFixed(1)}K`;
  return String(count);
}

export function formatCost(amount: number): string {
  if (amount >= 100) return `$${amount.toFixed(0)}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

function sessionCost(session: ExternalSession): string {
  if (session.cost === 0) {
    if (spentOf(session) === 0) {
      return "—";
    }
    return session.priced ? `≈${formatCost(0)}` : "no price";
  }
  return `≈${formatCost(session.cost)}${session.priced ? "" : "+"}`;
}

function shareCost(share: Share): string {
  if (share.cost === 0) {
    return share.priced ? `≈${formatCost(0)}` : "no price";
  }
  return `≈${formatCost(share.cost)}${share.priced ? "" : "+"}`;
}

function rollupCost(stats: RangeStats): string {
  if (stats.cost === 0) {
    return "no price";
  }
  return `≈${formatCost(stats.cost)}${stats.unpriced.length > 0 ? "+" : ""}`;
}

function spentOf(session: ExternalSession): number {
  return spent(tokensOf(session));
}

function rangeTitle(days: number, model: string, folder: string, io: SessionsIo): string {
  let title = rangeName(days);
  if (model !== "") {
    title += ` · ${model}`;
  }
  if (folder !== "") {
    title += ` · ${tildePath(folder, io)}`;
  }
  return title;
}

/** myna's sessions.Duration: 3h 12m, 40m, <1m; — when nothing was kept. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || seconds < 0) {
    return "—";
  }
  if (seconds === 0) {
    return "0";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) {
    return "<1m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** myna's hitRate: how much of the prompt came from the cache. */
function hitRate(tokens: SessionTokens): string {
  const prompts = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (tokens.cacheRead > 0 && prompts > 0) {
    return ` (${Math.round((100 * tokens.cacheRead) / prompts)}% hit)`;
  }
  return "";
}

export function rangeName(days: number): string {
  if (days === 0) return "all time";
  if (days === 1) return "today";
  return `last ${days} days`;
}

function plural(count: number, unit: string): string {
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

export function agoAt(when: Date, now: Date): string {
  const elapsed = now.getTime() - when.getTime();
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 48 * 3_600_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 60 * 24 * 3_600_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return dayKey(when);
}

function oneLine(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(" ");
}

export function truncate(text: string, length: number): string {
  const characters = [...text];
  if (characters.length > length) {
    return `${characters.slice(0, length - 1).join("")}…`;
  }
  return text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function bar(value: number, top: number, width: number): string {
  if (value <= 0 || top <= 0) {
    return "";
  }
  return "█".repeat(Math.min(width, Math.max(1, Math.round((value * width) / top))));
}

export function tildePath(target: string, io: SessionsIo = stdoutIo): string {
  const home = io.homeDir ?? homedir();
  return home.length > 0 && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}
