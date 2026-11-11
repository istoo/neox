import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  addCodexAccount,
  loadCodexAccounts,
  refreshCodexTokens,
  saveCodexAccounts,
  type CodexOwnedAccount,
} from "./codex-accounts.js";

/**
 * ChatGPT sign-ins imported from files another app keeps, as myna's
 * `provider.ImportLogins` reads them (`internal/provider/login_import.go:77`):
 * Codex CLI's own `auth.json` (`tokens.{access_token,refresh_token,id_token}`),
 * and CLIProxyAPI's auth files (`access_token`, `refresh_token`, `id_token`,
 * `account_id`, `email`, flat or under `tokens`). Only sign-ins that carry a
 * refresh token are kept: myna renews them, and one without cannot be.
 */
export interface CodexImportResult {
  added: number;
  updated: number;
  failed: { file: string; error: string }[];
}

interface ParsedLogin {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  email: string | null;
}

interface FoundLogin extends ParsedLogin {
  /** Where it came from, for the answer. */
  source: string;
}

export interface CodexImportOptions {
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  /**
   * Spends each sign-in's refresh token before keeping it, as myna's import
   * does (`login_import.go:521-531`). The source file is only read: the
   * tool it came from is signed out, myna's stated price of importing.
   * Tests turn it off unless they inject a fetch.
   */
  refresh?: boolean;
  /**
   * The `CODEX_HOME` an imported copy came from (the `fromCodex` import).
   * Kept on each account, so a switch can tell that Codex there still holds
   * it and refuse to make the same refresh token serve two holders.
   */
  home?: string;
}

/** myna's words for a refresh token another tool has spent. */
const REFRESH_REFUSED =
  "ChatGPT didn't take the refresh token — it has been used since (by the tool it came from, " +
  "which refreshes it), expired or signed out";

export async function importCodexAccounts(
  files: readonly string[],
  accountsFile: string,
  options: CodexImportOptions = {},
): Promise<CodexImportResult> {
  const found: FoundLogin[] = [];
  const failed: CodexImportResult["failed"] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      failed.push({ file, error: "could not be read" });
      continue;
    }
    const logins = withSource(loginsIn(text), file);
    if (logins.length === 0) {
      failed.push({ file, error: "no ChatGPT sign-in in it" });
      continue;
    }
    found.push(...logins);
  }
  return mergeCodexAccounts(found, accountsFile, failed, options);
}

/** Pasted JSON, as myna's import box takes it instead of a file. */
export async function importCodexAccountsFromText(
  text: string,
  accountsFile: string,
  options: CodexImportOptions = {},
): Promise<CodexImportResult> {
  const logins = withSource(loginsIn(text), "pasted");
  if (logins.length === 0) {
    return {
      added: 0,
      updated: 0,
      failed: [{ file: "pasted", error: "no ChatGPT sign-in in it" }],
    };
  }
  return mergeCodexAccounts(logins, accountsFile, [], options);
}

async function mergeCodexAccounts(
  found: readonly FoundLogin[],
  accountsFile: string,
  failed: CodexImportResult["failed"],
  options: CodexImportOptions,
): Promise<CodexImportResult> {
  const kept: CodexOwnedAccount[] = [...(await loadCodexAccounts(accountsFile))];
  let added = 0;
  let updated = 0;
  for (const login of found) {
    const refreshed = await refreshedLogin(login, options);
    if (refreshed === null) {
      failed.push({ file: login.source, error: REFRESH_REFUSED });
      continue;
    }
    const account = ownedOf(refreshed, options.home);
    const existed = kept.some((entry) => sameAccount(entry, account));
    const next = addCodexAccount(kept, account);
    kept.length = 0;
    kept.push(...next);
    if (existed) {
      updated += 1;
    } else {
      added += 1;
    }
  }
  if (added + updated > 0) {
    await saveCodexAccounts(accountsFile, kept);
  }
  return { added, updated, failed };
}

/** The sign-in after the refresh myna makes on the way in. */
async function refreshedLogin(
  login: FoundLogin,
  options: CodexImportOptions,
): Promise<FoundLogin | null> {
  if (options.refresh === false) {
    return login;
  }
  const tokens = await refreshCodexTokens(login.refreshToken, options);
  if (tokens === null) {
    return null;
  }
  return {
    ...login,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken ?? login.idToken,
  };
}

function sameAccount(left: CodexOwnedAccount, right: CodexOwnedAccount): boolean {
  if (left.accountId !== null && right.accountId !== null) {
    return left.accountId === right.accountId;
  }
  return (
    left.refreshToken !== null &&
    right.refreshToken !== null &&
    left.refreshToken === right.refreshToken
  );
}

function ownedOf(login: ParsedLogin, home?: string): CodexOwnedAccount {
  const claims = claimsOf(login.idToken ?? "");
  const plan = nestedString(claims, "https://api.openai.com/auth", "chatgpt_plan_type");
  // Files do not always carry account_id; the id token does (myna's
  // `account.go:1184` falls back the same way).
  const accountId =
    login.accountId ?? nestedString(claims, "https://api.openai.com/auth", "chatgpt_account_id");
  const email =
    login.email !== null && login.email.length > 0 ? login.email : stringClaim(claims.email);
  return {
    id: accountId === null ? `neolix:${randomUUID()}` : `neolix:${accountId}`,
    label: withPlan(email.length > 0 ? email : "ChatGPT", plan),
    plan,
    accountId,
    accessToken: login.accessToken,
    refreshToken: login.refreshToken,
    idToken: login.idToken,
    expiresAt: expOf(login.accessToken),
    addedAt: Date.now(),
    ...(home === undefined || home === "" ? {} : { home }),
  };
}

/** Ties each parsed sign-in to where it came from. */
function withSource(logins: readonly ParsedLogin[], source: string): FoundLogin[] {
  const out: FoundLogin[] = [];
  for (const login of logins) {
    out.push({ ...login, source });
  }
  return out;
}

/** Every sign-in object in a file, whichever app wrote it. */
function loginsIn(text: string): ParsedLogin[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, "").trim());
  } catch {
    return [];
  }
  const found: ParsedLogin[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        walk(entry);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const login = loginOf(node);
    if (login !== null) {
      found.push(login);
      return;
    }
    for (const entry of Object.values(node)) {
      walk(entry);
    }
  };
  walk(value);
  return found;
}

function loginOf(node: Record<string, unknown>): ParsedLogin | null {
  const tokens = isRecord(node.tokens) ? node.tokens : node;
  const accessToken = firstString(tokens, ["access_token", "accessToken"]);
  const refreshToken = firstString(tokens, ["refresh_token", "refreshToken"]);
  if (accessToken === null || refreshToken === null) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    idToken: firstString(tokens, ["id_token", "idToken"]),
    accountId: firstString(tokens, ["account_id", "accountId"]),
    email: firstString(node, ["email", "Email"]),
  };
}

function firstString(node: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = node[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function claimsOf(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1] === undefined) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function expOf(token: string): number | null {
  const exp = claimsOf(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

function nestedString(
  claims: Record<string, unknown>,
  section: string,
  name: string,
): string | null {
  const nested = claims[section];
  if (!isRecord(nested)) {
    return null;
  }
  const value = nested[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function withPlan(email: string, plan: string | null): string {
  if (plan !== "team" && plan !== "business" && plan !== "enterprise" && plan !== "edu") {
    return email;
  }
  return `${email} · ${plan.slice(0, 1).toUpperCase()}${plan.slice(1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
