import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { Logger } from "pino";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { UsageReportEntry } from "@neolix/protocol/messages";
import { readDaemonInstance, resolveNeolixHome } from "@neolix/server/daemon-control";
import { editPersistedConfig, readPersistedConfig } from "@neolix/server/configuration";
import {
  GatewayConfigStore,
  type GatewayAccount,
  type GatewayConfig,
} from "@neolix/server/gateway-config";
import { connectToDaemon, type ConnectOptions } from "../../utils/client.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  addJsonOption,
  addLocalDaemonOptions,
  withGlobalOptions,
} from "../../utils/command-options.js";
import {
  withOutput,
  type CommandOptions,
  type CommandResult,
  type OutputSchema,
} from "../../output/index.js";
import { usageSchema } from "./presentation.js";
import { createUsageReportCommand } from "./report.js";

interface UsageOptions extends CommandOptions {
  agent?: string;
  refresh?: boolean;
}

type UsageSelection = { kind: "list" } | { kind: "inspect"; id: string };
interface UsageClient {
  getLastServerInfoMessage(): { features?: { usageSources?: boolean } } | null;
  listUsageReports: DaemonClient["listUsageReports"];
  close: DaemonClient["close"];
}
type ConnectUsage = (options: ConnectOptions) => Promise<UsageClient>;

export async function runUsageCommand(
  options: UsageOptions,
  selection: UsageSelection,
  connect: ConnectUsage = connectToDaemon,
): Promise<CommandResult<UsageReportEntry>> {
  const conflictingSelectors = selection.kind === "inspect" && options.agent !== undefined;
  if (conflictingSelectors) {
    throw {
      code: "INVALID_OPTIONS",
      message:
        "--agent cannot be combined with usage inspect. Use usage ls --agent <id> for agent account usage, or usage inspect <report-id> for an exact report.",
    };
  }
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.usageSources !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to use usage reports." };
    }
    if (selection.kind === "list") {
      const { reports } = await client.listUsageReports({
        agentId: options.agent,
        forceRefresh: options.refresh,
      });
      return { type: "list", data: reports, schema: usageSchema };
    }
    // Report-ID queries only select known accounts. Discover before selecting, including on cold hosts.
    const { reports } = await client.listUsageReports();
    let entry = reports.find((report) => report.id === selection.id);
    if (entry && options.refresh) {
      const refreshed = await client.listUsageReports({
        reportIds: [selection.id],
        forceRefresh: true,
      });
      entry = refreshed.reports.find((report) => report.id === selection.id);
    }
    if (!entry) {
      throw { code: "REPORT_NOT_FOUND", message: `Unknown usage report: ${selection.id}` };
    }
    return { type: "single", data: entry, schema: usageSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

/*
 * The rest of myna's `quota` CLI (internal/cli/quota_cli.go:17-25) under
 * `neolix usage`, where this CLI keeps what the daemon can read or this
 * computer's gateway.json holds. Spending a reset, the credits policy and
 * the app's notifications have no daemon side yet and are not offered here.
 */

const DEFAULT_LEAD_MINUTES = 30;
const LEAD_LEAST_MINUTES = 15;
const LEAD_MOST_MINUTES = 24 * 60;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
} as unknown as Logger;

async function withStore<T>(
  home: string | undefined,
  work: (store: GatewayConfigStore) => Promise<T>,
): Promise<T> {
  const neolixHome = resolveNeolixHome({
    NEOLIX_HOME: home ?? process.env.NEOLIX_HOME,
  } as NodeJS.ProcessEnv);
  const store = new GatewayConfigStore({ neolixHome, logger: silentLogger });
  await store.start();
  try {
    return await work(store);
  } finally {
    store.dispose();
  }
}

/** How long before a reset runs out it is spent; out of range reads the default. */
export function effectiveLead(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= LEAD_LEAST_MINUTES &&
    value <= LEAD_MOST_MINUTES
    ? value
    : DEFAULT_LEAD_MINUTES;
}

/** 30, 30m, 3h or 1h30m as whole minutes; NaN for anything else. */
function leadMinutesOf(text: string): number {
  const plain = /^\d+$/.exec(text);
  if (plain) {
    return Number(plain[0]);
  }
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text);
  if (parts === null || (parts[1] === undefined && parts[2] === undefined)) {
    return Number.NaN;
  }
  return Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
}

/** myna's duration arguments: 30m, 3h, 1h30m, or whole minutes; undefined is "default". */
export function parseLead(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (text === "default" || text === "0") {
    return undefined;
  }
  const minutes = leadMinutesOf(text);
  if (!Number.isInteger(minutes) || minutes < LEAD_LEAST_MINUTES || minutes > LEAD_MOST_MINUTES) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `Use ${LEAD_LEAST_MINUTES}m to ${LEAD_MOST_MINUTES / 60}h (like 30m or 3h), or "default".`,
    };
  }
  return minutes;
}

function withoutLead(config: GatewayConfig): GatewayConfig {
  const { codexResetLead: _codexResetLead, ...rest } = config;
  return rest;
}

export async function runResetLeadCommand(
  value: string | undefined,
  options: { home?: string },
): Promise<{ minutes: number }> {
  return withStore(options.home, async (store) => {
    const config = store.get();
    if (value === undefined) {
      return { minutes: effectiveLead(config.codexResetLead) };
    }
    const minutes = parseLead(value);
    const saved = await store.write(
      minutes === undefined ? withoutLead(config) : { ...config, codexResetLead: minutes },
    );
    return { minutes: effectiveLead(saved.codexResetLead) };
  });
}

type AutoResetMode = NonNullable<GatewayAccount["autoReset"]>;
interface AutoResetRow {
  provider: string;
  account: string;
  label: string;
  autoReset: AutoResetMode | null;
}
interface CodexAccountRef {
  provider: GatewayConfig["providers"][number];
  account: GatewayAccount;
}

function autoResetCases(mode: AutoResetMode | undefined): { week: boolean; expiring: boolean } {
  return {
    week: mode === "week" || mode === "auto",
    expiring: mode === "expiring" || mode === "auto",
  };
}

function autoResetModeOf(week: boolean, expiring: boolean): AutoResetMode | undefined {
  if (week && expiring) {
    return "auto";
  }
  if (week) {
    return "week";
  }
  return expiring ? "expiring" : undefined;
}

function withoutAutoReset(account: GatewayAccount): GatewayAccount {
  const { autoReset: _autoReset, ...rest } = account;
  return rest;
}

/** The accounts the GUI lists: only a ChatGPT sign-in of Neolix's own holds a Codex reset. */
function codexAccounts(config: GatewayConfig): CodexAccountRef[] {
  return config.providers.flatMap((provider) =>
    (provider.accounts ?? []).flatMap((account) =>
      account.codexAccountId === undefined ? [] : [{ provider, account }],
    ),
  );
}

function accountNames({ provider, account }: CodexAccountRef): string[] {
  return [
    account.id,
    account.label ?? "",
    account.codexAccountId ?? "",
    `${provider.id}/${account.id}`,
    `${provider.label ?? provider.id}/${account.label ?? account.id}`,
  ].filter((name) => name.length > 0);
}

function rowOf(ref: CodexAccountRef): AutoResetRow {
  return {
    provider: ref.provider.id,
    account: ref.account.id,
    label: ref.account.label ?? ref.account.id,
    autoReset: ref.account.autoReset ?? null,
  };
}

function autoResetSay(mode: AutoResetMode | null): string {
  switch (mode) {
    case "auto":
      return "spends a reset by itself when its week runs out, and before one expires";
    case "week":
      return "spends a reset by itself when its week runs out";
    case "expiring":
      return "spends a reset by itself before one expires";
    default:
      return "does not spend a reset by itself";
  }
}

export async function runAutoResetCommand(
  tokens: string[],
  options: { home?: string },
): Promise<{ changed: boolean; rows: AutoResetRow[] }> {
  let name: string | undefined;
  let when: "week" | "expiring" | undefined;
  let set = false;
  let on = false;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "on" || lower === "off") {
      set = true;
      on = lower === "on";
    } else if (lower === "week" || lower === "expiring") {
      when = lower;
    } else {
      if (name !== undefined) {
        throw {
          code: "INVALID_ARGUMENT",
          message: `One account at a time: ${name} or ${token}.`,
        };
      }
      name = token;
    }
  }
  if (when !== undefined && !set) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `Say on or off: neox usage auto-reset <account> ${when} on`,
    };
  }
  if (set && name === undefined) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "Name the account: neox usage auto-reset <account> week on",
    };
  }

  return withStore(options.home, async (store) => {
    const config = store.get();
    if (!set) {
      const rows = codexAccounts(config)
        .filter((ref) => (name === undefined ? ref.account.autoReset !== undefined : true))
        .filter((ref) => name === undefined || matchesAccount(ref, name))
        .map(rowOf);
      if (name !== undefined && rows.length === 0) {
        throw {
          code: "ACCOUNT_NOT_FOUND",
          message: `No Codex account named ${name}. Known: ${
            codexAccounts(config)
              .map((ref) => ref.account.label ?? ref.account.id)
              .join(", ") || "(none)"
          }`,
        };
      }
      return { changed: false, rows };
    }

    const wanted = name as string;
    const ref = codexAccounts(config).find((candidate) => matchesAccount(candidate, wanted));
    if (ref === undefined) {
      throw {
        code: "ACCOUNT_NOT_FOUND",
        message: `No Codex account named ${wanted}. Known: ${
          codexAccounts(config)
            .map((candidate) => candidate.account.label ?? candidate.account.id)
            .join(", ") || "(none)"
        }`,
      };
    }
    const cases = autoResetCases(ref.account.autoReset);
    const next = when === undefined ? { week: on, expiring: on } : { ...cases, [when]: on };
    const mode = autoResetModeOf(next.week, next.expiring);
    const updated =
      mode === undefined ? withoutAutoReset(ref.account) : { ...ref.account, autoReset: mode };
    const providerAt = config.providers.findIndex((provider) => provider.id === ref.provider.id);
    const provider = config.providers[providerAt]!;
    const accounts = provider.accounts ?? [];
    const accountAt = accounts.indexOf(ref.account);
    const saved = await store.write({
      ...config,
      providers: [
        ...config.providers.slice(0, providerAt),
        {
          ...provider,
          accounts: [...accounts.slice(0, accountAt), updated, ...accounts.slice(accountAt + 1)],
        },
        ...config.providers.slice(providerAt + 1),
      ],
    });
    const savedRef = codexAccounts(saved).find(
      (candidate) =>
        candidate.provider.id === ref.provider.id && candidate.account.id === ref.account.id,
    );
    return { changed: true, rows: savedRef ? [rowOf(savedRef)] : [] };
  });
}

type CreditsMode = "on" | "first" | "last" | "off";
const CREDITS_MODES: readonly CreditsMode[] = ["on", "first", "last", "off"];

interface CreditsRow {
  provider: string;
  account: string;
  label: string;
  creditsMode: CreditsMode;
}

export function creditsModeOf(account: GatewayAccount): CreditsMode {
  return account.creditsMode ?? "on";
}

function creditsSay(mode: CreditsMode): string {
  switch (mode) {
    case "first":
      return "spends its credits before moving to another account";
    case "last":
      return "spends its credits only after every other account, key and fallback";
    case "off":
      return "doesn't spend its credits: held when a window runs out";
    default:
      return "spends its credits when its windows run out, so a task goes on";
  }
}

function creditsRowOf(ref: CodexAccountRef): CreditsRow {
  return {
    provider: ref.provider.id,
    account: ref.account.id,
    label: ref.account.label ?? ref.account.id,
    creditsMode: creditsModeOf(ref.account),
  };
}

function withoutCreditsMode(account: GatewayAccount): GatewayAccount {
  const { creditsMode: _creditsMode, ...rest } = account;
  return rest;
}

/** myna's `quota credits [<account>] [on|first|last|off]`, from gateway.json. */
export async function runCreditsCommand(
  tokens: string[],
  options: { home?: string },
): Promise<{ changed: boolean; rows: CreditsRow[] }> {
  let name: string | undefined;
  let mode: CreditsMode | undefined;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if ((CREDITS_MODES as readonly string[]).includes(lower)) {
      mode = lower as CreditsMode;
    } else {
      if (name !== undefined) {
        throw {
          code: "INVALID_ARGUMENT",
          message: `One account at a time: ${name} or ${token}.`,
        };
      }
      name = token;
    }
  }
  if (mode !== undefined && name === undefined) {
    throw {
      code: "INVALID_ARGUMENT",
      message: "Name the account: neox usage credits <account> on|first|last|off",
    };
  }

  return withStore(options.home, async (store) => {
    const config = store.get();
    if (mode === undefined) {
      const rows = codexAccounts(config)
        .filter((ref) => (name === undefined ? creditsModeOf(ref.account) !== "on" : true))
        .filter((ref) => name === undefined || matchesAccount(ref, name))
        .map(creditsRowOf);
      if (name !== undefined && rows.length === 0) {
        throw {
          code: "ACCOUNT_NOT_FOUND",
          message: `No Codex account named ${name}. Known: ${
            codexAccounts(config)
              .map((ref) => ref.account.label ?? ref.account.id)
              .join(", ") || "(none)"
          }`,
        };
      }
      return { changed: false, rows };
    }

    const wanted = name as string;
    const ref = codexAccounts(config).find((candidate) => matchesAccount(candidate, wanted));
    if (ref === undefined) {
      throw {
        code: "ACCOUNT_NOT_FOUND",
        message: `No Codex account named ${wanted}. Known: ${
          codexAccounts(config)
            .map((candidate) => candidate.account.label ?? candidate.account.id)
            .join(", ") || "(none)"
        }`,
      };
    }
    const updated =
      mode === "on" ? withoutCreditsMode(ref.account) : { ...ref.account, creditsMode: mode };
    const providerAt = config.providers.findIndex((provider) => provider.id === ref.provider.id);
    const provider = config.providers[providerAt]!;
    const accounts = provider.accounts ?? [];
    const accountAt = accounts.indexOf(ref.account);
    const saved = await store.write({
      ...config,
      providers: [
        ...config.providers.slice(0, providerAt),
        {
          ...provider,
          accounts: [...accounts.slice(0, accountAt), updated, ...accounts.slice(accountAt + 1)],
        },
        ...config.providers.slice(providerAt + 1),
      ],
    });
    const savedRef = codexAccounts(saved).find(
      (candidate) =>
        candidate.provider.id === ref.provider.id && candidate.account.id === ref.account.id,
    );
    return { changed: true, rows: savedRef ? [creditsRowOf(savedRef)] : [] };
  });
}

interface AlertRow {
  usageAlertPercent: number;
  balanceAlert: number;
  /** Whether a running daemon took the change now. */
  applied?: boolean;
}

function alertPercent(text: string): number {
  const value = text.trim().toLowerCase();
  if (value === "off" || value === "0") {
    return 0;
  }
  const percent = Number(value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `A usage alert is at a percentage from 1 to 100, or off, not ${JSON.stringify(text)}`,
    };
  }
  return percent;
}

function alertBalance(text: string): number {
  const value = text.trim().toLowerCase();
  if (value === "off" || value === "0") {
    return 0;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `A balance alert is at an amount of 0 or more (0 for off), not ${JSON.stringify(text)}`,
    };
  }
  return amount;
}

function alertHome(home: string | undefined): string {
  return resolveNeolixHome({
    NEOLIX_HOME: home ?? process.env.NEOLIX_HOME,
  } as NodeJS.ProcessEnv);
}

/** myna's `quota alert [<percent>|off] [--balance <amount>|off]`, kept by the daemon. */
export async function runAlertCommand(
  percent: string | undefined,
  options: { home?: string; balance?: string },
  reload: (home: string) => Promise<boolean> = reloadDaemonConfig,
): Promise<AlertRow> {
  const home = alertHome(options.home);
  const config = readPersistedConfig(home, { defaultsIfMissing: true });
  if (percent === undefined && options.balance === undefined) {
    return {
      usageAlertPercent: config.usageAlertPercent ?? 0,
      balanceAlert: config.balanceAlert ?? 0,
    };
  }
  const rows: AlertRow = {
    usageAlertPercent: config.usageAlertPercent ?? 0,
    balanceAlert: config.balanceAlert ?? 0,
  };
  if (percent !== undefined) {
    rows.usageAlertPercent = alertPercent(percent);
    editPersistedConfig(home, "usageAlertPercent", { value: rows.usageAlertPercent });
  }
  if (options.balance !== undefined) {
    rows.balanceAlert = alertBalance(options.balance);
    editPersistedConfig(home, "balanceAlert", { value: rows.balanceAlert });
  }
  rows.applied = await reload(home);
  return rows;
}

/** A running daemon re-reads its config so every client sees the change now. */
async function reloadDaemonConfig(home: string): Promise<boolean> {
  const instance = await readDaemonInstance(home);
  if (instance?.listen === undefined) {
    return false;
  }
  let client: Awaited<ReturnType<typeof connectToDaemon>> | null = null;
  try {
    client = await connectToDaemon({
      target: { kind: "instance", home },
      timeout: 1_500,
    });
    await client.reloadDaemonConfig();
    return true;
  } catch {
    return false;
  } finally {
    await client?.close().catch(() => {});
  }
}

function matchesAccount(ref: CodexAccountRef, name: string): boolean {
  const wanted = name.trim().toLowerCase();
  return accountNames(ref).some((candidate) => candidate.toLowerCase() === wanted);
}

function matchesUsageSelector(
  report: UsageReportEntry,
  provider?: string,
  account?: string,
): boolean {
  const source = [report.sourceId, report.sourceLabel].map((value) => value.toLowerCase());
  const reportNames = [report.id, report.account.label ?? ""].map((value) => value.toLowerCase());
  return (
    (provider === undefined || source.includes(provider.toLowerCase())) &&
    (account === undefined || reportNames.includes(account.toLowerCase()))
  );
}

export async function runUsageRefreshCommand(
  options: UsageOptions,
  selection: { provider?: string; account?: string },
  connect: ConnectUsage = connectToDaemon,
): Promise<CommandResult<UsageReportEntry>> {
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.usageSources !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to use usage reports." };
    }
    const { reports } = await client.listUsageReports({ forceRefresh: true });
    const matched = reports.filter((report) =>
      matchesUsageSelector(report, selection.provider, selection.account),
    );
    if (
      (selection.provider !== undefined || selection.account !== undefined) &&
      matched.length === 0
    ) {
      throw {
        code: "REPORT_NOT_FOUND",
        message: `No usage report for ${[selection.provider, selection.account].filter(Boolean).join("/")}`,
      };
    }
    return { type: "list", data: matched, schema: usageSchema };
  } finally {
    await client.close().catch(() => {});
  }
}

type QuotaAccount = Awaited<
  ReturnType<DaemonClient["getGatewayQuota"]>
>["quota"]["accounts"][number];
interface QuotaClient extends UsageClient {
  getLastServerInfoMessage(): {
    features?: {
      usageSources?: boolean;
      gatewayQuotas?: boolean;
      gatewayQuotaHistory45?: boolean;
      gatewayQuotaReset?: boolean;
    };
  } | null;
  getGatewayQuota: DaemonClient["getGatewayQuota"];
  resetGatewayQuota: DaemonClient["resetGatewayQuota"];
}
type ConnectQuota = (options: ConnectOptions) => Promise<QuotaClient>;

function quotaMatches(account: QuotaAccount, names: string[]): boolean {
  if (names.length === 0) {
    return true;
  }
  return names.some((name) => {
    const wanted = name.trim().toLowerCase();
    const fields = [
      account.id,
      account.account,
      account.accountLabel,
      account.provider,
      account.providerLabel,
      `${account.provider}/${account.account}`,
      `${account.provider}/${account.accountLabel}`,
    ].map((value) => value.toLowerCase());
    if (fields.includes(wanted)) {
      return true;
    }
    const slash = wanted.indexOf("/");
    return (
      slash > 0 &&
      [account.provider, account.providerLabel].some(
        (value) => value.toLowerCase() === wanted.slice(0, slash),
      ) &&
      [account.account, account.accountLabel].some(
        (value) => value.toLowerCase() === wanted.slice(slash + 1),
      )
    );
  });
}

/** A plan card's missing key, in myna's words; any other reason as the host gave it. */
function quotaErrorText(account: QuotaAccount): string | null {
  if (account.error === undefined) {
    return null;
  }
  if (account.kind !== "plan") {
    return account.error;
  }
  if (/SecretId and SecretKey/i.test(account.error)) {
    return "This plan's usage needs the account's SecretId and SecretKey — give them in the provider's settings";
  }
  if (/AccessKey ID and Secret/i.test(account.error)) {
    return "This plan's usage needs the account's AccessKey ID and Secret — give them in the provider's settings";
  }
  return account.error;
}

function windowLine(window: QuotaAccount["windows"][number]): string {
  const used = window.usedPercent === null ? "-" : `${window.usedPercent}%`;
  const resets = window.resetsAt === null ? "-" : new Date(window.resetsAt).toISOString();
  const name = window.name ?? window.id;
  return `  ${name}: ${used} used, resets ${resets} (${window.history?.length ?? 0} readings)`;
}

const quotaHistorySchema: OutputSchema<QuotaAccount> = {
  // A plan card shares the synthetic "plan" account, so its own id keys it.
  idField: (account) => account.id,
  columns: [
    { header: "PROVIDER", field: (account) => account.providerLabel },
    { header: "ACCOUNT", field: (account) => account.accountLabel },
    { header: "WINDOWS", field: (account) => account.windows.length },
    { header: "READINGS", field: (account) => account.history.length },
  ],
  renderHuman: (result) => {
    const accounts = result.type === "list" ? result.data : [result.data];
    if (accounts.length === 0) {
      return "No readings kept yet";
    }
    return accounts
      .map((account) => {
        const error = quotaErrorText(account);
        return [
          `${account.providerLabel} · ${account.accountLabel}`,
          ...account.windows.map(windowLine),
          ...(error === null ? [] : [`  ${error}`]),
        ].join("\n");
      })
      .join("\n");
  },
};

export async function runUsageHistoryCommand(
  names: string[],
  options: CommandOptions,
  connect: ConnectQuota = connectToDaemon,
): Promise<CommandResult<QuotaAccount>> {
  const rawDays = options.days;
  // myna reads every day it keeps when none is asked for.
  let days: number | undefined = 45;
  if (rawDays !== undefined) {
    const asked = typeof rawDays === "string" ? Number(rawDays) : Number.NaN;
    // myna keeps 45 days and reads all of them when more are asked for.
    if (!Number.isFinite(asked) || asked <= 0) {
      throw {
        code: "INVALID_ARGUMENT",
        message: `--days takes a number of days, such as 1 or 7, not ${String(rawDays)}`,
      };
    }
    days = Math.min(Math.ceil(asked), 45);
  }
  const client = await connect({ target: options.daemonTarget });
  try {
    const features = client.getLastServerInfoMessage()?.features;
    if (features?.gatewayQuotas !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to read gateway allowances." };
    }
    if (days !== undefined && days > 30 && features.gatewayQuotaHistory45 !== true) {
      throw {
        code: "UNSUPPORTED_HOST",
        message: "Update the host to read more than 30 days of allowance readings.",
      };
    }
    // A history read is a user's ask: read the vendors now, as myna's quota does.
    const { quota } = await client.getGatewayQuota({ historyDays: days, read: true });
    return {
      type: "list",
      data: quota.accounts.filter((account) => quotaMatches(account, names)),
      schema: quotaHistorySchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function reportHasAllowance(report: UsageReportEntry): boolean {
  if (report.report.status !== "available") {
    return false;
  }
  return report.report.windows.every((window) => {
    const used = window.usedPct ?? null;
    const remaining = window.remainingPct ?? null;
    return (used === null || used < 100) && (used !== null || remaining === null || remaining > 0);
  });
}

function nextWaitMs(reports: UsageReportEntry[], now: number, deadline: number): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const report of reports) {
    if (report.report.status !== "available") {
      continue;
    }
    for (const window of report.report.windows) {
      const at =
        window.resetsAt === undefined || window.resetsAt === null
          ? Number.NaN
          : Date.parse(window.resetsAt);
      if (Number.isFinite(at) && at > now) {
        soonest = Math.min(soonest, at);
      }
    }
  }
  const afterReset = Number.isFinite(soonest) ? soonest - now + 5_000 : 60_000;
  return Math.max(1_000, Math.min(deadline - now, Math.max(60_000, Math.min(afterReset, 600_000))));
}

export async function runUsageWaitCommand(
  target: string,
  options: { timeoutMs?: number; quiet?: boolean; daemonTarget: ConnectOptions["target"] },
  connect: ConnectUsage = connectToDaemon,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ target: string; waitedMs: number }> {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const client = await connect({ target: options.daemonTarget });
  try {
    if (client.getLastServerInfoMessage()?.features?.usageSources !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to use usage reports." };
    }
    const slash = target.indexOf("/");
    const matches = (report: UsageReportEntry) =>
      slash > 0
        ? matchesUsageSelector(report, target.slice(0, slash), target.slice(slash + 1))
        : matchesUsageSelector(report, target, undefined) ||
          matchesUsageSelector(report, undefined, target);
    let known = false;
    for (;;) {
      const { reports } = await client.listUsageReports({ forceRefresh: true });
      const matched = reports.filter(matches);
      known ||= matched.length > 0;
      if (matched.some(reportHasAllowance)) {
        return { target, waitedMs: now() - startedAt };
      }
      if (!known) {
        throw {
          code: "UNKNOWN_TARGET",
          message: `No usage report for ${target}. Known: ${reports
            .map((report) => `${report.sourceId}/${report.account.label ?? report.id}`)
            .join(", ")}`,
        };
      }
      const at = now();
      if (at >= deadline) {
        throw {
          code: "TIMEOUT",
          message: `${target} still has no allowance after ${Math.round(timeoutMs / 60_000)} min.`,
        };
      }
      await sleep(nextWaitMs(matched, at, deadline));
    }
  } finally {
    await client.close().catch(() => {});
  }
}

/** myna's ResetOutcome.Text: an outcome in words. */
export function resetOutcomeText(code: string, windows: number): string {
  switch (code) {
    case "reset":
      return windows === 1 ? "1 window started again" : `${windows} windows started again`;
    case "nothing_to_reset":
      return "nothing to reset — no window has been used, and the reset is kept";
    case "no_credit":
      return "no reset left on the account";
    case "already_redeemed":
    case "already_used":
      return "that reset was already used";
    case "no_account":
      return "no such Codex account";
    case "card_out_of_range":
      return "the account holds fewer resets than that";
    case "no_sign_in":
      return "the account has no sign-in to spend a reset as";
    case "confirmation_required":
      return "spending a reset needs confirmation";
    default:
      return code;
  }
}

export interface UsageResetOptions {
  daemonTarget: ConnectOptions["target"];
  card?: string;
  yes?: boolean;
}

export interface UsageResetResult {
  spent: boolean;
  code: string;
  windows: number;
  text: string;
  accountLabel: string;
}

/**
 * myna's quota reset takes one account positionally: a second is refused,
 * naming both, and a flag it doesn't know is refused by name.
 */
export function resetAccountOf(args: readonly string[]): string | undefined {
  let account: string | undefined;
  for (const arg of args) {
    if (arg.startsWith("-")) {
      throw {
        code: "INVALID_ARGUMENT",
        message: `neox usage reset doesn't know ${arg}`,
      };
    }
    if (account !== undefined) {
      throw {
        code: "INVALID_ARGUMENT",
        message: `one account at a time: ${account} or ${arg}`,
      };
    }
    account = arg;
  }
  return account;
}

function cardAsked(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const card = Number(value);
  if (!Number.isInteger(card) || card < 1) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `--card takes which reset, 1 for the one that runs out first, not ${JSON.stringify(value)}`,
    };
  }
  return card;
}

/**
 * `neolix usage reset [account] [--card n] [--yes]` — myna's `quota reset`.
 * The daemon spends it; the CLI asks first unless --yes, and a reset cannot
 * be undone.
 */
export async function runUsageResetCommand(
  account: string | undefined,
  options: UsageResetOptions,
  connect: ConnectQuota = connectToDaemon,
  confirm?: () => Promise<boolean>,
): Promise<UsageResetResult> {
  const card = cardAsked(options.card);
  const client = await connect({ target: options.daemonTarget });
  try {
    const features = client.getLastServerInfoMessage()?.features;
    if (features?.gatewayQuotaReset !== true) {
      throw { code: "UNSUPPORTED_HOST", message: "Update the host to spend a Codex reset." };
    }
    if (options.yes !== true) {
      const allowed = confirm === undefined ? false : await confirm();
      if (!allowed) {
        throw { code: "NOT_CONFIRMED", message: "nothing spent" };
      }
    }
    const result = await client.resetGatewayQuota({
      ...(account === undefined ? {} : { account }),
      ...(card === undefined ? {} : { card }),
      confirm: true,
    });
    return {
      spent: result.spent,
      code: result.code,
      windows: result.windows,
      text: result.error ?? resetOutcomeText(result.code, result.windows),
      // The daemon names the account it resolved, which may be Codex's own.
      accountLabel:
        (result as { accountLabel?: string }).accountLabel ?? account ?? "the Codex account",
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

function parseTimeoutMs(value: string | undefined): number {
  if (value === undefined) {
    return 30 * 60_000;
  }
  const text = value.trim().toLowerCase();
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(text);
  if (!parts || (parts[1] === undefined && parts[2] === undefined && parts[3] === undefined)) {
    throw {
      code: "INVALID_ARGUMENT",
      message: `--timeout takes a duration such as 30m or 6h, not ${value}`,
    };
  }
  const ms =
    (Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0)) * 1_000;
  if (ms <= 0) {
    throw { code: "INVALID_ARGUMENT", message: "--timeout must be more than zero." };
  }
  return ms;
}

function addListOptions(command: Command): Command {
  return addJsonAndDaemonHostOptions(command)
    .option(
      "--agent <id>",
      "Show account quota associated with this agent (not agent token consumption)",
    )
    .option("--refresh", "Refresh usage instead of using the host cache");
}

export function createUsageCommand(): Command {
  const usage = addListOptions(new Command("usage").description("Show account usage reports"));
  const list = (options: CommandOptions, _command: Command) =>
    runUsageCommand(options, { kind: "list" });
  usage.action(withOutput(list));
  addListOptions(usage.command("ls").description("List account quotas and balances")).action(
    withOutput(list),
  );
  addJsonAndDaemonHostOptions(
    usage
      .command("inspect")
      .description("Show a complete account usage report")
      .argument("<report-id>", "Exact opaque Report ID")
      .option("--refresh", "Refresh the selected report instead of using the host cache"),
  ).action(
    withOutput((id: string, options: CommandOptions, _command: Command) =>
      runUsageCommand(options, { kind: "inspect", id }),
    ),
  );

  // myna's `myna usage [today|7d|30d|all] [--csv] …`.
  usage.addCommand(createUsageReportCommand());

  // myna's `quota auto-reset [<account>] [week|expiring] [on|off]`.
  const autoReset = addJsonOption(
    addLocalDaemonOptions(
      usage
        .command("auto-reset")
        .description("Whether a Codex account spends its rate-limit resets by itself")
        .argument("[args...]", "the account, then week or expiring, then on or off"),
    ),
  );
  autoReset.action(
    async (tokens: string[], _options: { home?: string; json?: boolean }, command: Command) => {
      // --home is also the parent's, and commander may take it there; the
      // globals have it whichever level it landed on.
      const options = command.optsWithGlobals() as { home?: string; json?: boolean };
      try {
        const { changed, rows } = await runAutoResetCommand(tokens, options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(rows)}\n`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("No Codex account spends a reset by itself\n");
          return;
        }
        for (const row of rows) {
          let prefix = "●";
          if (changed) {
            prefix = "✓";
          } else if (row.autoReset === null) {
            prefix = "○";
          }
          process.stdout.write(`${prefix} ${row.label}: ${autoResetSay(row.autoReset)}\n`);
        }
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

  // myna's `quota auto-reset lead [<minutes or hours>|default]`.
  addJsonOption(
    addLocalDaemonOptions(
      autoReset
        .command("lead")
        .description("Show or set how long before a reset runs out it is spent")
        .argument("[minutes|default]", `like 30m or 3h, whole minutes, or "default"`),
    ),
  ).action(
    async (
      value: string | undefined,
      _options: { home?: string; json?: boolean },
      command: Command,
    ) => {
      const options = command.optsWithGlobals() as { home?: string; json?: boolean };
      try {
        const row = await runResetLeadCommand(value, options);
        process.stdout.write(
          options.json ? `${JSON.stringify(row)}\n` : `Reset lead: ${row.minutes} min\n`,
        );
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

  // myna's `quota credits [<account>] [on|first|last|off]`.
  addJsonOption(
    addLocalDaemonOptions(
      usage
        .command("credits")
        .description("How a Codex account spends its credits once a window runs out")
        .argument("[args...]", "the account, then on, first, last or off"),
    ),
  ).action(
    async (tokens: string[], _options: { home?: string; json?: boolean }, command: Command) => {
      const options = command.optsWithGlobals() as { home?: string; json?: boolean };
      try {
        const { changed, rows } = await runCreditsCommand(tokens, options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(rows)}\n`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("No Codex account changes how it spends its credits\n");
          return;
        }
        for (const row of rows) {
          process.stdout.write(
            `${changed ? "✓" : "●"} ${row.label}: ${creditsSay(row.creditsMode)}\n`,
          );
        }
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

  // myna's `quota alert [<percent>|off] [--balance <amount>|off]`.
  addJsonOption(
    addLocalDaemonOptions(
      usage
        .command("alert")
        .description("Set the allowance and low-balance notification thresholds")
        .argument("[percent]", "The share used that notifies, 1 to 100, or off")
        .option("--balance <amount>", "The balance that notifies, or off"),
    ),
  ).action(
    async (
      percent: string | undefined,
      _options: { home?: string; balance?: string; json?: boolean },
      command: Command,
    ) => {
      const options = command.optsWithGlobals() as {
        home?: string;
        balance?: string;
        json?: boolean;
      };
      try {
        const row = await runAlertCommand(percent, options);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(row)}\n`);
          return;
        }
        process.stdout.write(
          [
            `Allowance alert: ${row.usageAlertPercent > 0 ? `${row.usageAlertPercent}% used` : "off"}`,
            `Balance alert: ${row.balanceAlert > 0 ? row.balanceAlert : "off"}`,
            ...(row.applied === undefined
              ? []
              : [
                  row.applied
                    ? "Applied to the running daemon"
                    : "Saved; applied at its next start",
                ]),
          ].join("\n") + "\n",
        );
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`);
        process.exitCode = 1;
      }
    },
  );

  // myna's `quota refresh <provider> [<account>]`.
  addJsonAndDaemonHostOptions(
    usage
      .command("refresh")
      .description("Ask the vendors again for usage reports")
      .argument("[provider]", "Only this source")
      .argument("[account]", "Only this account"),
  ).action(
    withOutput(
      (
        provider: string | undefined,
        account: string | undefined,
        options: CommandOptions,
        _command: Command,
      ) => runUsageRefreshCommand(options, { provider, account }),
    ),
  );

  // myna's `quota history [<provider|account>…] [--days <n>] [--json]`.
  addJsonAndDaemonHostOptions(
    usage
      .command("history")
      .description("Readings kept for the gateway's accounts")
      .argument("[names...]", "provider, account, or provider/account")
      .option("--days <n>", "How far back the readings go, up to the 45 days kept"),
  ).action(
    withOutput((names: string[], options: CommandOptions, _command: Command) =>
      runUsageHistoryCommand(names, options),
    ),
  );

  // myna's `quota wait <provider|account> [--timeout] [--quiet]`.
  addJsonOption(
    addDaemonHostOption(
      usage
        .command("wait")
        .description("Return once a provider or account has allowance again")
        .argument("<target>", "Provider, account, or provider/account")
        .option("--timeout <duration>", "How long to wait, such as 30m or 6h")
        .option("--quiet", "Say nothing when it succeeds"),
    ),
  ).action(
    withGlobalOptions(
      async (
        target: string,
        options: { timeout?: string; quiet?: boolean; daemonTarget: ConnectOptions["target"] },
      ) => {
        try {
          const timeoutMs = parseTimeoutMs(options.timeout);
          const row = await runUsageWaitCommand(target, {
            timeoutMs,
            quiet: options.quiet,
            daemonTarget: options.daemonTarget,
          });
          if (!options.quiet) {
            process.stdout.write(`${row.target} has allowance again\n`);
          }
        } catch (error) {
          process.stderr.write(`${errorMessage(error)}\n`);
          const code =
            typeof error === "object" && error !== null && "code" in error
              ? String(error.code)
              : "";
          process.exitCode = code === "UNKNOWN_TARGET" ? 2 : 1;
        }
      },
    ),
  );

  // myna's `quota reset [<codex account>] [--card <n>] [--yes]`.
  addJsonOption(
    addDaemonHostOption(
      usage
        .command("reset")
        .description("Spend one of a Codex account's rate-limit resets; it cannot be undone")
        .argument("[accounts...]", "One Codex account; absent is Codex's own sign-in")
        .option("--card <n>", "Which reset, 1 for the one that runs out first")
        .option("--yes", "Don't ask before spending it")
        // myna reads the account and flags itself, so its own refusals say
        // what went wrong ("one account at a time", a flag it doesn't know).
        .allowUnknownOption(true),
    ),
  ).action(
    withGlobalOptions(
      async (
        accounts: string[],
        options: {
          card?: string;
          yes?: boolean;
          json?: boolean;
          daemonTarget: ConnectOptions["target"];
        },
      ) => {
        try {
          const account = resetAccountOf(accounts);
          const result = await runUsageResetCommand(account, options, connectToDaemon, async () => {
            if (process.stdin.isTTY !== true) {
              return false;
            }
            const readline = createInterface({ input: process.stdin, output: process.stderr });
            try {
              const answer = await readline.question(
                `Spend one of ${account ?? "the Codex account"}'s resets, starting its current windows again? It can't be undone. [y/N] `,
              );
              const said = answer.trim().toLowerCase();
              return said === "y" || said === "yes";
            } finally {
              readline.close();
            }
          });
          if (options.json === true) {
            process.stdout.write(`${JSON.stringify(result)}\n`);
          } else {
            process.stdout.write(
              result.spent
                ? `✓ ${result.accountLabel}: ${result.text}\n`
                : `${result.accountLabel}: ${result.text}\n`,
            );
          }
          if (!result.spent) {
            process.exitCode = 1;
          }
        } catch (error) {
          process.stderr.write(`${errorMessage(error)}\n`);
          process.exitCode = 1;
        }
      },
    ),
  );

  return usage;
}
