import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type { SubscriptionAgent } from "@neolix/server/gateway-accounts";
import { tryConnectToDaemon, type ConnectOptions } from "../../utils/client.js";
import { accountRowOf, type AccountRow } from "./accounts.js";

/**
 * The account list and removal ask the daemon first. It writes the same
 * stores, so a CLI that rewrites one behind its back can race the daemon's
 * own write; only a daemon that doesn't answer, or one too old to know the
 * RPCs, leaves the files to the CLI.
 */

type Daemon = Awaited<ReturnType<typeof tryConnectToDaemon>>;

export interface AccountsRpcOptions {
  target: ConnectOptions["target"];
  /** Injected by tests; the command tries the selected daemon. */
  connect?: typeof tryConnectToDaemon;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 1_500;

/**
 * Runs `work` against a daemon that can serve subscription accounts.
 * `undefined` means there was none: unreachable, or a version without the
 * RPCs, and the caller reads the files instead.
 */
async function withAccountsDaemon<T>(
  options: AccountsRpcOptions,
  work: (client: NonNullable<Daemon>) => Promise<T>,
  feature = "gatewaySubscriptionAccounts",
): Promise<T | undefined> {
  const connect = options.connect ?? tryConnectToDaemon;
  let client: Daemon;
  try {
    client = await connect({
      target: options.target,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if (client === null) {
    return undefined;
  }
  try {
    const features = client.getLastServerInfoMessage()?.features;
    const supported =
      (features as Record<string, boolean | undefined> | undefined)?.[feature] === true;
    if (!supported) {
      return undefined;
    }
    return await work(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Checks accounts in through the daemon, which holds the check-in files. */
export async function checkinViaDaemon(
  options: AccountsRpcOptions,
  query: { by?: string; key?: string },
): Promise<CheckinEntry[] | undefined> {
  return withAccountsDaemon(
    options,
    async (client) => (await client.runGatewayCheckin(query)).entries,
    "gatewayCheckin",
  );
}

/** One account as a press found it. */
export type CheckinEntry = Awaited<
  ReturnType<DaemonClient["runGatewayCheckin"]>
>["entries"][number];

/** The subscription providers running plugins declare. */
export async function listPluginSubscriptionsViaDaemon(
  options: AccountsRpcOptions,
): Promise<Awaited<ReturnType<DaemonClient["getGatewayPluginSubscriptions"]>> | undefined> {
  return withAccountsDaemon(
    options,
    (client) => client.getGatewayPluginSubscriptions(),
    "gatewayPluginSubscriptions",
  );
}

/** An account's models from a plugin's subscription provider. */
export async function pluginSubscriptionModelsViaDaemon(
  options: AccountsRpcOptions,
  query: { pluginId: string; providerId: string; accountId: string },
): Promise<Awaited<ReturnType<DaemonClient["getGatewayPluginSubscriptionModels"]>> | undefined> {
  return withAccountsDaemon(
    options,
    (client) => client.getGatewayPluginSubscriptionModels(query),
    "gatewayPluginSubscriptions",
  );
}

/** Runs a plugin's sign-in; the plugin keeps the result under the account id. */
export async function pluginSubscriptionSignInViaDaemon(
  options: AccountsRpcOptions,
  query: {
    pluginId: string;
    providerId: string;
    method: number;
    accountId: string;
    inputs?: Record<string, string>;
  },
): Promise<Awaited<ReturnType<DaemonClient["signInGatewayPluginSubscription"]>> | undefined> {
  return withAccountsDaemon(
    options,
    (client) => client.signInGatewayPluginSubscription(query),
    "gatewayPluginSubscriptions",
  );
}

/** Whether a pending sign-in has been authorized yet. */
export async function pluginSubscriptionSignInPollViaDaemon(
  options: AccountsRpcOptions,
  query: { pluginId: string; providerId: string; token: string },
): Promise<Awaited<ReturnType<DaemonClient["pollGatewayPluginSubscriptionSignIn"]>> | undefined> {
  return withAccountsDaemon(
    options,
    (client) => client.pollGatewayPluginSubscriptionSignIn(query),
    "gatewayPluginSubscriptions",
  );
}

/** The accounts the daemon lists, or undefined when it isn't there to ask. */
export async function listAccountsViaDaemon(
  options: AccountsRpcOptions,
  agent: SubscriptionAgent | undefined,
): Promise<AccountRow[] | undefined> {
  return withAccountsDaemon(options, async (client) => {
    const answer = await client.listGatewaySubscriptionAccounts(
      agent === undefined ? {} : { agent },
    );
    return answer.accounts.map((account) =>
      accountRowOf({ ...account, agent: account.agent as SubscriptionAgent }),
    );
  });
}

/**
 * Removes an account through the daemon. `undefined` means the daemon
 * couldn't be asked; `false` means it answered and holds no such account.
 */
export async function removeAccountViaDaemon(
  options: AccountsRpcOptions,
  agent: SubscriptionAgent,
  ref: string,
): Promise<boolean | undefined> {
  return withAccountsDaemon(options, async (client) => {
    const answer = await client.removeGatewaySubscriptionAccount({ agent, user: ref });
    return answer.ok;
  });
}
