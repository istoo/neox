import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The accounts Neolix signed in to a subscription itself, one store per
 * agent under `$NEOLIX_HOME/gateway/` (0600, replaced in one step). myna
 * keeps the same accounts in `logins.json` (`provider/logins.go`); Neolix
 * keeps them apart per agent so a store of one vendor never holds
 * another's tokens.
 *
 * The stores are read by the gateway when it signs a request and by the
 * Providers page through `redacted*`, which never carries a token.
 */

export type SubscriptionAgent = "chatgpt-api" | "copilot" | "gemini" | "antigravity" | "factory";

interface SubscriptionAccountBase {
  /** Stable across restarts and sign-ins of the same vendor account. */
  id: string;
  user: string;
  plan: string | null;
  addedAt: number;
  /**
   * Why the vendor says the sign-in is dead ("token revoked", "refresh
   * token expired"), or null. A lapsed account is listed with Sign in
   * again and never sent a request (`provider/signin_revoked.go`).
   */
  lapsed: string | null;
  /**
   * The proxy this account's requests go through, "" or absent for the
   * daemon's (\`signin.go:145-160\`): picked at the sign-in and kept.
   */
  proxy?: string | null;
  /**
   * A name of the user's own for the account (myna's `accounts alias`,
   * #1515): never written to the vendor's sign-in, and the vendor's own
   * name stays `user`.
   */
  alias?: string;
}

/** OpenAI's Sign in with ChatGPT (`provider/chatgpt_api.go:86-96`). */
export interface ChatGptApiAccount extends SubscriptionAccountBase {
  agent: "chatgpt-api";
  /** OpenAI's dynamic registration issued this per account. */
  clientId: string;
  /** This machine's id the client was issued for. */
  hostId: string;
  idToken: string | null;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

/** A GitHub account signed in for Copilot (`provider/copilot_accounts.go`). */
export interface CopilotAccount extends SubscriptionAccountBase {
  agent: "copilot";
  /** The GitHub OAuth token; the Copilot session token is derived from it. */
  githubToken: string;
  /** "" for github.com, "<name>.ghe.com" for an enterprise (`copilot_ghe.go`). */
  host: string;
  /**
   * True for a sign-in the user's own tool keeps (Copilot's editors, the
   * Copilot CLI), which Neolix reads and never stores (`provider/copilot_cli.go`).
   */
  own?: boolean;
}

/** A Google sign-in of Gemini CLI or Antigravity (`provider/google.go:112-127`). */
export interface GoogleSubscriptionAccount extends SubscriptionAccountBase {
  agent: "gemini" | "antigravity";
  accessToken: string;
  refreshToken: string;
  /** Epoch ms, from Google's `expiry_date`. */
  expiresAt: number;
  /** The Google Cloud project Code Assist bills; null until it is found. */
  project: string | null;
}

/**
 * A Factory account added by its API key (`provider/factory_key.go`): a
 * `fk-…` droid takes from `FACTORY_API_KEY`, sent as it is and never
 * renewed. `whoami` names whose the key is and the org it is served from.
 */
export interface FactorySubscriptionAccount extends SubscriptionAccountBase {
  agent: "factory";
  /** The API key itself, `fk-…`. */
  key: string;
  /** whoami's own id for the org, sent as `X-Factory-Org-Id`. */
  orgId: string | null;
  /** "eu" when the org is served from Factory's EU region. */
  region: string | null;
  /** whoami's `premBaseHostV2`, when the org has a host of its own. */
  prem: string | null;
}

export type SubscriptionAccount =
  | ChatGptApiAccount
  | CopilotAccount
  | GoogleSubscriptionAccount
  | FactorySubscriptionAccount;

/** What the page may see: never a token. */
export interface SubscriptionAccountStatus {
  id: string;
  agent: SubscriptionAgent;
  user: string;
  /** The name the user gave it, when they did (`accounts alias`). */
  alias?: string;
  plan: string | null;
  host?: string;
  /** The Google Cloud project a Gemini CLI or Antigravity account bills. */
  project?: string;
  /** "eu" for a Factory account whose org Factory serves from the EU. */
  region?: string;
  /** The Factory org `whoami` named, shown beside the account. */
  orgId?: string;
  expiresAt?: number;
  addedAt: number;
  lapsed: string | null;
}

/** The id of an account: the agent and the vendor's own name for it. */
export function subscriptionAccountId(agent: SubscriptionAgent, user: string, host = ""): string {
  const name = `${agent}\u0000${user.toLowerCase()}\u0000${host.toLowerCase()}`;
  return `${agent}:${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

export function isSubscriptionAgent(value: string): value is SubscriptionAgent {
  return (
    value === "chatgpt-api" ||
    value === "copilot" ||
    value === "gemini" ||
    value === "antigravity" ||
    value === "factory"
  );
}

/** Which file an agent's accounts live in. */
export function subscriptionAccountsFile(gatewayDir: string, agent: SubscriptionAgent): string {
  switch (agent) {
    case "chatgpt-api":
      return join(gatewayDir, "chatgpt-api-accounts.json");
    case "copilot":
      return join(gatewayDir, "copilot-accounts.json");
    case "gemini":
    case "antigravity":
      return join(gatewayDir, "google-accounts.json");
    case "factory":
      return join(gatewayDir, "factory-accounts.json");
  }
}

/** Reads an agent's store; a missing or unreadable file is no accounts. */
export async function loadSubscriptionAccounts<A extends SubscriptionAgent>(
  file: string,
  agent: A,
): Promise<Extract<SubscriptionAccount, { agent: A }>[]> {
  const all = await loadAnySubscriptionAccounts(file);
  return all.filter((entry): entry is Extract<SubscriptionAccount, { agent: A }> => {
    return entry.agent === agent;
  });
}

/**
 * Every account in a file, whichever agent's: Gemini CLI's and
 * Antigravity's share one store, and writing one agent's must keep the
 * other's.
 */
export async function loadAnySubscriptionAccounts(file: string): Promise<SubscriptionAccount[]> {
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
    return value.filter(
      (entry): entry is SubscriptionAccount =>
        isRecord(entry) &&
        typeof entry.agent === "string" &&
        isSubscriptionAgent(entry.agent) &&
        isAccountOf(entry, entry.agent),
    );
  } catch {
    return [];
  }
}

/** Replaces the file in one step, 0600, so a half-written store is never read. */
export async function saveSubscriptionAccounts(
  file: string,
  accounts: readonly SubscriptionAccount[],
): Promise<void> {
  const temp = join(dirname(file), `.subscriptions.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(accounts), { mode: 0o600 });
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * The account a sign-in produced, in place of the one it replaces: the
 * same vendor account signed in again keeps its id, so nothing that
 * points at it (a gateway account, a proxy, a model list) moves.
 */
export function addSubscriptionAccount<A extends SubscriptionAccount>(
  accounts: readonly A[],
  account: A,
): A[] {
  return [...accounts.filter((entry) => entry.id !== account.id), account];
}

export function removeSubscriptionAccount<A extends SubscriptionAccount>(
  accounts: readonly A[],
  id: string,
): A[] {
  return accounts.filter((entry) => entry.id !== id);
}

export function updateSubscriptionAccount<A extends SubscriptionAccount>(
  accounts: readonly A[],
  id: string,
  change: (account: A) => A,
): A[] {
  return accounts.map((entry) => (entry.id === id ? change(entry) : entry));
}

/**
 * Moves one account to the place of the first of its agent's, as
 * `accounts switch` does: the store's order is the order the gateway
 * serves, and the first of an agent is the one a provider takes. Another
 * agent sharing the file (Gemini CLI's and Antigravity's) keeps its own
 * entries and their relative order.
 */
export function switchSubscriptionAccount<A extends SubscriptionAccount>(
  accounts: readonly A[],
  agent: SubscriptionAgent,
  id: string,
): A[] {
  const index = accounts.findIndex((entry) => entry.agent === agent && entry.id === id);
  const target = accounts[index];
  if (index < 0 || target === undefined) {
    return [...accounts];
  }
  const rest = accounts.filter((_entry, at) => at !== index);
  const first = rest.findIndex((entry) => entry.agent === agent);
  return first < 0 ? [target, ...rest] : [...rest.slice(0, first), target, ...rest.slice(first)];
}

/** The accounts with every token left out, as the page reads them. */
export function redactedSubscriptionAccounts(
  accounts: readonly SubscriptionAccount[],
): SubscriptionAccountStatus[] {
  return accounts.map((account) => {
    const status: SubscriptionAccountStatus = {
      id: account.id,
      agent: account.agent,
      user: account.user,
      plan: account.plan,
      addedAt: account.addedAt,
      lapsed: account.lapsed,
      ...(account.alias === undefined ? {} : { alias: account.alias }),
    };
    if (account.agent === "copilot") {
      status.host = account.host;
    } else if (account.agent === "factory") {
      if (account.region !== null && account.region !== "") {
        status.region = account.region;
      }
      if (account.orgId !== null && account.orgId !== "") {
        status.orgId = account.orgId;
      }
    } else {
      status.expiresAt = account.expiresAt;
    }
    if (
      (account.agent === "gemini" || account.agent === "antigravity") &&
      account.project !== null
    ) {
      status.project = account.project;
    }
    return status;
  });
}

/** A sign-in that still works: not lapsed, and its access token not expired. */
export function subscriptionAccountUsable(account: SubscriptionAccount, now: number): boolean {
  if (account.lapsed !== null) {
    return false;
  }
  switch (account.agent) {
    case "copilot":
      return account.githubToken.length > 0;
    case "factory":
      return account.key.length > 0;
    case "chatgpt-api":
    case "gemini":
    case "antigravity":
      // A token that says nothing about its expiry is left to the vendor.
      return account.expiresAt === 0 || account.expiresAt > now;
  }
}

function isAccountOf(value: Record<string, unknown>, agent: SubscriptionAgent): boolean {
  return hasAccountBase(value) && value.agent === agent && hasAgentFields(value, agent);
}

function hasAccountBase(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.user === "string" &&
    (value.plan === null || typeof value.plan === "string") &&
    (value.lapsed === null || typeof value.lapsed === "string") &&
    typeof value.addedAt === "number"
  );
}

function hasAgentFields(value: Record<string, unknown>, agent: SubscriptionAgent): boolean {
  switch (agent) {
    case "chatgpt-api":
      return (
        typeof value.clientId === "string" &&
        typeof value.hostId === "string" &&
        typeof value.accessToken === "string" &&
        typeof value.refreshToken === "string" &&
        typeof value.expiresAt === "number" &&
        Array.isArray(value.scopes)
      );
    case "copilot":
      return typeof value.githubToken === "string" && typeof value.host === "string";
    case "gemini":
    case "antigravity":
      return (
        typeof value.accessToken === "string" &&
        typeof value.refreshToken === "string" &&
        typeof value.expiresAt === "number"
      );
    case "factory":
      return typeof value.key === "string" && value.key.length > 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
