import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidJson, keepLastGood, readLastGood } from "../last-good.js";
import { codexLimitsOf, type CodexLimit } from "./codex-limits.js";
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from "./codex-user-data.js";

/**
 * ChatGPT accounts Neolix signed in itself (`codex-signin.ts`), kept apart
 * from `~/.codex`: their tokens live in `$NEOLIX_HOME/gateway/codex-accounts.json`
 * (0600), never in Codex's own file. The account Codex itself is signed in
 * to is discovered, not stored here.
 */
export interface CodexOwnedAccount {
  id: string;
  label: string;
  plan: string | null;
  accountId: string | null;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch ms; null when the token says nothing. */
  expiresAt: number | null;
  addedAt: number;
  /** Switched off (`login/off` in myna): kept, never routed. */
  disabled?: boolean;
  /**
   * The `CODEX_HOME` this sign-in was imported from, when it was one of the
   * user's own Codex folders. Switching to it is refused while that folder
   * still holds it (myna's `Home`, `provider/logins.go:812-824`).
   */
  home?: string;
}

/** What the page may see: never a token. */
export interface CodexOwnedAccountStatus {
  id: string;
  label: string;
  plan: string | null;
  accountId: string | null;
  expiresAt: number | null;
  addedAt: number;
  disabled: boolean;
}

export async function loadCodexAccounts(file: string): Promise<CodexOwnedAccount[]> {
  let text: string;
  try {
    // A store zeroed by a crash mid-write reads back from its .bak.
    text = (await readLastGood(file, isValidJson)).toString("utf8");
  } catch {
    return [];
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(isAccount);
  } catch {
    return [];
  }
}

/** Replaces the file in one step, 0600, so a half-written store is never read. */
export async function saveCodexAccounts(
  file: string,
  accounts: readonly CodexOwnedAccount[],
): Promise<void> {
  const temp = join(dirname(file), `.codex-accounts.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(file), { recursive: true });
  await keepLastGood(file, isValidJson);
  await writeFile(temp, JSON.stringify(accounts), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export function redactedCodexAccounts(
  accounts: readonly CodexOwnedAccount[],
): CodexOwnedAccountStatus[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.label,
    plan: account.plan,
    accountId: account.accountId,
    expiresAt: account.expiresAt,
    addedAt: account.addedAt,
    disabled: account.disabled === true,
  }));
}

/** Adds an account, replacing one with the same ChatGPT account id. */
export function addCodexAccount(
  accounts: readonly CodexOwnedAccount[],
  account: CodexOwnedAccount,
): CodexOwnedAccount[] {
  const same = (entry: CodexOwnedAccount): boolean =>
    entry.id === account.id ||
    (account.accountId !== null && entry.accountId === account.accountId);
  return [...accounts.filter((entry) => !same(entry)), account];
}

export function removeCodexAccount(
  accounts: readonly CodexOwnedAccount[],
  id: string,
): CodexOwnedAccount[] {
  return accounts.filter((entry) => entry.id !== id);
}

/** Whether a token has run out; a token that says nothing counts as usable. */
export function codexAccountUsable(account: CodexOwnedAccount, now: number): boolean {
  return account.disabled !== true && (account.expiresAt === null || account.expiresAt > now);
}

/**
 * The order the user set (`provider/arrange` in myna): the ids given come
 * first in that order, the rest keep the order they had. Unknown ids are
 * dropped.
 */
export function arrangeCodexAccounts(
  accounts: readonly CodexOwnedAccount[],
  order: readonly string[],
): CodexOwnedAccount[] {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const next: CodexOwnedAccount[] = [];
  for (const id of order) {
    const account = byId.get(id);
    if (account !== undefined) {
      next.push(account);
      byId.delete(id);
    }
  }
  return [...next, ...accounts.filter((account) => byId.has(account.id))];
}

/** Switches an account off or back on, keeping its place in the order. */
export function setCodexAccountEnabled(
  accounts: readonly CodexOwnedAccount[],
  id: string,
  enabled: boolean,
): CodexOwnedAccount[] {
  return accounts.map((account) =>
    account.id === id ? { ...account, disabled: !enabled } : account,
  );
}

/** A window whose allowance is spent and has not reset yet rests the account. */
export function codexAccountResting(limits: readonly CodexLimit[], now: number): boolean {
  return limits.some(
    (limit) => limit.usedPercent >= 100 && (limit.resetAt === null || limit.resetAt > now),
  );
}

/**
 * The first account that can answer, in the order the accounts are kept.
 * This is how myna's routing treats ChatGPT accounts between rests:
 * `provider/account_order.go:5-8` (the order the user set is the order
 * routing uses; a switched-off account is never silently used),
 * `provider/left_alone.go:19` (off or removed accounts are left alone),
 * `gateway/routing.go:2131` (the provider's routing strategy orders the
 * candidates), and the rest tables that skip a spent window. Myna's
 * default strategy is Smart, whose quota handoff is the gateway's
 * business (Neolix's `smart` in routing.ts), not this module's;
 * `provider/concurrency.go:36-64` MaxAccounts is a concurrency cap and
 * `provider/keepalive.go:1-30` reserve is keeping unused sign-ins alive,
 * neither of which picks an account for a request.
 */
export function selectCodexAccount(
  accounts: readonly CodexOwnedAccount[],
  limitsOf: (account: CodexOwnedAccount) => readonly CodexLimit[],
  now: number,
): CodexOwnedAccount | null {
  for (const account of accounts) {
    if (codexAccountUsable(account, now) && !codexAccountResting(limitsOf(account), now)) {
      return account;
    }
  }
  return null;
}

/** Refreshed this long before a token runs out, as Codex's own sign-in is. */
const RENEW_MARGIN_MS = 5 * 60_000;

export interface PooledSignIn {
  accessToken: string;
  accountId: string | null;
  /** The key its windows are kept under (`codexLimitsOf`). */
  limitKey: string;
  expiresAt: number | null;
}

export interface PoolOptions {
  accountsFile: string;
  /** Whether a renewed token may be written back to Neolix's store. */
  writeBack: boolean;
  /**
   * Renews the chosen account now, not only near its expiry: myna's
   * `renewSavedLoginFrom` after a 401 (`provider/account.go:1072-1115`).
   * Without write-back a renewal is never made, so the account is skipped.
   */
  force?: boolean;
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  now?: number;
}

/**
 * A ChatGPT account Neolix signed in itself that can answer now, its token
 * refreshed and saved when it is about to run out. Null when the pool has
 * none that can: no accounts, all resting, or expired with write-back off.
 */
export async function pooledCodexSignIn(options: PoolOptions): Promise<PooledSignIn | null> {
  const now = options.now ?? Date.now();
  const accounts = await loadCodexAccounts(options.accountsFile);
  for (const account of accounts) {
    if (account.disabled === true) {
      continue;
    }
    if (codexAccountResting(codexLimitsOf(account.id), now)) {
      continue;
    }
    const fresh = await freshen(account, accounts, options, now);
    if (fresh !== null) {
      return {
        accessToken: fresh.accessToken,
        accountId: fresh.accountId,
        limitKey: fresh.id,
        expiresAt: fresh.expiresAt,
      };
    }
  }
  return null;
}

/**
 * One pooled account's sign-in by its store id, its token refreshed and
 * saved when it is about to run out — for work aimed at that account
 * rather than at whichever can answer a request (the reset scheduler
 * reads and spends its resets).
 */
export async function codexAccountSignIn(
  options: PoolOptions & { id: string },
): Promise<PooledSignIn | null> {
  const now = options.now ?? Date.now();
  const accounts = await loadCodexAccounts(options.accountsFile);
  const account = accounts.find((entry) => entry.id === options.id);
  if (account === undefined || account.disabled === true) {
    return null;
  }
  const fresh = await freshen(account, accounts, options, now);
  return fresh === null
    ? null
    : {
        accessToken: fresh.accessToken,
        accountId: fresh.accountId,
        limitKey: fresh.id,
        expiresAt: fresh.expiresAt,
      };
}

async function freshen(
  account: CodexOwnedAccount,
  accounts: readonly CodexOwnedAccount[],
  options: PoolOptions,
  now: number,
): Promise<CodexOwnedAccount | null> {
  const due = account.expiresAt === null || account.expiresAt <= now + RENEW_MARGIN_MS;
  if (!due && options.force !== true) {
    return account;
  }
  if (!options.writeBack) {
    return null;
  }
  const refreshed = await refreshOwnedAccount(account, options, now);
  if (refreshed === null) {
    return null;
  }
  await saveCodexAccounts(options.accountsFile, addCodexAccount(accounts, refreshed));
  return refreshed;
}

async function refreshOwnedAccount(
  account: CodexOwnedAccount,
  options: PoolOptions,
  now: number,
): Promise<CodexOwnedAccount | null> {
  if (account.refreshToken === null) {
    return null;
  }
  const tokens = await refreshCodexTokens(account.refreshToken, options);
  if (tokens === null) {
    return null;
  }
  return {
    ...account,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken ?? account.idToken,
    expiresAt: tokens.expiresAt ?? now + 3_600_000,
  };
}

/** What a refresh answers; the tokens the vendor minted, never written to a source file. */
export interface RefreshedCodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
}

/**
 * Spends a refresh token for another set of tokens, as myna's import does
 * (`provider/login_import.go:521-531`): the source file is only read, and
 * the tool it came from is signed out of the account, as myna says it is.
 */
export async function refreshCodexTokens(
  refreshToken: string,
  options: { fetchImpl?: typeof fetch; tokenUrl?: string } = {},
): Promise<RefreshedCodexTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  });
  let answer: Response;
  try {
    answer = await (options.fetchImpl ?? fetch)(options.tokenUrl ?? CODEX_TOKEN_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return null;
  }
  if (!answer.ok) {
    return null;
  }
  let tokens: unknown;
  try {
    tokens = await answer.json();
  } catch {
    return null;
  }
  if (!isRecord(tokens) || typeof tokens.access_token !== "string") {
    return null;
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : refreshToken,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : null,
    expiresAt: expOf(tokens.access_token),
  };
}

function expOf(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) {
    return null;
  }
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!isRecord(claims)) {
      return null;
    }
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAccount(value: unknown): value is CodexOwnedAccount {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.label === "string" &&
    typeof entry.accessToken === "string" &&
    typeof entry.addedAt === "number"
  );
}
