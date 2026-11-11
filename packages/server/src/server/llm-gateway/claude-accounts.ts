import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Claude Code's sign-in, kept the way Neolix keeps a subscription account
 * (`provider/logins.go`'s claude branch): the whole `.credentials.json`
 * blob, so a write-back keeps MCP OAuth state and anything else the file
 * carries. Reading is always allowed; writing it back into Claude Code's
 * own store is the "Claude subscription bridge" the user hasn't decided
 * yet, and is behind `claudeSignInWriteBack` (default off).
 */

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** One Claude account: the file's OAuth part, parsed out. */
export interface ClaudeAccount {
  id: string;
  user: string;
  plan: string | null;
  addedAt: number;
  lapsed: string | null;
  alias?: string;
  /** The whole credentials file, as imported; write-back preserves the rest. */
  credentials: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, from the file's `expiresAt`. */
  expiresAt: number;
  subscriptionType: string | null;
}

/** What Neolix may show of a Claude account: never a token. */
export interface ClaudeAccountStatus {
  id: string;
  user: string;
  plan: string | null;
  addedAt: number;
  lapsed: string | null;
  alias?: string;
  expiresAt: number;
}

export interface ClaudeOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Claude Code's credentials file; `~/.claude/.credentials.json` by default. */
  credentialsPath?: string;
  /** Claude Code's profile file; `~/.claude.json` by default. */
  profilePath?: string;
  /** Reads the macOS keychain item; tests inject theirs. */
  readKeychain?: (service: string) => Promise<string | null>;
  /** Writes the macOS keychain item; tests inject theirs. */
  writeKeychain?: (service: string, secret: string) => Promise<void>;
  now?: number;
}

export function claudeAccountsFile(gatewayDir: string): string {
  return join(gatewayDir, "claude-accounts.json");
}

export function claudeCredentialsPath(options: ClaudeOptions = {}): string {
  const home = claudeHome(options);
  return options.credentialsPath ?? join(home, ".claude", ".credentials.json");
}

function claudeHome(options: ClaudeOptions): string {
  const env = options.env ?? process.env;
  return options.homeDir ?? env.HOME ?? homedir();
}

export async function loadClaudeAccounts(file: string): Promise<ClaudeAccount[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
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

/** Replaces the store in one step, 0600, so a half-written file is never read. */
export async function saveClaudeAccounts(
  file: string,
  accounts: readonly ClaudeAccount[],
): Promise<void> {
  const temp = join(dirname(file), `.claude-accounts.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(accounts), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export function redactedClaudeAccounts(accounts: readonly ClaudeAccount[]): ClaudeAccountStatus[] {
  return accounts.map((account) => ({
    id: account.id,
    user: account.user,
    plan: account.plan,
    addedAt: account.addedAt,
    lapsed: account.lapsed,
    expiresAt: account.expiresAt,
    ...(account.alias === undefined ? {} : { alias: account.alias }),
  }));
}

/**
 * The sign-in Claude Code keeps now: its credentials file, else the macOS
 * keychain item (`Claude Code-credentials`). Nothing is written.
 */
export async function readClaudeSignIn(
  options: ClaudeOptions = {},
): Promise<{ credentials: string; store: "file" | "keychain" } | { error: string }> {
  try {
    const credentials = await readFile(claudeCredentialsPath(options), "utf8");
    if (credentials.trim() !== "") {
      return { credentials, store: "file" };
    }
  } catch {
    // No file, or one that can't be read: the keychain may still have it.
  }
  const reader = options.readKeychain ?? defaultKeychainReader;
  try {
    const credentials = await reader(CLAUDE_KEYCHAIN_SERVICE);
    if (credentials !== null && credentials.trim() !== "") {
      return { credentials, store: "keychain" };
    }
  } catch {
    // A denied keychain read is "no sign-in" here; nothing was changed.
  }
  return { error: "Claude Code isn't signed in on this computer" };
}

/**
 * Writes a sign-in where Claude Code keeps it: the keychain item when that
 * is where it was read from, else its credentials file. The caller has
 * already checked `claudeSignInWriteBack`.
 */
export async function writeClaudeSignIn(
  credentials: string,
  store: "file" | "keychain",
  options: ClaudeOptions = {},
): Promise<{ store: "file" | "keychain" } | { error: string }> {
  if (store === "keychain") {
    const writer = options.writeKeychain ?? defaultKeychainWriter;
    try {
      await writer(CLAUDE_KEYCHAIN_SERVICE, credentials);
      return { store: "keychain" };
    } catch (error) {
      return {
        error: `Claude Code's keychain item could not be written: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  const path = claudeCredentialsPath(options);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, credentials, { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    return {
      error: `Claude Code's credentials file could not be written: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { store: "file" };
}

/**
 * Every Claude sign-in in a file another tool exported (`claudeAuth` in
 * `provider/logins.go`): `.credentials.json`, a claude-swap export, and
 * CLIProxyAPI's auth files. Only shapes carrying an access token are taken.
 */
export function parseClaudeImport(text: string, now = Date.now()): ClaudeAccount[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^﻿/, "").trim());
  } catch {
    return [];
  }
  const found: { credentials: string; auth: ClaudeOAuth; email: string | null }[] = [];
  walkClaude(value, found);
  const out: ClaudeAccount[] = [];
  for (const entry of found) {
    out.push(accountOf(entry.credentials, entry.auth, entry.email, now));
  }
  return out;
}

interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
}

function walkClaude(
  node: unknown,
  out: { credentials: string; auth: ClaudeOAuth; email: string | null }[],
): void {
  if (Array.isArray(node)) {
    for (const entry of node) {
      walkClaude(entry, out);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const auth = claudeOAuthOf(node);
  if (auth !== null) {
    out.push({
      credentials: JSON.stringify(isRecord(node.claudeAiOauth) ? node : { claudeAiOauth: node }),
      auth,
      email: firstString(node, ["email", "emailAddress"]),
    });
    return;
  }
  for (const entry of Object.values(node)) {
    walkClaude(entry, out);
  }
}

function claudeOAuthOf(node: Record<string, unknown>): ClaudeOAuth | null {
  const oauth = isRecord(node.claudeAiOauth) ? node.claudeAiOauth : node;
  const accessToken = firstString(oauth, ["accessToken", "access_token"]);
  const refreshToken = firstString(oauth, ["refreshToken", "refresh_token"]) ?? "";
  if (accessToken === null) {
    return null;
  }
  const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
  const scopes = Array.isArray(oauth.scopes)
    ? oauth.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  const subscriptionType = firstString(oauth, ["subscriptionType", "subscription_type"]);
  return { accessToken, refreshToken, expiresAt, scopes, subscriptionType };
}

function accountOf(
  credentials: string,
  auth: ClaudeOAuth,
  email: string | null,
  now: number,
): ClaudeAccount {
  const user = email ?? claudeUserName(auth);
  const name = `${auth.subscriptionType ?? ""}\u0000${user}\u0000${auth.refreshToken || auth.accessToken}`;
  return {
    id: `claude:${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
    user,
    plan: auth.subscriptionType,
    addedAt: now,
    lapsed: null,
    credentials,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAt: auth.expiresAt,
    subscriptionType: auth.subscriptionType,
  };
}

/** The account's name: the profile's email when there is one, else its plan. */
function claudeUserName(auth: ClaudeOAuth): string {
  if (auth.subscriptionType !== null && auth.subscriptionType !== "") {
    return `Claude ${auth.subscriptionType}`;
  }
  return "Claude";
}

/** The profile's email, when `~/.claude.json` names the signed-in account. */
export async function claudeProfileEmail(options: ClaudeOptions = {}): Promise<string | null> {
  const path = options.profilePath ?? join(claudeHome(options), ".claude.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) {
      return null;
    }
    return firstString(parsed.oauthAccount, ["emailAddress", "email"]);
  } catch {
    return null;
  }
}

/** Merges imported accounts into the store, by refresh token or name. */
export function upsertClaudeAccounts(
  kept: readonly ClaudeAccount[],
  imported: readonly ClaudeAccount[],
): { accounts: ClaudeAccount[]; added: number; updated: number } {
  const out = [...kept];
  let added = 0;
  let updated = 0;
  for (const account of imported) {
    const at = out.findIndex(
      (entry) =>
        (entry.refreshToken !== "" && entry.refreshToken === account.refreshToken) ||
        entry.user.toLowerCase() === account.user.toLowerCase(),
    );
    if (at >= 0) {
      const before = out[at] as ClaudeAccount;
      out[at] = { ...account, id: before.id, addedAt: before.addedAt, alias: before.alias };
      updated += 1;
    } else {
      out.push(account);
      added += 1;
    }
  }
  return { accounts: out, added, updated };
}

async function defaultKeychainReader(service: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    return stdout;
  } catch {
    return null;
  }
}

async function defaultKeychainWriter(service: string, secret: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("this computer has no macOS keychain");
  }
  await execFileAsync("security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    process.env.USER ?? "claude",
    "-w",
    secret,
  ]);
}

function execFileAsync(program: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(program, [...args], { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

function isAccount(value: unknown): value is ClaudeAccount {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.user === "string" &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.credentials === "string" &&
    typeof value.addedAt === "number"
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
