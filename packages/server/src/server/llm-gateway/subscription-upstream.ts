import type { GatewayAccount } from "./config.js";
import { loadSubscriptionAccount, subscriptionAuth } from "./subscription-auth.js";
import {
  loadSubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  updateSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionAgent,
} from "./subscription-store.js";

/**
 * A provider account signed in to a vendor's own subscription (page-subs'
 * `subscription-auth.ts`): the gateway signs the request with the store's
 * sign-in and tells the caller about a renewal or a lapse, which the store
 * keeps like myna keeps its logins (`provider/logins.go`).
 */

/** The sign-in an account names, or the first of its agent's. */
export interface PreparedSubscription {
  agent: SubscriptionAgent;
  /** Headers the sign-in adds, over the provider's and account's. */
  headers: Record<string, string>;
  /** Where the request goes instead of the provider's or account's base. */
  baseUrl?: string;
  /** The Google Cloud project Code Assist bills, when the sign-in knows one. */
  project?: string | null;
}

export type SubscriptionPreparation = PreparedSubscription | { skip: string } | null;

/** Thrown by `requestUpstream` when an account's sign-in can't serve it: the
 * attempt is skipped without resting the account (myna skips a lapsed login). */
export class SubscriptionSkippedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "SubscriptionSkippedError";
  }
}

export async function prepareSubscriptionUpstream(input: {
  account: GatewayAccount;
  gatewayDir: string;
  proxy?: string;
  /** The user's "read no sign-in" switch; Copilot's own sign-ins obey it. */
  accountDiscovery?: boolean;
}): Promise<SubscriptionPreparation> {
  const agent = input.account.agent;
  // The Claude subscription is served by driving Claude Code (`claude/serve`),
  // not by signing an upstream request here.
  if (agent === undefined || agent === "claude-code") {
    return null;
  }
  const user = input.account.subscriptionUser ?? "";
  const found = await loadSubscriptionAccount(
    input.gatewayDir,
    agent,
    user,
    input.accountDiscovery === undefined ? undefined : { discovery: input.accountDiscovery },
  );
  if (found === null) {
    return { skip: `no ${agent} sign-in named ${user === "" ? "(the first)" : user}` };
  }
  if (found.lapsed !== null) {
    return { skip: `${agent} sign-in lapsed: ${found.lapsed}` };
  }
  const auth = await subscriptionAuth(
    found,
    input.proxy === undefined ? {} : { proxy: input.proxy },
  );
  if ("error" in auth) {
    if (auth.lapsed !== undefined) {
      await persistSubscription(input.gatewayDir, agent, found.id, (account) => ({
        ...account,
        lapsed: auth.lapsed ?? account.lapsed,
      }));
    }
    return { skip: auth.error };
  }
  if (auth.renewed !== undefined) {
    await persistSubscription(
      input.gatewayDir,
      agent,
      auth.renewed.id,
      () => auth.renewed as SubscriptionAccount,
    );
  }
  return {
    agent,
    headers: auth.headers,
    ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
    ...(found.agent === "gemini" || found.agent === "antigravity"
      ? { project: found.project }
      : {}),
  };
}

/**
 * Writes one account back after a renewal or a lapse. A sign-in the user's
 * own tool keeps (Copilot's CLI) is read, never stored: the write is skipped
 * when the account is not in the store.
 */
async function persistSubscription(
  gatewayDir: string,
  agent: SubscriptionAgent,
  id: string,
  change: (account: SubscriptionAccount) => SubscriptionAccount,
): Promise<void> {
  const file = subscriptionAccountsFile(gatewayDir, agent);
  const accounts = await loadSubscriptionAccounts(file, agent);
  if (!accounts.some((account) => account.id === id)) {
    return;
  }
  // A renewed sign-in replaces its row; a lapse is kept on it. A store that
  // can't be written leaves the request to run with the token it has.
  const next = updateSubscriptionAccount(accounts, id, change);
  await saveSubscriptionAccounts(file, next).catch(() => undefined);
}
