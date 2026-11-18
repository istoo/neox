import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountDiscoveryOn, type GatewayConfig } from "../config.js";
import { MINIMAX_VENDOR, checkMinimax, loadMinimaxAccounts } from "./minimax.js";
import { QODER_VENDOR, checkQoder, loadQoderAccounts, type QoderIdentityOptions } from "./qoder.js";
import { TRAE_VENDOR, checkTrae, loadTraeAccounts } from "./trae.js";
import { WORKBUDDY_VENDOR, checkWorkbuddy, loadWorkbuddyAccounts } from "./workbuddy.js";
import type { CheckinState } from "./store.js";
import { checkinFilePath, readCheckins } from "./store.js";
import {
  CHECKIN_EVERY_MS,
  beijingDay,
  isProvisional,
  retryAfter,
  runCheckin,
  type CheckinAccount,
  type CheckinEntry,
  type CheckinResult,
} from "./state.js";

/**
 * The daily check-in service: which accounts myna is signed in to, their
 * last check-ins, a manual press, the per-vendor switches, and the loop
 * myna runs (first look two minutes after start, then every minute; a
 * vendor is asked on its 30-minute cadence, as the Beijing day turns, and
 * as a failure comes due).
 *
 * WorkBuddy, MiniMax Code, Trae CN and Qoder are those Neox asks itself.
 * A plugin whose subscription provider declares `checkin` asks its own
 * vendor instead: its sign-ins live in the plugin's accounts file and its
 * switches in `checkin.plugins`, by provider id. Each account is checked
 * in once a Beijing day while its provider's switch is on, kept in
 * `gateway/plugin-checkin.json`, exactly as a vendor's is; one plugin's
 * failure is logged and never stops another's run (myna's
 * `plugin_checkin.go`).
 *
 * Requests use the daemon's global fetch, as myna's provider-agnostic
 * path does: `network/index.ts` points it at gateway.json's proxy, then
 * `HTTPS_PROXY`/`NO_PROXY`, then the system's. myna's per-account proxy
 * (`ViaLogin`) is not ported, so an account proxy in myna does not apply
 * here.
 */

export type CheckinVendor = "workbuddy" | "minimax" | "trae" | "qoder";

export const CHECKIN_VENDORS: readonly CheckinVendor[] = [
  WORKBUDDY_VENDOR,
  MINIMAX_VENDOR,
  TRAE_VENDOR,
  QODER_VENDOR,
];

/** The vendors with a switch of their own in the gateway config. */
const CORE_SWITCHES = ["workbuddy", "minimax", "trae", "qoder"] as const;

type CoreSwitch = (typeof CORE_SWITCHES)[number];

export type GatewayCheckinConfig = NonNullable<GatewayConfig["checkin"]>;

/** A running plugin's subscription provider that checks its accounts in. */
export interface CheckinPluginProvider {
  pluginId: string;
  /** The provider id its switch and `plugin:<id>` name it by. */
  id: string;
  label: string;
}

/**
 * The running plugins' check-in capable providers, and the call that asks
 * one account. The daemon adapter reads them from the plugin runtime; tests
 * give their own.
 */
export interface CheckinPluginSource {
  providers(): readonly CheckinPluginProvider[];
  checkin(input: { pluginId: string; providerId: string; accountId: string }): Promise<unknown>;
}

/** A plugin provider and the sign-ins its check-in reaches. */
interface DiscoveredPluginProvider {
  provider: CheckinPluginProvider;
  accounts: CheckinAccount[];
}

const PLUGIN_BY = "plugin:";
const PLUGIN_OUTCOMES: ReadonlySet<string> = new Set([
  "claimed",
  "done",
  "ineligible",
  "inactive",
  "failed",
  "captcha",
  "own-app",
]);
/** Providers whose campaigns can open before the Beijing day ends (myna's `pluginRechecks`). */
const PLUGIN_RECHECKS: ReadonlySet<string> = new Set(["qoder", "qoder-cn", "zcode"]);

/**
 * The part of the gateway config store this service needs: the current
 * revision and an atomic write of a new one.
 */
export interface CheckinConfigStore {
  get(): GatewayConfig;
  write(input: unknown): Promise<GatewayConfig>;
}

export interface CheckinAccountStatus {
  /** A vendor's id, or `plugin:<provider id>`. */
  by: string;
  key: string;
  user: string;
  /** Whether the account takes part; the per-account opt-out, not the vendor switch. */
  on: boolean;
  /** Its last record, if any was kept. */
  record?: CheckinEntry;
  /** The record is provisional and will be asked again today. */
  again: boolean;
}

export interface CheckinRunRequest {
  /** Only this vendor's accounts; absent is every vendor. */
  by?: string;
  /** One account, checked in even while left out of the daily check-in. */
  key?: string;
}

export interface CheckinServiceOptions {
  neolixHome: string;
  config: CheckinConfigStore;
  /** myna's plugin-auth.json; `~/.config/myna/plugin-auth.json` otherwise. */
  mynaAuthPath?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** The first look after start, 2 minutes by default (myna's `keepCheckedIn`). */
  firstCheckMs?: number;
  /** How often that loop looks, 1 minute by default. */
  tickMs?: number;
  /** How long the accounts of one vendor are given, 2 minutes by default. */
  runTimeoutMs?: number;
  /** How Qoder's device identity is read; the machine's own helper otherwise. */
  qoderIdentity?: QoderIdentityOptions;
  /** The plugins that check their own accounts in; none is a daemon without them. */
  plugins?: CheckinPluginSource;
  onError?: (error: unknown) => void;
}

export class CheckinService {
  private readonly config: CheckinConfigStore;
  private readonly gatewayDir: string;
  private readonly pluginSettingsDir: string;
  private readonly pluginStorePath: string;
  private readonly plugins?: CheckinPluginSource;
  private readonly authPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly firstCheckMs: number;
  private readonly tickMs: number;
  private readonly runTimeoutMs: number;
  private readonly qoderIdentity?: QoderIdentityOptions;
  private readonly onError?: (error: unknown) => void;
  private readonly loops = new Map<string, { last: number; again: number | null }>();
  private readonly inFlight = new Set<AbortController>();
  private firstTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** Keeps the loop and a press from asking for one account at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CheckinServiceOptions) {
    this.config = options.config;
    this.gatewayDir = path.join(options.neolixHome, "gateway");
    this.pluginSettingsDir = path.join(options.neolixHome, "plugin-settings");
    this.pluginStorePath = checkinFilePath(this.gatewayDir, "plugin");
    this.plugins = options.plugins;
    this.authPath = options.mynaAuthPath ?? defaultMynaAuthPath();
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.firstCheckMs = options.firstCheckMs ?? 2 * 60_000;
    this.tickMs = options.tickMs ?? 60_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 2 * 60_000;
    this.qoderIdentity = options.qoderIdentity;
    this.onError = options.onError;
  }

  /** Every account a check-in reaches, its last record and Again mark; asks nothing. */
  public async listAccounts(): Promise<CheckinAccountStatus[]> {
    const config = this.config.get();
    if (!accountDiscoveryOn(config)) {
      return [];
    }
    const discovered = await this.discover();
    const pluginProviders = await this.discoverPlugins();
    const off = new Set(config.checkin?.off ?? []);
    const states = await Promise.all(
      CHECKIN_VENDORS.map(async (vendor) => {
        try {
          return await readCheckins(this.storePath(vendor));
        } catch {
          return {} as CheckinState;
        }
      }),
    );
    const pluginState = await this.readPluginState();
    const out: CheckinAccountStatus[] = [];
    CHECKIN_VENDORS.forEach((vendor, index) => {
      addStatuses(out, states[index] ?? {}, vendor, discovered[vendor], off);
    });
    for (const { provider, accounts } of pluginProviders) {
      addStatuses(out, pluginState, pluginBy(provider), accounts, off);
    }
    out.sort((a, b) => {
      if (a.user === b.user) return 0;
      return a.user < b.user ? -1 : 1;
    });
    return out;
  }

  /**
   * The switches the Usage card shows: the four vendors', and every
   * plugin provider's that checks in, by provider id. A provider with no
   * setting yet is off: Neox's plugins do not take over a vendor's own
   * check-in, so they share no switch with one.
   */
  public switches(): Record<string, boolean> {
    const current = this.config.get().checkin ?? {};
    const out: Record<string, boolean> = {};
    for (const vendor of CHECKIN_VENDORS) {
      out[vendor] = current[vendor] === true;
    }
    let providers: readonly CheckinPluginProvider[] = [];
    try {
      providers = this.plugins?.providers() ?? [];
    } catch (error) {
      this.onError?.(error);
    }
    for (const provider of providers) {
      out[provider.id] = current.plugins?.[provider.id] === true;
    }
    // Switches written for a plugin that is not running stay visible.
    for (const [id, on] of Object.entries(current.plugins ?? {})) {
      if (!(id in out)) out[id] = on === true;
    }
    return out;
  }

  /**
   * Checks accounts in now, as a press does: a key asks that account alone,
   * even while left out; a vendor asks that vendor's; neither asks every
   * vendor's.
   */
  public async run(request: CheckinRunRequest = {}): Promise<CheckinEntry[]> {
    const config = this.config.get();
    if (!accountDiscoveryOn(config)) {
      return [];
    }
    return this.serialized(async () => {
      const discovered = await this.discover();
      const pluginProviders = await this.discoverPlugins();
      const now = this.now();
      const out: CheckinEntry[] = [];
      for (const vendor of this.vendorsFor(request.by, pluginProviders)) {
        if (vendor.kind === "core") {
          out.push(
            ...(await this.runVendor(vendor.id, discovered[vendor.id], true, now, request.key)),
          );
          continue;
        }
        // A press for one plugin provider asks it even while its switch is
        // off, as a vendor press does; a provider that fails is logged and
        // the others still run.
        try {
          out.push(
            ...(await this.runPlugin(
              vendor.provider.provider,
              vendor.provider.accounts,
              true,
              now,
              request.key,
            )),
          );
        } catch (error) {
          this.onError?.(error);
        }
      }
      return out;
    });
  }

  /**
   * Turns a vendor's check-in on or off. `workbuddy`, `minimax`, `trae` and
   * `qoder` have switches of their own; anything else is a plugin provider
   * id under `plugins`.
   */
  public async setSwitch(by: string, on: boolean): Promise<void> {
    const config = this.config.get();
    const current = config.checkin ?? {};
    // A plugin row is named `plugin:<id>` when accounts name it; its
    // switch is still kept by provider id, as `plugins` does.
    const id = by.startsWith(PLUGIN_BY) ? by.slice(PLUGIN_BY.length) : by;
    const next: GatewayCheckinConfig = isCoreSwitch(id)
      ? { ...current, [id]: on }
      : { ...current, plugins: { ...current.plugins, [id]: on } };
    await this.config.write({ ...config, checkin: next });
  }

  /** Leaves an account out of its vendor's daily check-in, or puts it back. */
  public async setAccountOn(key: string, on: boolean): Promise<void> {
    const config = this.config.get();
    const current = config.checkin ?? {};
    const off = (current.off ?? []).filter((entry) => entry !== key);
    if (!on) {
      off.push(key);
    }
    await this.config.write({ ...config, checkin: { ...current, off } });
  }

  /** Starts myna's loop: the first look after two minutes, then every minute. */
  public startScheduler(): void {
    if (this.started) return;
    this.started = true;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      if (!this.started) return;
      void this.tick().catch((error: unknown) => this.onError?.(error));
      this.tickTimer = setInterval(() => {
        if (!this.started) return;
        void this.tick().catch((error: unknown) => this.onError?.(error));
      }, this.tickMs);
      this.tickTimer.unref?.();
    }, this.firstCheckMs);
    this.firstTimer.unref?.();
  }

  /** Stops the loop and aborts the runs in flight. */
  public stop(): void {
    this.started = false;
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const controller of this.inFlight) {
      controller.abort();
    }
    this.inFlight.clear();
    this.loops.clear();
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    const config = this.config.get();
    if (!accountDiscoveryOn(config)) return;
    const switches = config.checkin ?? {};
    const vendors = CHECKIN_VENDORS.filter((vendor) => switches[vendor] === true);
    const anyPlugin = Object.values(switches.plugins ?? {}).some((on) => on === true);
    if (vendors.length === 0 && !anyPlugin) return;
    const discovered = await this.discover();
    const pluginProviders = await this.discoverPlugins();
    const plugins = pluginProviders.filter(
      ({ provider }) => switches.plugins?.[provider.id] === true,
    );

    const now = this.now();
    const nowMs = now.getTime();
    const day = beijingDay(now);

    await this.serialized(async () => {
      for (const vendor of vendors) {
        if (!this.started) return;
        await this.tickTarget(vendor, discovered[vendor], nowMs, day, () =>
          this.runVendor(vendor, discovered[vendor], false, now),
        );
      }
      for (const { provider, accounts } of plugins) {
        if (!this.started) return;
        const key = pluginBy(provider);
        // One plugin's failure is logged and the next still runs.
        try {
          await this.tickTarget(key, accounts, nowMs, day, () =>
            this.runPlugin(provider, accounts, false, now),
          );
        } catch (error) {
          this.onError?.(error);
        }
      }
    });
  }

  /** One provider's turn in the loop: the 30-minute cadence, its retries, and `until`. */
  private async tickTarget(
    key: string,
    accounts: readonly CheckinAccount[],
    nowMs: number,
    day: string,
    run: () => Promise<CheckinEntry[]>,
  ): Promise<void> {
    const loop = this.loops.get(key) ?? { last: 0, again: null };
    // The wall clock, which goes on while the machine sleeps: a machine
    // that slept through the day's turn notices on waking.
    if (
      loop.last !== 0 &&
      nowMs - loop.last < CHECKIN_EVERY_MS &&
      beijingDay(new Date(loop.last)) === day &&
      (loop.again === null || nowMs < loop.again)
    ) {
      return;
    }
    loop.last = nowMs;
    loop.again = null;
    this.loops.set(key, loop);

    const entries = accounts.length === 0 ? [] : await run();
    for (const entry of entries) {
      let due: number | null = null;
      if (entry.outcome === "failed") {
        due = Date.parse(entry.at) + retryAfter(entry);
      }
      if (entry.until !== undefined) {
        const until = Date.parse(entry.until);
        if (!Number.isNaN(until) && until > nowMs && (due === null || until < due)) {
          due = until;
        }
      }
      if (due !== null && (loop.again === null || due < loop.again)) {
        loop.again = due;
      }
    }
  }

  private runVendor(
    vendor: CheckinVendor,
    accounts: readonly CheckinAccount[],
    soon: boolean,
    now: Date,
    only?: string,
  ): Promise<CheckinEntry[]> {
    return this.runAccounts({
      storePath: this.storePath(vendor),
      by: vendor,
      accounts,
      soon,
      now,
      only,
      recheck: vendor === QODER_VENDOR,
    });
  }

  /** One plugin provider's accounts, kept in the plugins' shared file (myna's `plugin-checkin.json`). */
  private runPlugin(
    provider: CheckinPluginProvider,
    accounts: readonly CheckinAccount[],
    soon: boolean,
    now: Date,
    only?: string,
  ): Promise<CheckinEntry[]> {
    return this.runAccounts({
      storePath: this.pluginStorePath,
      by: pluginBy(provider),
      accounts,
      soon,
      now,
      only,
      recheck: PLUGIN_RECHECKS.has(provider.id),
    });
  }

  private async runAccounts(input: {
    storePath: string;
    by: string;
    accounts: readonly CheckinAccount[];
    soon: boolean;
    now: Date;
    only?: string;
    recheck: boolean;
  }): Promise<CheckinEntry[]> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.runTimeoutMs);
    try {
      return await runCheckin(input.accounts, input.soon, {
        storePath: input.storePath,
        by: input.by,
        now: input.now,
        ...(input.only === undefined ? {} : { only: input.only }),
        off: this.config.get().checkin?.off ?? [],
        recheck: input.recheck,
        onError: this.onError,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  private async discover(): Promise<Record<CheckinVendor, CheckinAccount[]>> {
    const [workbuddy, minimax, trae, qoder] = await Promise.all([
      loadWorkbuddyAccounts({ authPath: this.authPath }),
      loadMinimaxAccounts({ authPath: this.authPath }),
      loadTraeAccounts({ authPath: this.authPath }),
      loadQoderAccounts({ authPath: this.authPath }),
    ]);
    return {
      workbuddy: workbuddy.map((account) => ({
        user: account.user,
        key: account.key,
        provider: WORKBUDDY_VENDOR,
        on: true,
        run: (signal?: AbortSignal) =>
          checkWorkbuddy({
            account,
            authPath: this.authPath,
            fetch: this.fetchImpl,
            signal,
          }),
      })),
      minimax: minimax.map((account) => ({
        user: account.user,
        key: account.key,
        provider: MINIMAX_VENDOR,
        on: true,
        run: (signal?: AbortSignal) =>
          checkMinimax({
            account,
            authPath: this.authPath,
            fetch: this.fetchImpl,
            now: this.now,
            signal,
          }),
      })),
      trae: trae.map((account) => ({
        user: account.user,
        key: account.key,
        provider: TRAE_VENDOR,
        on: true,
        run: (signal?: AbortSignal) =>
          checkTrae({ account, authPath: this.authPath, fetch: this.fetchImpl, signal }),
      })),
      qoder: qoder.map((account) => ({
        user: account.user,
        key: account.key,
        provider: QODER_VENDOR,
        on: true,
        run: (signal?: AbortSignal) =>
          checkQoder({
            account,
            authPath: this.authPath,
            fetch: this.fetchImpl,
            now: this.now,
            signal,
            identity: this.qoderIdentity,
          }),
      })),
    };
  }

  private vendorsFor(
    by: string | undefined,
    pluginProviders: readonly DiscoveredPluginProvider[],
  ): Array<
    { kind: "core"; id: CheckinVendor } | { kind: "plugin"; provider: DiscoveredPluginProvider }
  > {
    const all = (): Array<
      { kind: "core"; id: CheckinVendor } | { kind: "plugin"; provider: DiscoveredPluginProvider }
    > => [
      ...CHECKIN_VENDORS.map((id) => ({ kind: "core" as const, id })),
      ...pluginProviders.map((provider) => ({ kind: "plugin" as const, provider })),
    ];
    if (by === undefined) return all();
    const name = by.startsWith(PLUGIN_BY) ? by.slice(PLUGIN_BY.length) : by;
    const core = CHECKIN_VENDORS.find((vendor) => vendor === name);
    if (core !== undefined) return [{ kind: "core", id: core }];
    return pluginProviders
      .filter(({ provider }) => provider.id === name)
      .map((provider) => ({ kind: "plugin" as const, provider }));
  }

  /**
   * The running plugins' check-in capable providers and their sign-ins. A
   * plugin that fails to list leaves no accounts but never stops the
   * others, as myna's per-plugin check-in does.
   */
  private async discoverPlugins(): Promise<DiscoveredPluginProvider[]> {
    if (this.plugins === undefined) return [];
    let providers: readonly CheckinPluginProvider[];
    try {
      providers = this.plugins.providers();
    } catch (error) {
      this.onError?.(error);
      return [];
    }
    const out: DiscoveredPluginProvider[] = [];
    for (const provider of providers) {
      try {
        const accounts = await this.pluginAccounts(provider);
        if (accounts.length > 0) out.push({ provider, accounts });
      } catch (error) {
        this.onError?.(error);
      }
    }
    return out;
  }

  /**
   * A plugin's sign-ins, as its own accounts store keeps them
   * (`plugin-settings/<pluginId>/accounts.json`). The key is
   * `pluginId|providerId|accountId`: two plugins may name one provider id.
   */
  private async pluginAccounts(provider: CheckinPluginProvider): Promise<CheckinAccount[]> {
    const file = path.join(this.pluginSettingsDir, provider.pluginId, "accounts.json");
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      throw new Error(`${file} has an unknown shape`);
    }
    const accounts = (parsed as { accounts?: unknown }).accounts;
    if (typeof accounts !== "object" || accounts === null || Array.isArray(accounts)) {
      throw new Error(`${file} has an unknown shape`);
    }
    return Object.entries(accounts as Record<string, unknown>)
      .filter(([, auth]) => typeof auth === "object" && auth !== null && !Array.isArray(auth))
      .map(([accountId, auth]) => ({
        user: pluginUserName(auth as Record<string, unknown>, accountId),
        key: `${provider.pluginId}|${provider.id}|${accountId}`,
        provider: provider.id,
        on: true,
        run: (signal?: AbortSignal) => this.askPlugin(provider, accountId, signal),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  /** Asks the plugin for one account, as its `auth.checkin` does. */
  private async askPlugin(
    provider: CheckinPluginProvider,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<CheckinResult> {
    if (this.plugins === undefined) throw new Error("Plugin check-ins are unavailable");
    const answer = await untilAborted(
      this.plugins.checkin({
        pluginId: provider.pluginId,
        providerId: provider.id,
        accountId,
      }),
      signal,
    );
    return pluginCheckinResult(answer);
  }

  private async readPluginState(): Promise<CheckinState> {
    try {
      return await readCheckins(this.pluginStorePath);
    } catch {
      return {};
    }
  }

  private storePath(vendor: CheckinVendor): string {
    return checkinFilePath(this.gatewayDir, vendor);
  }

  /** Runs one job at a time: the loop and a press never overlap. */
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: () => void = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function pluginBy(provider: CheckinPluginProvider): string {
  return `${PLUGIN_BY}${provider.id}`;
}

/** The accounts of one provider, as its last kept records say they stand. */
function addStatuses(
  out: CheckinAccountStatus[],
  state: CheckinState,
  by: string,
  accounts: readonly CheckinAccount[],
  off: ReadonlySet<string>,
): void {
  for (const account of accounts) {
    const record = state[account.key];
    const status: CheckinAccountStatus = {
      by,
      key: account.key,
      user: account.user,
      on: !off.has(account.key),
      again: record !== undefined && isProvisional(record),
    };
    if (record !== undefined) {
      status.record = {
        ...record,
        key: account.key,
        user: account.user,
        by,
        again: isProvisional(record),
        asked: false,
      };
    }
    out.push(status);
  }
}

/** A plugin sign-in's display name: its `accountId`, else the id it is kept under. */
function pluginUserName(auth: Record<string, unknown>, accountId: string): string {
  const named = auth.accountId;
  return typeof named === "string" && named.trim() !== "" ? named.trim() : accountId;
}

/**
 * What a plugin's `auth.checkin` answered, shaped as the vendors' results
 * are: the outcome must be one of the known ones; `until` is an RFC 3339
 * time, or epoch milliseconds as myna's host accepts (a time that doesn't
 * read is not told).
 */
function pluginCheckinResult(answer: unknown): CheckinResult {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return { outcome: "failed", msg: `the plugin answered ${JSON.stringify(answer) ?? "null"}` };
  }
  const value = answer as Record<string, unknown>;
  const outcome = value.outcome;
  const message = typeof value.message === "string" ? value.message : "";
  const until = pluginUntil(value.until);
  if (typeof outcome !== "string" || !PLUGIN_OUTCOMES.has(outcome)) {
    const said = outcome === undefined || outcome === null ? "no outcome" : JSON.stringify(outcome);
    return {
      outcome: "failed",
      msg:
        message === "" ? `the plugin answered ${said}` : `the plugin answered ${said}: ${message}`,
      ...(until === undefined ? {} : { until }),
    };
  }
  const result: CheckinResult = {
    outcome: outcome as CheckinResult["outcome"],
    ...(until === undefined ? {} : { until }),
  };
  const credit = pluginNumber(value.credit);
  if (credit !== undefined && credit > 0) result.credit = credit;
  const streak = pluginNumber(value.streak);
  if (streak !== undefined && streak > 0) result.streak = Math.round(streak);
  if (message !== "") result.msg = message;
  return result;
}

function pluginNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function pluginUntil(value: unknown): string | undefined {
  let time = Number.NaN;
  if (typeof value === "number") {
    time = value;
  } else if (typeof value === "string" && value !== "") {
    time = Date.parse(value);
  }
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
}

/** A promise a stopped run no longer waits for: the plugin call itself can't be aborted. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new Error("The check-in was aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("The check-in was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        return resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        return reject(error);
      },
    );
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** myna's plugin-auth.json: `~/.config/myna`, or `$XDG_CONFIG_HOME/myna` when rooted. */
export function defaultMynaAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const configHome =
    xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(configHome, "myna", "plugin-auth.json");
}

function isCoreSwitch(value: string): value is CoreSwitch {
  return (CORE_SWITCHES as readonly string[]).includes(value);
}
