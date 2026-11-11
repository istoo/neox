import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  autoResetWhen,
  expiringResetSpent,
  nextResetLook,
  RESET_EXPIRY_CLOSE_MS,
  RESET_EXPIRY_FAR_MS,
  RESET_EXPIRY_WATCH_MS,
  resetLeadMinutes,
} from "./codex-reset.js";
import { codexAccountSignIn, type PoolOptions } from "./codex-accounts.js";
import { codexLimitsOf } from "./codex-limits.js";
import { readCodexSignIn } from "./codex-user-data.js";
import {
  accountDiscoveryOn,
  isProviderEnabled,
  providerAccounts,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayProvider,
} from "./config.js";
import { familyOf } from "./warm-at.js";

/**
 * The Codex resets an account holds and spending one, as myna's
 * codex_resets.go does: `GET /wham/rate-limit-reset-credits` lists them,
 * `POST …/consume` spends one. Only accounts the user lets spend their
 * resets by themselves are touched (codex-reset.ts has the timing), and a
 * spend cannot be undone.
 */

const CHATGPT_BACKEND = "https://chatgpt.com/backend-api";
const RESET_CREDITS_PATH = "/wham/rate-limit-reset-credits";
const WEEKLY_WINDOW_MINUTES = 10_080;

export interface CodexResetCredit {
  id: string;
  /** Epoch ms; null when the credit never runs out. */
  expiresAt: number | null;
}

/** Who the reset calls are made as, and the key its windows are kept under. */
export interface CodexResetSignIn {
  accessToken: string;
  accountId: string | null;
  limitKey: string;
}

export interface CodexResetCall {
  signIn: CodexResetSignIn;
  fetchImpl?: typeof fetch;
}

function resetHeaders(signIn: CodexResetSignIn): Record<string, string> {
  return {
    authorization: `Bearer ${signIn.accessToken}`,
    accept: "application/json",
    originator: "codex_cli_rs",
    ...(signIn.accountId === null ? {} : { "chatgpt-account-id": signIn.accountId }),
  };
}

/**
 * The resets an account still holds, the one that runs out first first: a
 * credit that never runs out comes after all that do (myna's wire.first).
 */
export async function readCodexResetCredits(input: CodexResetCall): Promise<CodexResetCredit[]> {
  const response = await (input.fetchImpl ?? fetch)(`${CHATGPT_BACKEND}${RESET_CREDITS_PATH}`, {
    headers: resetHeaders(input.signIn),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Codex reset credits: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  const credits = isRecord(body) && Array.isArray(body.credits) ? body.credits : [];
  const available: CodexResetCredit[] = [];
  for (const entry of credits) {
    if (!isRecord(entry) || entry.status !== "available" || typeof entry.id !== "string") {
      continue;
    }
    available.push({ id: entry.id, expiresAt: expiryOf(entry.expires_at) });
  }
  return available.sort((left, right) => expiryOrder(left.expiresAt, right.expiresAt));
}

function expiryOf(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function expiryOrder(left: number | null, right: number | null): number {
  if (left === null) {
    return right === null ? 0 : 1;
  }
  return right === null ? -1 : left - right;
}

export interface CodexResetOutcome {
  /** myna's word: reset, nothing_to_reset, no_credit, already_redeemed. */
  code: string;
  windows: number;
}

/** Spends one reset, the one named; the id makes the call idempotent. */
export async function consumeCodexReset(
  input: CodexResetCall & { creditId: string; redeemRequestId?: string },
): Promise<CodexResetOutcome> {
  const response = await (input.fetchImpl ?? fetch)(
    `${CHATGPT_BACKEND}${RESET_CREDITS_PATH}/consume`,
    {
      method: "POST",
      headers: { ...resetHeaders(input.signIn), "content-type": "application/json" },
      body: JSON.stringify({
        credit_id: input.creditId,
        redeem_request_id: input.redeemRequestId ?? randomUUID(),
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Codex reset: ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || typeof body.code !== "string" || body.code === "") {
    throw new Error("Codex reset: an answer that says nothing");
  }
  return {
    code: body.code,
    windows: typeof body.windows_reset === "number" ? body.windows_reset : 0,
  };
}

/** One account's sign-in for its own reset calls. */
export type CodexResetSignInResolver = (
  account: GatewayAccount,
  options: { accountsFile: string; now: number; fetchImpl?: typeof fetch },
) => Promise<CodexResetSignIn | null>;

/**
 * Neolix's own ChatGPT account by its store id, else Codex's own sign-in —
 * the same two the gateway serves Codex from.
 */
export async function resolveCodexResetSignIn(
  account: GatewayAccount,
  options: {
    accountsFile: string;
    now: number;
    fetchImpl?: typeof fetch;
    /** Whether Codex's own sign-in may be read at all (account discovery). */
    discovery?: boolean;
  },
): Promise<CodexResetSignIn | null> {
  if (account.codexAccountId !== undefined) {
    const pooled: PoolOptions = {
      accountsFile: options.accountsFile,
      writeBack: true,
      now: options.now,
      fetchImpl: options.fetchImpl,
    };
    return codexAccountSignIn({ ...pooled, id: account.codexAccountId });
  }
  const signIn = await readCodexSignIn(
    options.discovery === undefined ? {} : { discovery: options.discovery },
  );
  return signIn.ok
    ? {
        accessToken: signIn.accessToken,
        accountId: signIn.accountId,
        limitKey: signIn.accountId ?? "codex-own",
      }
    : null;
}

/** The windows last heard of an account, its own sign-in keyed as the gateway keys it. */
function windowsOf(signIn: CodexResetSignIn): readonly { usedPercent: number }[] {
  return codexLimitsOf(signIn.limitKey);
}

function weeklyWindow(
  signIn: CodexResetSignIn,
): { usedPercent: number; resetAt: number | null } | null {
  for (const limit of codexLimitsOf(signIn.limitKey)) {
    if (limit.windowMinutes === WEEKLY_WINDOW_MINUTES) {
      return { usedPercent: limit.usedPercent, resetAt: limit.resetAt };
    }
  }
  return null;
}

export interface CodexResetSchedulerOptions {
  providers: () => GatewayProvider[];
  config?: () => GatewayConfig;
  /** `$NEOLIX_HOME/gateway/codex-accounts.json`. */
  accountsFile: () => string;
  logger: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Tests read a store of their own; production uses the two sign-ins. */
  signIn?: CodexResetSignInResolver;
  /**
   * When a rest on the account ends (its cache key, `provider/account`),
   * null when it is awake — myna's `BackAt`. A rest that outlasts the
   * lead is why the reset is spent at once: nothing can be used while it
   * waits.
   */
  restUntil?: (key: string, now: number) => number | null;
}

/**
 * Spends the resets about to run out unused, myna's
 * KeepResetsFromRunningOut: every close interval, each account let spend
 * them by itself is looked at when its own next look is due
 * (codex-reset.ts nextResetLook).
 */
export class CodexResetScheduler {
  private readonly next = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: CodexResetSchedulerOptions) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, RESET_EXPIRY_CLOSE_MS);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private run(): Promise<void> {
    return this.tick().catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "Cannot read the Codex resets");
    });
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.spendExpiring();
    } finally {
      this.running = false;
    }
  }

  private async spendExpiring(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const leadMinutes = resetLeadMinutes(this.options.config?.().codexResetLead);
    // One account signed in twice (or two gateway accounts naming one
    // store account) is looked at once.
    const seen = new Set<string>();
    for (const provider of this.options.providers()) {
      if (!isProviderEnabled(provider) || familyOf(provider) !== "codex") {
        continue;
      }
      for (const account of providerAccounts(provider)) {
        if (account.enabled === false) {
          continue;
        }
        if (!autoResetWhen(account.autoReset).expiring) {
          continue;
        }
        const key = `${provider.id}/${account.id}`;
        const due = this.next.get(key);
        if (due !== undefined && now < due) {
          continue;
        }
        try {
          await this.lookAt(account, key, now, leadMinutes, seen);
        } catch (error) {
          this.options.logger.warn(
            { err: error, provider: provider.id, account: account.id },
            "Cannot manage the account's Codex resets",
          );
          this.next.set(key, now + RESET_EXPIRY_WATCH_MS);
        }
      }
    }
  }

  private async lookAt(
    account: GatewayAccount,
    key: string,
    now: number,
    leadMinutes: number,
    seen: Set<string>,
  ): Promise<void> {
    const signIn = await (this.options.signIn ?? resolveCodexResetSignIn)(account, {
      accountsFile: this.options.accountsFile(),
      now,
      fetchImpl: this.options.fetchImpl,
      ...(this.options.config === undefined
        ? {}
        : { discovery: accountDiscoveryOn(this.options.config()) }),
    });
    if (signIn === null) {
      this.next.set(key, now + RESET_EXPIRY_WATCH_MS);
      return;
    }
    if (seen.has(signIn.limitKey)) {
      this.next.set(key, now + RESET_EXPIRY_CLOSE_MS);
      return;
    }
    seen.add(signIn.limitKey);
    const credits = await readCodexResetCredits({
      signIn,
      fetchImpl: this.options.fetchImpl,
    });
    const until = credits.find((credit) => credit.expiresAt !== null)?.expiresAt ?? null;
    if (until === null) {
      this.next.set(key, now + RESET_EXPIRY_FAR_MS);
      return;
    }
    if (until <= now) {
      this.next.set(key, now + RESET_EXPIRY_CLOSE_MS);
      return;
    }
    const used = windowsOf(signIn).some((window) => window.usedPercent > 0);
    // A rest that outlasts the lead makes the reset worthless to wait for:
    // myna spends it at once then (expiringResetSpent's stopped/back).
    const back = this.options.restUntil?.(key, now) ?? null;
    const at = expiringResetSpent({
      until,
      now,
      stopped: back !== null,
      back,
      leadMinutes,
    });
    if (!used || at > now) {
      this.next.set(key, nextResetLook({ until, now, leadMinutes }));
      return;
    }
    const credit = credits.find((entry) => entry.expiresAt === until) ?? credits[0];
    if (credit === undefined) {
      this.next.set(key, now + RESET_EXPIRY_FAR_MS);
      return;
    }
    this.options.logger.info(
      {
        account: account.id,
        limitKey: signIn.limitKey,
        credit: credit.id,
        expiresAt: until,
      },
      "Spending a Codex reset about to run out",
    );
    const outcome = await consumeCodexReset({
      signIn,
      creditId: credit.id,
      fetchImpl: this.options.fetchImpl,
    });
    this.options.logger.info(
      {
        account: account.id,
        limitKey: signIn.limitKey,
        credit: credit.id,
        code: outcome.code,
        windows: outcome.windows,
      },
      outcome.code === "reset"
        ? "Spent a Codex reset about to run out"
        : "A Codex reset about to run out was not spent",
    );
    this.next.set(key, now + RESET_EXPIRY_CLOSE_MS);
  }
}

/** What a week's spend did, for the routing layer that asks for one. */
export interface CodexWeekResetResult {
  spent: boolean;
  /** myna's word: reset, no_credit, already_redeemed, or why it was not asked. */
  code: string;
}

/**
 * Spends a reset because an account's week is used up, myna's
 * AutoUseCodexReset: only for an account let spend one then, its weekly
 * window full, and one spend a week — the same weekly reset is never
 * spent twice, even before a fresh reading says the week started again.
 *
 * The gateway calls this when every candidate it could route to is out of
 * its allowance; the caller decides which account, this decides whether.
 */
export class CodexWeekReset {
  private readonly spent = new Map<string, number>();

  constructor(
    private readonly options: {
      accountsFile: () => string;
      logger: Logger;
      now?: () => number;
      fetchImpl?: typeof fetch;
      signIn?: CodexResetSignInResolver;
      /** The gateway's config, for whether Codex's own sign-in may be read. */
      config?: () => GatewayConfig;
    },
  ) {}

  async spend(account: GatewayAccount): Promise<CodexWeekResetResult> {
    if (!autoResetWhen(account.autoReset).week) {
      return { spent: false, code: "not_allowed" };
    }
    const now = (this.options.now ?? Date.now)();
    const signIn = await (this.options.signIn ?? resolveCodexResetSignIn)(account, {
      accountsFile: this.options.accountsFile(),
      now,
      fetchImpl: this.options.fetchImpl,
      ...(this.options.config === undefined
        ? {}
        : { discovery: accountDiscoveryOn(this.options.config()) }),
    });
    if (signIn === null) {
      return { spent: false, code: "no_sign_in" };
    }
    const week = weeklyWindow(signIn);
    if (week === null || week.usedPercent < 100 || week.resetAt === null || week.resetAt <= now) {
      return { spent: false, code: "week_not_used_up" };
    }
    const key = `${signIn.limitKey}|${week.resetAt}`;
    if (this.spent.has(key)) {
      return { spent: false, code: "already_spent" };
    }
    const credits = await readCodexResetCredits({
      signIn,
      fetchImpl: this.options.fetchImpl,
    });
    const credit = credits[0];
    if (credit === undefined) {
      return { spent: false, code: "no_credit" };
    }
    this.options.logger.info(
      { limitKey: signIn.limitKey, credit: credit.id, weekResetAt: week.resetAt },
      "Spending a Codex reset for a used-up week",
    );
    let outcome: CodexResetOutcome;
    try {
      outcome = await consumeCodexReset({
        signIn,
        creditId: credit.id,
        fetchImpl: this.options.fetchImpl,
      });
    } catch (error) {
      // No second credit is tried: myna gives up for this look too.
      this.options.logger.warn({ err: error, limitKey: signIn.limitKey }, "Codex reset not spent");
      return { spent: false, code: "error" };
    }
    if (outcome.code === "reset") {
      this.spent.set(key, now);
    }
    this.options.logger.info(
      {
        limitKey: signIn.limitKey,
        credit: credit.id,
        code: outcome.code,
        windows: outcome.windows,
      },
      outcome.code === "reset"
        ? "Spent a Codex reset for a used-up week"
        : "A Codex reset for a used-up week was not spent",
    );
    return { spent: outcome.code === "reset", code: outcome.code };
  }
}

export interface CodexResetSpendResult {
  spent: boolean;
  /** myna's word: reset, nothing_to_reset, no_credit, already_redeemed, or why not. */
  code: string;
  windows: number;
  /** Whose reset it was, for the CLI's line. */
  accountLabel: string;
}

function resetAccountNamed(
  config: GatewayConfig,
  name: string | undefined,
): { account: GatewayAccount; label: string } | null {
  if (name === undefined || name.trim().toLowerCase() === "codex-own") {
    // Codex's own sign-in, myna's "the one Codex is signed in to".
    return { account: { id: "codex-own" } as GatewayAccount, label: "the Codex account" };
  }
  const wanted = name.trim().toLowerCase();
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    for (const account of providerAccounts(provider)) {
      if (account.codexAccountId === undefined) {
        continue;
      }
      const names = [account.id, account.label ?? "", account.codexAccountId];
      if (names.some((candidate) => candidate.toLowerCase() === wanted)) {
        return { account, label: account.label ?? account.codexAccountId };
      }
    }
  }
  return null;
}

/**
 * Spends one reset by hand, myna's UseCodexResetCard: the one that runs out
 * first unless `card` names the nth. It cannot be undone, so the caller
 * confirms; the daemon re-checks `confirm` before calling this.
 */
export async function spendCodexReset(input: {
  config: GatewayConfig;
  accountsFile: string;
  account?: string;
  card?: number;
  now?: number;
  fetchImpl?: typeof fetch;
  logger: Logger;
  signIn?: CodexResetSignInResolver;
}): Promise<CodexResetSpendResult> {
  const named = resetAccountNamed(input.config, input.account);
  if (named === null) {
    return { spent: false, code: "no_account", windows: 0, accountLabel: input.account ?? "" };
  }
  const now = input.now ?? Date.now();
  const signIn = await (input.signIn ?? resolveCodexResetSignIn)(named.account, {
    accountsFile: input.accountsFile,
    now,
    fetchImpl: input.fetchImpl,
    discovery: accountDiscoveryOn(input.config),
  });
  if (signIn === null) {
    return { spent: false, code: "no_sign_in", windows: 0, accountLabel: named.label };
  }
  let credits: CodexResetCredit[];
  try {
    credits = await readCodexResetCredits({ signIn, fetchImpl: input.fetchImpl });
  } catch (error) {
    input.logger.warn({ err: error, limitKey: signIn.limitKey }, "Codex resets cannot be read");
    return { spent: false, code: "error", windows: 0, accountLabel: named.label };
  }
  const card = input.card ?? 1;
  const credit = credits[card - 1];
  if (credit === undefined) {
    return {
      spent: false,
      code: credits.length === 0 ? "no_credit" : "card_out_of_range",
      windows: 0,
      accountLabel: named.label,
    };
  }
  input.logger.info(
    { limitKey: signIn.limitKey, credit: credit.id, card, expiresAt: credit.expiresAt },
    "Spending a Codex reset by hand",
  );
  let outcome: CodexResetOutcome;
  try {
    outcome = await consumeCodexReset({
      signIn,
      creditId: credit.id,
      fetchImpl: input.fetchImpl,
    });
  } catch (error) {
    // No second credit is tried, as myna: the spend may already have happened.
    input.logger.warn({ err: error, limitKey: signIn.limitKey }, "Codex reset not spent");
    return { spent: false, code: "error", windows: 0, accountLabel: named.label };
  }
  input.logger.info(
    {
      limitKey: signIn.limitKey,
      credit: credit.id,
      card,
      code: outcome.code,
      windows: outcome.windows,
    },
    outcome.code === "reset" ? "Spent a Codex reset by hand" : "A Codex reset was not spent",
  );
  return {
    spent: outcome.code === "reset",
    code: outcome.code,
    windows: outcome.windows,
    accountLabel: named.label,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
