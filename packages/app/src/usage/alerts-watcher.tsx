import { useEffect, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { useAppSettings } from "@/hooks/use-settings";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { sendOsNotification } from "@/utils/os-notifications";
import { useUsageAlertSettings } from "./alert-settings";
import { findDueQuotaAlerts, type QuotaAlert, type QuotaAlertPreferences } from "./alerts";
import { findDueBalanceAlerts, parseBalanceAmount, type BalanceReading } from "./balance-alerts";

/** A read every five minutes is enough for a percentage threshold. */
const ALERT_POLL_MS = 5 * 60_000;
/** Vendors' balance endpoints are slower and rate-limited; read them less often. */
const BALANCE_POLL_MS = 15 * 60_000;

// One process, one set: a window that notified stays quiet until it resets.
const notifiedKeys = new Set<string>();

/**
 * myna's allowance alerts: a notification when an allowance window reaches the
 * share used the user set, and one before a weekly window renews with room
 * left. Runs above the screens, once per connected host.
 */
export function QuotaAlertWatcher() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostQuotaAlerts key={host.serverId} serverId={host.serverId} />
      ))}
    </>
  );
}

function HostQuotaAlerts({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  // The threshold is the host's when it keeps one, this app's before that.
  const { usageAlertPercent } = useUsageAlertSettings(serverId);
  const preferences = useMemo<QuotaAlertPreferences>(
    () => ({
      usagePercent: usageAlertPercent,
      resetHours: settings.resetReminderHours,
    }),
    [settings.resetReminderHours, usageAlertPercent],
  );
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  useEffect(() => {
    if (client === null || !isConnected) {
      return;
    }
    if (preferences.usagePercent <= 0 && preferences.resetHours <= 0) {
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const quota = await client.getGatewayQuota({ historyDays: 1 });
        if (cancelled) {
          return;
        }
        const due = findDueQuotaAlerts({
          quota: quota.quota,
          preferences,
          notified: notifiedKeys,
          now: Date.now(),
        });
        for (const alert of due) {
          const key = `${serverId}|${alert.key}`;
          if (notifiedKeys.has(key)) {
            continue;
          }
          notifiedKeys.add(key);
          void sendOsNotification(notificationFor(alert, t));
        }
      } catch {
        // Hosts without gateway quotas, or without an account that reports
        // them, say so; an alert watcher has nothing to do then.
      }
    };
    void read();
    const timer = setInterval(() => void read(), ALERT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, isConnected, preferences, serverId, t]);

  return null;
}

// One process, one set per host: a balance that alerted stays quiet until it
// is topped up past the threshold again.
const belowBalances = new Map<string, Set<string>>();

/**
 * myna's balance alert: a key or account whose balance fell to the amount the
 * user set, in that balance's own currency or credits. Reads the vendors'
 * balance endpoints, so it polls less often than allowances do.
 */
export function BalanceAlertWatcher() {
  const hosts = useHosts();
  return (
    <>
      {hosts.map((host) => (
        <HostBalanceAlerts key={host.serverId} serverId={host.serverId} />
      ))}
    </>
  );
}

function HostBalanceAlerts({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const { config } = useGatewayConfig(serverId);
  const { balanceAlert: threshold } = useUsageAlertSettings(serverId);

  useEffect(() => {
    if (client === null || !isConnected || config === null) {
      return;
    }
    if (threshold <= 0) {
      return;
    }
    let cancelled = false;
    const below = belowFor(serverId);
    const read = async () => {
      const readings = await readBalances(client, config);
      if (cancelled) {
        return;
      }
      const due = findDueBalanceAlerts({ readings, threshold, below });
      for (const alert of due) {
        void sendOsNotification({
          title: t("settings.pages.quota.balanceAlertTitle", { account: alert.accountLabel }),
          body: t("settings.pages.quota.balanceAlertBody", {
            provider: alert.providerLabel,
            amount: alert.text,
          }),
        });
      }
    };
    void read().catch(() => undefined);
    const timer = setInterval(() => void read().catch(() => undefined), BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, config, isConnected, serverId, t, threshold]);

  return null;
}

function belowFor(serverId: string): Set<string> {
  const existing = belowBalances.get(serverId);
  if (existing !== undefined) {
    return existing;
  }
  const created = new Set<string>();
  belowBalances.set(serverId, created);
  return created;
}

interface BalanceTarget {
  balanceUrl: string;
  balancePath?: string;
  apiKey?: string;
  baseUrls?: string[];
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  token?: string;
}

interface BalanceReader {
  getGatewayProviderBalance(target: BalanceTarget): Promise<{ amount: string | null }>;
}

type Provider = NonNullable<GatewayConfigWire["providers"]>[number];
type Account = NonNullable<Provider["accounts"]>[number];

/** One read per enabled account with a key; a provider without balance settings asks its vendor's default. */
async function readBalances(
  client: BalanceReader,
  config: GatewayConfigWire,
): Promise<BalanceReading[]> {
  const readings: BalanceReading[] = [];
  for (const provider of config.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    for (const account of provider.accounts?.length ? provider.accounts : [null]) {
      const reading = await readAccount(client, provider, account);
      if (reading !== null) {
        readings.push(reading);
      }
    }
  }
  return readings;
}

async function readAccount(
  client: BalanceReader,
  provider: Provider,
  account: Account | null,
): Promise<BalanceReading | null> {
  if (account !== null && account.enabled === false) {
    return null;
  }
  const apiKey = account?.apiKey ?? provider.apiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }
  const parses = parseBalanceAmount(
    await readBalance(client, balanceTarget(provider, account, apiKey)),
  );
  if (parses === null) {
    return null;
  }
  return {
    key: `${provider.id}/${account?.id ?? "default"}`,
    providerLabel: provider.label ?? provider.id,
    accountLabel: account?.label ?? account?.id ?? provider.label ?? provider.id,
    text: parses.text,
    value: parses.value,
  };
}

function balanceTarget(provider: Provider, account: Account | null, apiKey: string): BalanceTarget {
  const baseUrls = [provider.baseUrl, account?.baseUrl].filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );
  return {
    balanceUrl: provider.balanceUrl ?? "",
    ...(provider.balancePath === undefined ? {} : { balancePath: provider.balancePath }),
    apiKey,
    ...(baseUrls.length === 0 ? {} : { baseUrls }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    ...(provider.balanceMethod === undefined ? {} : { method: provider.balanceMethod }),
    ...(provider.balanceToken === undefined ? {} : { token: provider.balanceToken }),
  };
}

async function readBalance(client: BalanceReader, target: BalanceTarget): Promise<string | null> {
  try {
    const answer = await client.getGatewayProviderBalance(target);
    return answer.amount;
  } catch {
    // A vendor that refuses or times out simply has no reading this round.
    return null;
  }
}

function notificationFor(alert: QuotaAlert, t: TFunction): { title: string; body: string } {
  if (alert.kind === "reset") {
    const hours = Math.max(1, Math.round(alert.hoursLeft ?? 1));
    return {
      title: t("settings.pages.quota.alertResetTitle", { account: alert.accountLabel }),
      body: t("settings.pages.quota.alertResetBody", {
        provider: alert.providerLabel,
        hours,
      }),
    };
  }
  return {
    title: t("settings.pages.quota.alertUsageTitle", {
      account: alert.accountLabel,
      percent: Math.round(alert.usedPercent),
    }),
    body: t("settings.pages.quota.alertUsageBody", { provider: alert.providerLabel }),
  };
}
