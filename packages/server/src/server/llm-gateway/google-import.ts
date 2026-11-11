import { errorMessage } from "./oauth.js";
import { discoverGoogleProject, googleAppOf } from "./google-signin.js";
import { fetchThroughProxy } from "./proxy-fetch.js";
import {
  addSubscriptionAccount,
  loadAnySubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountId,
  subscriptionAccountsFile,
  type GoogleSubscriptionAccount,
  type SubscriptionAccount,
} from "./subscription-store.js";

/**
 * Antigravity accounts brought in from another tool's export
 * (`provider/google_import.go:1-16`): Antigravity Cockpit and Antigravity
 * Manager export `[{email, refresh_token}]`, Antigravity Manager also
 * keeps `{email, token: {refresh_token, project_id}}`, CLIProxyAPI uses
 * `{type: "antigravity", email, refresh_token, project_id}`, and Cockpit
 * takes bare refresh tokens, one a line. Every one signs in with
 * Antigravity's own OAuth client, so a refresh token from any works.
 *
 * Each is checked the way a sign-in is finished: the token refreshed with
 * Google, the account asked for, the Code Assist project found. Tokens are
 * never logged or returned.
 */

export type GoogleImportAgent = "antigravity";

export interface ImportedSubscriptionAccount {
  /** The account's email, or "#n" when the file doesn't say. */
  user: string;
  status: "added" | "updated" | "exists" | "failed";
  plan?: string;
  error?: string;
  /** The file (from 1) that held no account, when it held none. */
  file?: number;
}

/** One account read from an export. */
export interface GoogleImportEntry {
  n: number;
  email: string;
  refreshToken: string;
  project: string;
  error: string;
  /** A file that held no account, rather than an account that failed. */
  file?: number;
}

/** The most accounts one import takes (`google_import.go:70`). */
const MAX_IMPORT = 200;

/** Reads the accounts in one export's text. */
export function parseGoogleImport(agent: GoogleImportAgent, data: string): GoogleImportEntry[] {
  const text = data.replace(/^﻿/, "").trim();
  if (text === "") {
    throw new Error("nothing to import");
  }
  const out: GoogleImportEntry[] = [];
  const add = (entry: Omit<GoogleImportEntry, "n">): void => {
    out.push({ ...entry, n: out.length + 1 });
  };
  if (text.startsWith("[") || text.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new Error(`not valid JSON: ${errorMessage(error)}`, { cause: error });
    }
    walkImport(value, agent, add);
  } else {
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) {
        continue;
      }
      if (/[ \t]/.test(line) || line.includes("://")) {
        add({ email: "", refreshToken: "", project: "", error: "not a refresh token" });
        continue;
      }
      add({ email: "", refreshToken: line, project: "", error: "" });
    }
  }
  if (out.length === 0) {
    throw new Error("no accounts in it");
  }
  if (out.length > MAX_IMPORT) {
    throw new Error(`${out.length} accounts in it; at most ${MAX_IMPORT} at a time`);
  }
  // The same account twice is imported once.
  const seenTokens = new Set<string>();
  const seenUsers = new Set<string>();
  for (const entry of out) {
    if (entry.error !== "") {
      continue;
    }
    if (entry.refreshToken === "") {
      entry.error = "no refresh_token in it";
      continue;
    }
    const user = entry.email.toLowerCase();
    if (seenTokens.has(entry.refreshToken) || (user !== "" && seenUsers.has(user))) {
      entry.error = "in the file twice";
      continue;
    }
    seenTokens.add(entry.refreshToken);
    if (user !== "") {
      seenUsers.add(user);
    }
  }
  return out;
}

function walkImport(
  value: unknown,
  agent: GoogleImportAgent,
  add: (entry: Omit<GoogleImportEntry, "n">) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkImport(item, agent, add);
    }
    return;
  }
  if (isRecord(value)) {
    // Antigravity Manager's export response: {accounts: [...]}
    if (
      Array.isArray(value.accounts) &&
      firstString(value, "refresh_token", "refreshToken") === ""
    ) {
      walkImport(value.accounts, agent, add);
      return;
    }
    add(entryOf(value, agent));
    return;
  }
  if (typeof value === "string") {
    add({ email: "", refreshToken: value.trim(), project: "", error: "" });
    return;
  }
  add({ email: "", refreshToken: "", project: "", error: "not an account" });
}

function entryOf(
  value: Record<string, unknown>,
  agent: GoogleImportAgent,
): Omit<GoogleImportEntry, "n"> {
  const entry = {
    email: firstString(value, "email"),
    refreshToken: firstString(value, "refresh_token", "refreshToken"),
    project: firstString(value, "project_id", "projectId", "project"),
    error: "",
  };
  // Antigravity Manager's account file keeps the sign-in under token.
  if (isRecord(value.token)) {
    if (entry.refreshToken === "") {
      entry.refreshToken = firstString(value.token, "refresh_token", "refreshToken");
    }
    if (entry.email === "") {
      entry.email = firstString(value.token, "email");
    }
    if (entry.project === "") {
      entry.project = firstString(value.token, "project_id", "projectId");
    }
  }
  // CLIProxyAPI names the app its auth file is for.
  const type = firstString(value, "type").toLowerCase();
  if (type !== "" && type !== agent) {
    entry.error = `a ${type} sign-in, not ${googleAppOf(agent).name}'s`;
  }
  return entry;
}

export interface ImportGoogleOptions {
  gatewayDir: string;
  /** The exports' texts, one per file. */
  texts: readonly string[];
  fetchImpl?: typeof fetch;
  proxy?: string;
  now?: () => number;
}

/**
 * Checks every account in the exports with Google and keeps the ones that
 * answer; the accounts Neolix already has are reported, not replaced by the
 * same sign-in.
 */
export async function importGoogleAccounts(
  options: ImportGoogleOptions,
): Promise<ImportedSubscriptionAccount[]> {
  const agent: GoogleImportAgent = "antigravity";
  const file = subscriptionAccountsFile(options.gatewayDir, agent);
  const all = await loadAnySubscriptionAccounts(file);
  const existing = all.filter(
    (account): account is GoogleSubscriptionAccount => account.agent === agent,
  );
  const haveToken = new Map(existing.map((account) => [account.refreshToken, account.user]));

  const entries: GoogleImportEntry[] = [];
  for (const [index, text] of options.texts.entries()) {
    try {
      entries.push(...parseGoogleImport(agent, text));
    } catch (error) {
      if (options.texts.length === 1) {
        throw error;
      }
      // One file of several that holds no account: said, not passed over.
      entries.push({
        n: entries.length + 1,
        email: "",
        refreshToken: "",
        project: "",
        error: errorMessage(error),
        file: index + 1,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error("no accounts in these files");
  }

  const results: ImportedSubscriptionAccount[] = [];
  const kept: GoogleSubscriptionAccount[] = [];
  for (const entry of entries) {
    const name = displayName(entry);
    if (entry.file !== undefined) {
      results.push({ user: name, status: "failed", error: entry.error, file: entry.file });
      continue;
    }
    if (entry.error !== "") {
      results.push({ user: name, status: "failed", error: entry.error });
      continue;
    }
    const known = haveToken.get(entry.refreshToken);
    if (known !== undefined) {
      results.push({ user: known, status: "exists" });
      continue;
    }
    const checked = await checkGoogleImport(entry, options, agent);
    if ("error" in checked) {
      results.push({ user: name, status: "failed", error: checked.error });
      continue;
    }
    const again = existing.some((account) => account.id === checked.account.id);
    if (!again) {
      kept.push(checked.account);
    }
    results.push({
      user: checked.account.user,
      status: again ? "updated" : "added",
      ...(checked.account.plan === null ? {} : { plan: checked.account.plan }),
    });
  }
  if (kept.length > 0) {
    // Gemini CLI's accounts share this file: keep them.
    let merged: SubscriptionAccount[] = all.filter((account) => account.agent !== agent);
    for (const account of [...existing, ...kept]) {
      merged = addSubscriptionAccount(merged, account);
    }
    await saveSubscriptionAccounts(file, merged);
  }
  return results;
}

function displayName(entry: GoogleImportEntry): string {
  if (entry.email !== "") {
    return entry.email;
  }
  return entry.file === undefined ? `#${entry.n}` : "";
}

async function checkGoogleImport(
  entry: GoogleImportEntry,
  options: ImportGoogleOptions,
  agent: GoogleImportAgent,
): Promise<{ account: GoogleSubscriptionAccount } | { error: string }> {
  const app = googleAppOf(agent);
  const fetchImpl = fetchThroughProxy(options.proxy, options.fetchImpl);
  let response: Response;
  try {
    response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: entry.refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }).toString(),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return { error: `couldn't reach Google: ${errorMessage(error)}` };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string") {
    return { error: `Google refused the refresh token (${response.status})` };
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
  const now = options.now?.() ?? Date.now();
  let account: GoogleSubscriptionAccount = {
    agent,
    id: "",
    user: entry.email,
    plan: null,
    addedAt: now,
    lapsed: null,
    accessToken: body.access_token,
    refreshToken: entry.refreshToken,
    expiresAt: expiresIn > 0 ? now + expiresIn * 1000 : 0,
    project: entry.project === "" ? null : entry.project,
    proxy: (options.proxy ?? "").trim() || null,
  };
  const who = await googleWho(account, fetchImpl);
  if ("error" in who) {
    return { error: who.error };
  }
  account = { ...account, user: who.email, id: subscriptionAccountId(agent, who.email) };
  const project = await discoverGoogleProject(account, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if ("project" in project) {
    account = { ...account, project: project.project, plan: project.plan };
  }
  return { account };
}

async function googleWho(
  account: GoogleSubscriptionAccount,
  fetchImpl: typeof fetch,
): Promise<{ email: string } | { error: string }> {
  let response: Response;
  try {
    response = await fetchImpl("https://www.googleapis.com/oauth2/v2/userinfo?alt=json", {
      method: "GET",
      headers: { authorization: `Bearer ${account.accessToken}` },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    return { error: `couldn't ask Google whose account it is: ${errorMessage(error)}` };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || typeof body.email !== "string" || body.email === "") {
    return { error: "Google didn't say whose account this is" };
  }
  return { email: body.email };
}

function firstString(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.trim() !== "") {
      return found.trim();
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
