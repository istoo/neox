import { accountKey, type AccountRoutingState } from "./accounts.js";
import { providerAccounts, type GatewayAccount, type GatewayProvider } from "./config.js";

/**
 * Careful caps (myna's cap_careful.go): a capped account's usage is read
 * again before a request goes to it near its cap, and while its usage can't
 * be told it is held, as one at its cap is. Off, the default, routing goes by
 * the last reading, refreshed each minute in the background.
 */

/** Within this many percent of a cap, a stale reading is read again. */
export const CAREFUL_NEAR_PERCENT = 5;
export const CAREFUL_FRESH_MS = 15_000;
export const CAREFUL_OLD_MS = 5 * 60_000;
export const CAREFUL_WAIT_MS = 10_000;
/** An account whose reading failed is asked again at most this often. */
export const CAREFUL_RETRY_MS = 15_000;

const lastTried = new Map<string, number>();

/** The account has a cap whose usage its own endpoint reports. */
export function isCapped(account: GatewayAccount): boolean {
  if (account.usageUrl !== undefined) {
    return true;
  }
  if (account.monthlyUsd !== undefined) {
    return true;
  }
  return account.quota?.tokens5h !== undefined || account.quota?.tokens7d !== undefined;
}

/**
 * Why this account can't be sent a request on what is known of its usage, or
 * null when it can: never read, older than five minutes, or near its cap
 * with a reading older than fifteen seconds.
 */
export function carefulDoubt(
  provider: GatewayProvider,
  account: GatewayAccount,
  state: AccountRoutingState,
  now: number,
): string | null {
  if (provider.capCareful !== true || !isCapped(account)) {
    return null;
  }
  const reading = state.usage.get(accountKey(provider, account));
  if (reading === undefined) {
    return "its usage hasn't been read yet";
  }
  const age = now - reading.readAt;
  if (age > CAREFUL_OLD_MS) {
    return `its usage was last read ${Math.round(age / 1000)}s ago`;
  }
  const near = reading.usedPercent !== null && reading.usedPercent >= 100 - CAREFUL_NEAR_PERCENT;
  if (near && age > CAREFUL_FRESH_MS) {
    return `it is near its cap and its usage was last read ${Math.round(age / 1000)}s ago`;
  }
  return null;
}

/** The accounts of careful providers a request must leave alone now. */
export function carefulHeldAccounts(
  providers: readonly GatewayProvider[],
  state: AccountRoutingState,
  now: number,
): Set<string> {
  const held = new Set<string>();
  for (const provider of providers) {
    if (provider.capCareful !== true) {
      continue;
    }
    for (const account of providerAccounts(provider)) {
      if (carefulDoubt(provider, account, state, now) !== null) {
        held.add(accountKey(provider, account));
      }
    }
  }
  return held;
}

/** Reads again the usage of each account carefulDoubt would hold, at most once per retry. */
export async function readCareful(
  providers: readonly GatewayProvider[],
  state: AccountRoutingState,
  refresh: (provider: GatewayProvider, account: GatewayAccount) => Promise<void>,
  now: number = Date.now(),
): Promise<void> {
  const wanted: Array<{ provider: GatewayProvider; account: GatewayAccount }> = [];
  for (const provider of providers) {
    if (provider.capCareful !== true) {
      continue;
    }
    for (const account of providerAccounts(provider)) {
      if (carefulDoubt(provider, account, state, now) === null) {
        continue;
      }
      const key = accountKey(provider, account);
      const tried = lastTried.get(key) ?? 0;
      if (now - tried < CAREFUL_RETRY_MS) {
        continue;
      }
      lastTried.set(key, now);
      wanted.push({ provider, account });
    }
  }
  if (wanted.length === 0) {
    return;
  }
  await Promise.race([
    Promise.all(wanted.map(({ provider, account }) => refresh(provider, account))),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CAREFUL_WAIT_MS);
      timer.unref();
    }),
  ]);
}

/** Forgets the retry bookkeeping, for tests. */
export function forgetCarefulTries(): void {
  lastTried.clear();
}
