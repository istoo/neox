import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Codex CLI's own OAuth client (myna provider/account.go:994). */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Where ChatGPT issues and refreshes tokens. */
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

/**
 * Codex's own ChatGPT sign-in, read the way myna reads it. Nothing here
 * writes: renewing the tokens and putting them back where Codex keeps them
 * (auth.json or the macOS keychain item) is a later stage, because a
 * refresh rotates the refresh token and not writing it back would sign the
 * user's Codex out.
 */
export interface CodexAccountStatus {
  /** Stable per Codex home: `codex:<first 16 hex of its sha256>`. */
  id: string;
  /** The email, with the plan after it for a workspace seat. */
  label: string;
  plan: string | null;
  accountId: string | null;
  home: string;
  signedIn: boolean;
  /** Where the sign-in was found, or why it could not be read. */
  store: "file" | "keychain" | "memory" | "unreadable";
  /** When the access token expires, epoch ms; null when it says nothing. */
  expiresAt: number | null;
  error?: string;
}

export interface CodexSessionReads {
  asked: boolean;
  all?: boolean;
  agents?: Record<string, boolean>;
}

export interface CodexDiscoveryOptions {
  /** This computer's home; defaults to HOME, then the OS's. */
  homeDir?: string;
  /** Codex's home; defaults to CODEX_HOME, then `<home>/.codex`. */
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  /** The user's "read no sign-in" switch. Off, nothing is read. */
  discovery?: boolean;
  /** Which agents' session files may be read. Kept for later stages. */
  sessionReads?: CodexSessionReads;
  /** Epoch ms, for an account's expiry. */
  now?: number;
  /** Reads the keychain item for a store key; tests inject this. */
  keychain?: (storeKey: string) => string | null | Promise<string | null>;
}

export interface CodexDiscovery {
  /** False when the user turned discovery off. */
  discovery: boolean;
  accounts: CodexAccountStatus[];
}

/** Where Codex keeps its files: `CODEX_HOME`, else `<home>/.codex`. */
export function codexHomePath(options: CodexDiscoveryOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  return options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
}

/** Codex's access token as Codex keeps it: never refreshed here (leftAlone). */
export type CodexSignIn =
  | {
      ok: true;
      accessToken: string;
      /** What a switch into the pool needs; null when the file has none. */
      refreshToken: string | null;
      idToken: string | null;
      accountId: string | null;
      expiresAt: number | null;
      /** The account's own name, as myna's `codexUser` reads it. */
      label: string;
      plan: string | null;
    }
  | { ok: false; error: string };

/**
 * The token a request to ChatGPT's backend is signed with, read the way
 * Codex keeps it and left as it is: an expired one is an error, for Codex
 * to renew. Nothing is written.
 */
export async function readCodexSignIn(options: CodexDiscoveryOptions = {}): Promise<CodexSignIn> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const home = options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
  await refuseRealHomeInTests(home, env);
  if (options.discovery === false) {
    return { ok: false, error: "Codex account discovery is off" };
  }
  const setting = await readStoreSetting(home);
  const loaded = await loadAuthText(home, setting, options);
  if ("error" in loaded) {
    return { ok: false, error: loaded.error };
  }
  return signInOf(loaded.text, options.now ?? Date.now());
}

/** The sign-in Codex keeps, from auth.json or the keychain item, unread case by case. */
async function loadAuthText(
  home: string,
  setting: CodexStoreSetting,
  options: CodexDiscoveryOptions,
): Promise<{ text: string; store: "file" | "keychain" } | { error: string }> {
  if (setting.forcedAPI) {
    return { error: "Codex is asked for an API key, not a ChatGPT sign-in" };
  }
  if (setting.mode === "ephemeral") {
    return { error: "Codex keeps its sign-in in its own memory" };
  }
  let text: string | null = null;
  let store: "file" | "keychain" = "file";
  if ((setting.mode === "keyring" || setting.mode === "auto") && !setting.secrets) {
    text = await readKeychain(home, options);
    if (text !== null) {
      store = "keychain";
    }
    if (text === null && setting.mode === "keyring") {
      return { error: "Codex's sign-in is in the keychain, and could not be read" };
    }
  }
  if (text === null) {
    text = await readFileText(join(home, "auth.json"));
  }
  return text === null ? { error: "Codex is signed out" } : { text, store };
}

/** A ChatGPT sign-in as a token to send, or why it cannot be sent as it is. */
function signInOf(text: string, now: number): CodexSignIn {
  const auth = parseAuth(text);
  if (auth === null) {
    return { ok: false, error: "Codex's sign-in could not be read" };
  }
  if (auth.auth_mode === "apikey") {
    return { ok: false, error: "Codex is signed in with an API key, not a ChatGPT account" };
  }
  const accessToken = auth.tokens?.access_token ?? "";
  if (accessToken.length === 0) {
    return { ok: false, error: "Codex is signed out" };
  }
  const expiresAt = expOf(accessToken);
  if (expiresAt !== null && expiresAt <= now) {
    return { ok: false, error: "Codex's sign-in has expired; Codex renews it as it runs" };
  }
  const id = claimsOf(auth.tokens?.id_token ?? "");
  const accountId =
    auth.tokens?.account_id ??
    claimAt(id, "https://api.openai.com/auth", "chatgpt_account_id") ??
    null;
  const plan = claimAt(id, "https://api.openai.com/auth", "chatgpt_plan_type");
  const email = typeof id.email === "string" ? id.email : "";
  return {
    ok: true,
    accessToken,
    refreshToken: auth.tokens?.refresh_token ?? null,
    idToken: auth.tokens?.id_token ?? null,
    accountId,
    expiresAt,
    label: withPlan(email.length > 0 ? email : "ChatGPT", plan),
    plan,
  };
}

export interface CodexRenewOptions extends CodexDiscoveryOptions {
  /** Refresh and write back where Codex keeps it; false leaves it to Codex. */
  renew?: boolean;
  /** Refreshes even a token that has time left, for a 401 the backend returned. */
  force?: boolean;
  /** False never writes, and so never refreshes either; default true (myna's). */
  writeBack?: boolean;
  /** Injected by tests; the ChatGPT token endpoint by default. */
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  /** Injected by tests; the macOS keychain item by default. */
  writeKeychain?: (storeKey: string, secret: string) => Promise<void>;
}

/** Refreshed this long before it runs out, so no request starts with a dying token. */
const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * A usable token, refreshed when it is about to expire and written back
 * where Codex keeps it (auth.json, atomically, or the keychain item), as
 * myna does: the refresh rotates the refresh token, so not writing it back
 * would sign the user's Codex out. `renew: false` is the leftAlone mode,
 * which reads what Codex keeps and leaves an expired one to Codex.
 */
export async function renewCodexSignIn(options: CodexRenewOptions = {}): Promise<CodexSignIn> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const home = options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
  await refuseRealHomeInTests(home, env);
  if (options.discovery === false) {
    return { ok: false, error: "Codex account discovery is off" };
  }
  const setting = await readStoreSetting(home);
  const loaded = await loadAuthText(home, setting, options);
  if ("error" in loaded) {
    return { ok: false, error: loaded.error };
  }
  const now = options.now ?? Date.now();
  // Without write-back a refresh would rotate Codex's refresh token and strand
  // it, so the sign-in is only read, never renewed: same as leftAlone.
  if (options.writeBack === false) {
    return signInOf(loaded.text, now);
  }
  const due = dueForRenewal(loaded.text, now, options.force === true);
  if ("signIn" in due) {
    return due.signIn;
  }
  if (options.renew !== true) {
    return { ok: false, error: "Codex's sign-in has expired; Codex renews it as it runs" };
  }
  const auth = due.auth;
  const refreshToken = auth.tokens?.refresh_token ?? "";
  if (refreshToken.length === 0) {
    return { ok: false, error: "Codex's sign-in has no refresh token to renew it with" };
  }
  const refreshed = await refreshAuth(auth, refreshToken, options);
  if ("error" in refreshed) {
    return { ok: false, error: refreshed.error };
  }
  if (loaded.store === "keychain") {
    await writeKeychain(home, refreshed.text, options);
  } else {
    await writeAuthAtomically(home, refreshed.text);
  }
  return signInOf(refreshed.text, now);
}

export interface CodexSignInWrite extends CodexDiscoveryOptions {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accountId: string | null;
  /** Injected by tests; the macOS keychain item by default. */
  writeKeychain?: (storeKey: string, secret: string) => Promise<void>;
}

/**
 * Signs Codex in to an account Neolix holds, where Codex keeps its sign-in
 * (auth.json, atomically, or the keychain item): myna's `saveCodexLogin`
 * from `accounts switch` (`provider/logins.go:1355-1362`). Nothing is
 * touched when Codex is asked for an API key or keeps its sign-in in memory.
 */
export async function writeCodexSignIn(
  options: CodexSignInWrite,
): Promise<{ store: "file" | "keychain" } | { error: string }> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const home = options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
  await refuseRealHomeInTests(home, env);
  if (options.discovery === false) {
    return { error: "Codex account discovery is off" };
  }
  const setting = await readStoreSetting(home);
  if (setting.forcedAPI) {
    return { error: "Codex is asked for an API key, not a ChatGPT sign-in" };
  }
  if (setting.mode === "ephemeral") {
    return { error: "Codex keeps its sign-in in its own memory" };
  }
  const auth: CodexAuth = {
    auth_mode: "chatgpt",
    tokens: {
      id_token: options.idToken ?? "",
      access_token: options.accessToken,
      refresh_token: options.refreshToken ?? "",
      account_id: options.accountId ?? "",
    },
  };
  const text = JSON.stringify(auth, null, 2);
  if (setting.mode === "keyring") {
    await writeKeychain(home, text, options);
    return { store: "keychain" };
  }
  if (setting.mode === "auto" && !setting.secrets) {
    // An item already there goes first with Codex: a file beside it would
    // be passed over (`codex_store.go:610-620`).
    const existing = await readKeychain(home, options);
    if (existing !== null) {
      await writeKeychain(home, text, options);
      return { store: "keychain" };
    }
  }
  await mkdir(home, { recursive: true });
  await writeAuthAtomically(home, text);
  return { store: "file" };
}

/** A sign-in still good, one that can be refreshed, or why it is neither. */
function dueForRenewal(
  text: string,
  now: number,
  force: boolean,
): { signIn: CodexSignIn } | { auth: CodexAuth } {
  const auth = parseAuth(text);
  if (auth === null) {
    return { signIn: { ok: false, error: "Codex's sign-in could not be read" } };
  }
  if (auth.auth_mode === "apikey") {
    return {
      signIn: {
        ok: false,
        error: "Codex is signed in with an API key, not a ChatGPT account",
      },
    };
  }
  const access = auth.tokens?.access_token ?? "";
  if (access.length === 0) {
    return { signIn: { ok: false, error: "Codex is signed out" } };
  }
  const expiresAt = expOf(access);
  if (!force && (expiresAt === null || expiresAt > now + RENEW_MARGIN_MS)) {
    return { signIn: signInOf(text, now) };
  }
  return { auth };
}

async function refreshAuth(
  auth: CodexAuth,
  refreshToken: string,
  options: CodexRenewOptions,
): Promise<{ text: string } | { error: string }> {
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
  } catch (error) {
    return { error: `Codex's token could not be renewed: ${errorMessage(error)}` };
  }
  if (!answer.ok) {
    return { error: `Codex's token could not be renewed: ${answer.status}` };
  }
  let tokens: unknown;
  try {
    tokens = await answer.json();
  } catch {
    return { error: "Codex's token endpoint answered nothing readable" };
  }
  if (!isRecord(tokens) || typeof tokens.access_token !== "string") {
    return { error: "Codex's token endpoint answered no access token" };
  }
  const next: CodexAuth = {
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: tokens.access_token,
      ...(typeof tokens.refresh_token === "string" ? { refresh_token: tokens.refresh_token } : {}),
      ...(typeof tokens.id_token === "string" ? { id_token: tokens.id_token } : {}),
    },
  };
  return { text: JSON.stringify(next) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Replaces auth.json in one step, so Codex never reads a half-written file. */
async function writeAuthAtomically(home: string, text: string): Promise<void> {
  const file = join(home, "auth.json");
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

async function writeKeychain(
  home: string,
  text: string,
  options: CodexRenewOptions,
): Promise<void> {
  const storeKey = await codexKeychainAccount(home);
  if (options.writeKeychain !== undefined) {
    await options.writeKeychain(storeKey, text);
    return;
  }
  if (process.platform !== "darwin") {
    throw new Error("Codex's sign-in is in a keychain this computer doesn't have");
  }
  await run("security", [
    "add-generic-password",
    "-U",
    "-s",
    "Codex Auth",
    "-a",
    storeKey,
    "-w",
    text,
  ]);
}

interface CodexAuth {
  auth_mode?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

interface CodexStoreSetting {
  mode: "file" | "keyring" | "auto" | "ephemeral" | "unreadable";
  secrets: boolean;
  forcedAPI: boolean;
}

/**
 * What the gateway can see of Codex's ChatGPT sign-in. Read-only: this
 * module never creates, updates or deletes a file or a keychain item.
 */
export async function discoverCodexAccounts(
  options: CodexDiscoveryOptions = {},
): Promise<CodexDiscovery> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.HOME ?? homedir();
  const codexHome = options.codexHome ?? (env.CODEX_HOME?.trim() || join(homeDir, ".codex"));
  await refuseRealHomeInTests(codexHome, env);
  if (options.discovery === false) {
    return { discovery: false, accounts: [] };
  }
  const setting = await readStoreSetting(codexHome);
  const account = await readAccount(codexHome, setting, options);
  return { discovery: true, accounts: account === null ? [] : [account] };
}

/** A test run never reads this computer's own Codex sign-in. */
async function refuseRealHomeInTests(codexHome: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.VITEST === undefined && env.NODE_ENV !== "test") {
    return;
  }
  const real = await realPath(join(homedir(), ".codex"));
  if ((await realPath(codexHome)) === real) {
    throw new Error("Codex discovery refused to read this computer's own home in a test");
  }
}

async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Codex's `config.toml` settings this module needs, read with the same
 * defaults Codex has: no file or no value means auth.json, and
 * `forced_login_method = "api"` means Codex takes no ChatGPT sign-in.
 */
async function readStoreSetting(home: string): Promise<CodexStoreSetting> {
  let text: string;
  try {
    text = await readFile(join(home, "config.toml"), "utf8");
  } catch {
    return { mode: "file", secrets: false, forcedAPI: false };
  }
  let mode = "file";
  let secrets = false;
  let forcedAPI = false;
  let section = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1).trim();
      continue;
    }
    const store = /^cli_auth_credentials_store\s*=\s*"([^"]*)"/.exec(trimmed);
    if (store !== null) {
      mode = store[1] ?? "file";
      continue;
    }
    if (section === "features") {
      const secret = /^secret_auth_storage\s*=\s*(true|false)/.exec(trimmed);
      if (secret !== null) {
        secrets = secret[1] === "true";
      }
      continue;
    }
    const forced = /^forced_login_method\s*=\s*"([^"]*)"/.exec(trimmed);
    if (forced !== null) {
      forcedAPI = forced[1] === "api";
    }
  }
  if (mode !== "file" && mode !== "keyring" && mode !== "auto" && mode !== "ephemeral") {
    return { mode: "unreadable", secrets, forcedAPI };
  }
  return { mode, secrets, forcedAPI };
}

async function readAccount(
  home: string,
  setting: CodexStoreSetting,
  options: CodexDiscoveryOptions,
): Promise<CodexAccountStatus | null> {
  const base = {
    id: await codexAccountKey(home),
    home,
    plan: null,
    accountId: null,
    expiresAt: null,
  };
  if (setting.forcedAPI) {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store: "file",
      error: "Codex's config.toml asks for an API key, not a ChatGPT sign-in",
    };
  }
  if (setting.mode === "ephemeral") {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store: "memory",
      error: "Codex keeps its sign-in in its own memory, which no other program can read",
    };
  }
  if (setting.mode === "unreadable") {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store: "unreadable",
      error: "Codex's config.toml names a credential store Codex doesn't know",
    };
  }
  const wantsKeychain = (setting.mode === "keyring" || setting.mode === "auto") && !setting.secrets;
  if (wantsKeychain) {
    const found = await readKeychain(home, options);
    if (found !== null) {
      return accountFromAuth(base, found, "keychain");
    }
    if (setting.mode === "keyring") {
      return {
        ...base,
        label: "Codex",
        signedIn: false,
        store: "unreadable",
        error: "Codex's sign-in is in the macOS keychain, and the item could not be read",
      };
    }
  }
  const text = await readFileText(join(home, "auth.json"));
  if (text === null) {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store: "file",
      error: "Codex is signed out",
    };
  }
  return accountFromAuth(base, text, "file");
}

async function readFileText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readKeychain(home: string, options: CodexDiscoveryOptions): Promise<string | null> {
  const reader = options.keychain ?? defaultKeychainReader;
  try {
    return await reader(await codexKeychainAccount(home));
  } catch {
    return null;
  }
}

/** Codex's `compute_store_key`: the canonical home, hashed, `cli|` + 16 hex. */
export async function codexKeychainAccount(home: string): Promise<string> {
  const sum = createHash("sha256")
    .update(await realPath(home))
    .digest("hex");
  return `cli|${sum.slice(0, 16)}`;
}

/** Codex's macOS keychain item, read through `security`; nothing else. */
async function defaultKeychainReader(storeKey: string): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  try {
    const { stdout } = await run(
      "security",
      ["find-generic-password", "-s", "Codex Auth", "-a", storeKey, "-w"],
      { encoding: "utf8" },
    );
    return stdout;
  } catch {
    return null;
  }
}

export async function codexAccountKey(home: string): Promise<string> {
  const sum = createHash("sha256")
    .update(await realPath(home))
    .digest("hex");
  return `codex:${sum.slice(0, 16)}`;
}

function accountFromAuth(
  base: Omit<CodexAccountStatus, "label" | "signedIn" | "store">,
  text: string,
  store: "file" | "keychain",
): CodexAccountStatus {
  const parsed = parseAuth(text);
  if (parsed === null) {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store: "unreadable",
      error: "Codex's sign-in could not be read",
    };
  }
  if (parsed.auth_mode === "apikey") {
    return {
      ...base,
      label: "Codex",
      signedIn: false,
      store,
      error: "Codex is signed in with an API key, not a ChatGPT account",
    };
  }
  const access = parsed.tokens?.access_token ?? "";
  if (access.length === 0) {
    return { ...base, label: "Codex", signedIn: false, store, error: "Codex is signed out" };
  }
  const id = claimsOf(parsed.tokens?.id_token ?? "");
  const plan = claimAt(id, "https://api.openai.com/auth", "chatgpt_plan_type");
  const accountId =
    parsed.tokens?.account_id ??
    claimAt(id, "https://api.openai.com/auth", "chatgpt_account_id") ??
    null;
  const expires = expOf(access);
  const email = typeof id.email === "string" ? id.email : "";
  return {
    ...base,
    label: withPlan(email.length > 0 ? email : "ChatGPT", plan),
    plan,
    accountId,
    signedIn: true,
    store,
    expiresAt: expires,
  };
}

function parseAuth(text: string): CodexAuth | null {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? (value as CodexAuth) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function claimAt(claims: Record<string, unknown>, section: string, name: string): string | null {
  const nested = claims[section];
  if (!isRecord(nested)) {
    return null;
  }
  const value = nested[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function expOf(access: string): number | null {
  const exp = claimsOf(access).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

/** myna's name for a ChatGPT account: an email, with a workspace plan after it. */
function withPlan(email: string, plan: string | null): string {
  if (plan !== "team" && plan !== "business" && plan !== "enterprise" && plan !== "edu") {
    return email;
  }
  return `${email} · ${plan.slice(0, 1).toUpperCase()}${plan.slice(1)}`;
}
