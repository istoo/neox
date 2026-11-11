import { refreshChatGptApiAccount } from "./chatgpt-api-signin.js";
import { copilotApiHeaders, copilotSessionToken } from "./copilot-signin.js";
import {
  ownLoginAccount,
  readCopilotOwnLogins,
  type CopilotOwnOptions,
} from "./copilot-own-logins.js";
import { factoryAuthHeaders, factoryBase } from "./factory-accounts.js";
import { refreshGoogleAccount } from "./google-signin.js";
import {
  loadSubscriptionAccounts,
  subscriptionAccountsFile,
  type ChatGptApiAccount,
  type CopilotAccount,
  type FactorySubscriptionAccount,
  type GoogleSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionAgent,
} from "./subscription-store.js";

/**
 * What the gateway puts on a request served by a subscription account:
 * the vendor's own token and headers, and the base URL an account names
 * instead of the provider's. myna's `Account.sign` and each provider's
 * `Provider{...}` in `internal/provider/account.go`.
 *
 * Refreshing writes nothing here: the caller keeps the account, so a
 * token renewed once is stored by the code that owns the store.
 */

export interface SubscriptionAuth {
  headers: Record<string, string>;
  /** The API this account is served at, when it says so (Copilot's session). */
  baseUrl?: string;
  /** The account with a renewed token, when one was renewed. */
  renewed?: SubscriptionAccount;
  /** The vendor's model ids, when the account names them (Copilot's Auto). */
  agent: SubscriptionAccount["agent"];
}

export interface SubscriptionAuthOptions {
  fetchImpl?: typeof fetch;
  /** The proxy to use instead of the account's own. */
  proxy?: string;
  now?: () => number;
}

/** A Copilot session token, kept until it expires (`account.go:1312-1320`). */
interface CopilotSession {
  token: string;
  expiresAt: number;
  apiBase: string;
}

const copilotSessions = new Map<string, CopilotSession>();

/** Forgets every cached Copilot session; a test, or a sign-out. */
export function clearCopilotSessions(): void {
  copilotSessions.clear();
}

/**
 * One account of an agent's store, or null: the sign-in the gateway
 * serves a provider's requests with. A provider that names nobody takes
 * the active one, which is the first in the store — `accounts switch`
 * moves the chosen account there (myna's `First`, `side_logins.go`
 * `listSideLogins`) — and Copilot's own sign-in when Neolix keeps none.
 */
export async function loadSubscriptionAccount(
  gatewayDir: string,
  agent: SubscriptionAgent,
  user: string,
  own?: CopilotOwnOptions,
): Promise<SubscriptionAccount | null> {
  const file = subscriptionAccountsFile(gatewayDir, agent);
  const accounts = await loadSubscriptionAccounts(file, agent);
  const wanted = user.trim().toLowerCase();
  if (wanted === "") {
    const first = accounts[0];
    if (first !== undefined) {
      return first;
    }
  } else {
    const found =
      accounts.find((account) => account.user.trim().toLowerCase() === wanted) ??
      accounts.find((account) => account.id === user);
    if (found !== undefined) {
      return found;
    }
  }
  if (agent !== "copilot") {
    return null;
  }
  // The sign-ins Copilot's own editors and CLI keep can serve too
  // (myna's own:true accounts), and are read, never stored.
  const ownAccounts = (await readCopilotOwnLogins(own ?? {})).map(ownLoginAccount);
  if (wanted === "") {
    return ownAccounts[0] ?? null;
  }
  return (
    ownAccounts.find((account) => account.user.toLowerCase() === wanted || account.id === user) ??
    null
  );
}

function copilotKey(account: CopilotAccount): string {
  return `${account.host}\u0000${account.githubToken}`;
}

export async function subscriptionAuth(
  account: SubscriptionAccount,
  options: SubscriptionAuthOptions = {},
): Promise<SubscriptionAuth | { error: string; lapsed?: string }> {
  const now = options.now?.() ?? Date.now();
  const proxy = options.proxy ?? account.proxy ?? undefined;
  const withProxy = proxy === undefined ? options : { ...options, proxy };
  switch (account.agent) {
    case "chatgpt-api":
      return chatGptApiAuth(account, withProxy, now);
    case "copilot":
      return copilotAuth(account, withProxy, now);
    case "gemini":
    case "antigravity":
      return googleAuth(account, withProxy, now);
    case "factory":
      return factoryAuth(account);
  }
}

/**
 * Factory's key rides as droid sends it, and is never renewed: the org's
 * own host is where its requests go when `whoami` named one.
 */
function factoryAuth(account: FactorySubscriptionAccount): SubscriptionAuth {
  return {
    agent: "factory",
    headers: factoryAuthHeaders(account),
    baseUrl: factoryBase(account),
  };
}

async function chatGptApiAuth(
  account: ChatGptApiAccount,
  options: SubscriptionAuthOptions,
  now: number,
): Promise<SubscriptionAuth | { error: string; lapsed?: string }> {
  const refreshed = await refreshChatGptApiAccount(account, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    now: () => now,
  });
  if ("error" in refreshed) {
    return refreshed;
  }
  return {
    agent: "chatgpt-api",
    headers: { authorization: `Bearer ${refreshed.account.accessToken}` },
    ...(refreshed.refreshed ? { renewed: refreshed.account } : {}),
  };
}

async function copilotAuth(
  account: CopilotAccount,
  options: SubscriptionAuthOptions,
  now: number,
): Promise<SubscriptionAuth | { error: string; lapsed?: string }> {
  const key = copilotKey(account);
  const cached = copilotSessions.get(key);
  let session: CopilotSession;
  if (cached !== undefined && cached.expiresAt - now > 60_000) {
    session = cached;
  } else {
    const result = await copilotSessionToken({
      githubToken: account.githubToken,
      host: account.host,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      now: () => now,
    });
    if ("error" in result) {
      return { error: result.error };
    }
    session = result.session;
    copilotSessions.set(key, session);
  }
  return {
    agent: "copilot",
    headers: { ...copilotApiHeaders(), authorization: `Bearer ${session.token}` },
    baseUrl: session.apiBase,
  };
}

async function googleAuth(
  account: GoogleSubscriptionAccount,
  options: SubscriptionAuthOptions,
  now: number,
): Promise<SubscriptionAuth | { error: string; lapsed?: string }> {
  const refreshed = await refreshGoogleAccount(account, {
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
    now: () => now,
  });
  if ("error" in refreshed) {
    return refreshed;
  }
  return {
    agent: account.agent,
    headers: { authorization: `Bearer ${refreshed.account.accessToken}` },
    ...(refreshed.refreshed ? { renewed: refreshed.account } : {}),
  };
}
