import { randomUUID } from "node:crypto";
import {
  addCodexAccount,
  arrangeCodexAccounts,
  loadCodexAccounts,
  redactedCodexAccounts,
  removeCodexAccount,
  saveCodexAccounts,
  setCodexAccountEnabled,
  type CodexOwnedAccount,
  type CodexOwnedAccountStatus,
} from "./codex-accounts.js";
import {
  pollCodexDeviceSignIn,
  startCodexDeviceSignIn,
  type CodexDeviceStart,
  type CodexDeviceTokens,
  type CodexSignInOptions,
} from "./codex-signin.js";

/**
 * A Neolix-signed-in ChatGPT account being added: the device code is shown,
 * the page asks once whether it was entered, and the tokens then go into
 * Neolix's own store, never into `~/.codex` (myna's sign-in flow saves into
 * its own logins.json the same way).
 */
interface PendingLogin {
  start: CodexDeviceStart;
  startedAt: number;
}

const pending = new Map<string, PendingLogin>();

/** How long a device code is waited on, as Codex waits: 15 minutes. */
const LOGIN_WAIT_MS = 15 * 60_000;
const MAX_PENDING = 8;

export interface CodexLoginStart {
  loginId: string;
  url: string;
  userCode: string;
  intervalMs: number;
}

export interface CodexLoginPoll {
  state: "waiting" | "done" | "error";
  account?: CodexOwnedAccountStatus;
  error?: string;
}

/** Asks for a device code; the page shows the code and link until polled. */
export async function beginCodexLogin(
  options: CodexSignInOptions = {},
): Promise<{ start: CodexLoginStart } | { error: string }> {
  const result = await startCodexDeviceSignIn(options);
  if ("error" in result) {
    return result;
  }
  const now = Date.now();
  for (const [id, login] of pending) {
    if (now - login.startedAt > LOGIN_WAIT_MS) {
      pending.delete(id);
    }
  }
  if (pending.size >= MAX_PENDING) {
    return { error: "Too many sign-ins are waiting; finish or wait for one to expire" };
  }
  const loginId = randomUUID();
  pending.set(loginId, { start: result.start, startedAt: now });
  return {
    start: {
      loginId,
      url: result.start.url,
      userCode: result.start.userCode,
      intervalMs: result.start.intervalMs,
    },
  };
}

/** Asks once whether the code was entered; on success the account is saved. */
export async function pollCodexLogin(
  loginId: string,
  accountsFile: string,
  options: CodexSignInOptions = {},
): Promise<CodexLoginPoll> {
  const login = pending.get(loginId);
  if (login === undefined) {
    return { state: "error", error: "This sign-in is no longer waiting; start again" };
  }
  if (Date.now() - login.startedAt > LOGIN_WAIT_MS) {
    pending.delete(loginId);
    return { state: "error", error: "The code expired; start again" };
  }
  const poll = await pollCodexDeviceSignIn(login.start, options);
  if (poll.state === "waiting") {
    return { state: "waiting" };
  }
  if (poll.state === "error") {
    return poll;
  }
  pending.delete(loginId);
  return saveCodexSignInTokens(poll.tokens, accountsFile);
}

/** Keeps a finished sign-in as an account; the browser flow lands here too. */
export async function saveCodexSignInTokens(
  tokens: CodexDeviceTokens,
  accountsFile: string,
): Promise<CodexLoginPoll> {
  const account = ownedAccountOf(tokens);
  const saved = addCodexAccount(await loadCodexAccounts(accountsFile), account);
  await saveCodexAccounts(accountsFile, saved);
  return { state: "done", account: redact(account) };
}

/** Forgets every pending sign-in; tests use it between cases. */
export function clearCodexLogins(): void {
  pending.clear();
}

/** Stops a waiting sign-in; false when it was not waiting. */
export function cancelCodexLogin(loginId: string): boolean {
  return pending.delete(loginId);
}

export async function removeOwnedCodexAccount(accountsFile: string, id: string): Promise<void> {
  await saveCodexAccounts(
    accountsFile,
    removeCodexAccount(await loadCodexAccounts(accountsFile), id),
  );
}

/** The user's order is the routing order (`provider/account_order.go:5-8`). */
export async function arrangeOwnedCodexAccounts(
  accountsFile: string,
  order: readonly string[],
): Promise<void> {
  await saveCodexAccounts(
    accountsFile,
    arrangeCodexAccounts(await loadCodexAccounts(accountsFile), order),
  );
}

/** Switches one off or on, as myna's `login/off` and `login/on` do. */
export async function setOwnedCodexAccountEnabled(
  accountsFile: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const accounts = await loadCodexAccounts(accountsFile);
  await saveCodexAccounts(accountsFile, setCodexAccountEnabled(accounts, id, enabled));
}

/** The account Neolix keeps for a sign-in, named as myna names a ChatGPT account. */
function ownedAccountOf(tokens: CodexDeviceTokens): CodexOwnedAccount {
  const claims = claimsOf(tokens.idToken ?? "");
  const plan = nestedString(claims, "https://api.openai.com/auth", "chatgpt_plan_type");
  const email = typeof claims.email === "string" ? claims.email : "";
  return {
    id: tokens.accountId === null ? `neolix:${randomUUID()}` : `neolix:${tokens.accountId}`,
    label: withPlan(email.length > 0 ? email : "ChatGPT", plan),
    plan,
    accountId: tokens.accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    expiresAt: expOf(tokens.accessToken),
    addedAt: Date.now(),
  };
}

function redact(account: CodexOwnedAccount): CodexOwnedAccountStatus {
  const [status] = redactedCodexAccounts([account]);
  if (status === undefined) {
    throw new Error("an account did not redact");
  }
  return status;
}

function claimsOf(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nestedString(
  claims: Record<string, unknown>,
  section: string,
  name: string,
): string | null {
  const nested = claims[section];
  if (typeof nested !== "object" || nested === null) {
    return null;
  }
  const value = (nested as Record<string, unknown>)[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function expOf(token: string): number | null {
  const exp = claimsOf(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function withPlan(email: string, plan: string | null): string {
  if (plan !== "team" && plan !== "business" && plan !== "enterprise" && plan !== "edu") {
    return email;
  }
  return `${email} · ${plan.slice(0, 1).toUpperCase()}${plan.slice(1)}`;
}
