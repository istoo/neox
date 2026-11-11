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
} from "./state.js";

/**
 * The daily check-in service: which accounts myna is signed in to, their
 * last check-ins, a manual press, the per-vendor switches, and the loop
 * myna runs (first look two minutes after start, then every minute; a
 * vendor is asked on its 30-minute cadence, as the Beijing day turns, and
 * as a failure comes due).
 *
 * This round serves WorkBuddy, MiniMax Code, Trae CN and Qoder. The
 * plugins that check in themselves are not ported; their switches stay in
 * `checkin.plugins` for that round.
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

/**
 * The part of the gateway config store this service needs: the current
 * revision and an atomic write of a new one.
 */
export interface CheckinConfigStore {
  get(): GatewayConfig;
  write(input: unknown): Promise<GatewayConfig>;
}

export interface CheckinAccountStatus {
  by: CheckinVendor;
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
  onError?: (error: unknown) => void;
}

export class CheckinService {
  private readonly config: CheckinConfigStore;
  private readonly gatewayDir: string;
  private readonly authPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly firstCheckMs: number;
  private readonly tickMs: number;
  private readonly runTimeoutMs: number;
  private readonly qoderIdentity?: QoderIdentityOptions;
  private readonly onError?: (error: unknown) => void;
  private readonly loops = new Map<CheckinVendor, { last: number; again: number | null }>();
  private readonly inFlight = new Set<AbortController>();
  private firstTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private started = false;
  /** Keeps the loop and a press from asking for one account at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: CheckinServiceOptions) {
    this.config = options.config;
    this.gatewayDir = path.join(options.neolixHome, "gateway");
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
    const out: CheckinAccountStatus[] = [];
    CHECKIN_VENDORS.forEach((vendor, index) => {
      const state = states[index] ?? {};
      for (const account of discovered[vendor]) {
        const record = state[account.key];
        const status: CheckinAccountStatus = {
          by: vendor,
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
            by: vendor,
            again: isProvisional(record),
            asked: false,
          };
        }
        out.push(status);
      }
    });
    out.sort((a, b) => {
      if (a.user === b.user) return 0;
      return a.user < b.user ? -1 : 1;
    });
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
      const now = this.now();
      const vendors = this.vendorsFor(request.by);
      const out: CheckinEntry[] = [];
      for (const vendor of vendors) {
        let accounts = discovered[vendor];
        if (request.key !== undefined) {
          accounts = accounts.filter((account) => account.key === request.key);
        }
        if (accounts.length === 0) continue;
        out.push(...(await this.runVendor(vendor, accounts, true, now, request.key)));
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
    const next: GatewayCheckinConfig = isCoreSwitch(by)
      ? { ...current, [by]: on }
      : { ...current, plugins: { ...current.plugins, [by]: on } };
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
    if (vendors.length === 0) return;

    const now = this.now();
    const nowMs = now.getTime();
    const day = beijingDay(now);
    const discovered = await this.discover();

    await this.serialized(async () => {
      for (const vendor of vendors) {
        if (!this.started) return;
        const loop = this.loops.get(vendor) ?? { last: 0, again: null };
        // The wall clock, which goes on while the machine sleeps: a machine
        // that slept through the day's turn notices on waking.
        if (
          loop.last !== 0 &&
          nowMs - loop.last < CHECKIN_EVERY_MS &&
          beijingDay(new Date(loop.last)) === day &&
          (loop.again === null || nowMs < loop.again)
        ) {
          continue;
        }
        loop.last = nowMs;
        loop.again = null;
        this.loops.set(vendor, loop);

        const entries = await this.runVendor(vendor, discovered[vendor], false, now);
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
    });
  }

  private async runVendor(
    vendor: CheckinVendor,
    accounts: readonly CheckinAccount[],
    soon: boolean,
    now: Date,
    only?: string,
  ): Promise<CheckinEntry[]> {
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.runTimeoutMs);
    try {
      return await runCheckin(accounts, soon, {
        storePath: this.storePath(vendor),
        by: vendor,
        now,
        only,
        off: this.config.get().checkin?.off ?? [],
        recheck: vendor === QODER_VENDOR,
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

  private vendorsFor(by: string | undefined): CheckinVendor[] {
    if (by === undefined) return [...CHECKIN_VENDORS];
    return CHECKIN_VENDORS.filter((vendor) => vendor === by);
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
