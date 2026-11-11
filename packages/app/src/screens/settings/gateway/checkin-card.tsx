import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayCheckinAccountWire } from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { maskAccount } from "@/usage/mask-account";

type CheckinAccount = GatewayCheckinAccountWire;

const VENDORS = ["workbuddy", "minimax", "trae", "qoder"] as const;

/**
 * The daily check-ins, as myna's Usage page shows them: one row per
 * signed-in account, what the last press came to, and the vendor switches
 * that let the daemon press on its own.
 */
export function GatewayCheckinSection({
  serverId,
  maskAccounts,
}: {
  serverId: string;
  maskAccounts: boolean;
}) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "gatewayCheckin");
  const client = useHostRuntimeClient(serverId);
  const [accounts, setAccounts] = useState<CheckinAccount[]>([]);
  const [switches, setSwitches] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supported || !client) {
      return;
    }
    let cancelled = false;
    void client
      .getGatewayCheckin()
      .then((payload) => {
        if (!cancelled) {
          setAccounts(payload.accounts);
          setSwitches(payload.switches ?? {});
        }
        return undefined;
      })
      .catch(() => {
        // An older daemon, or a read that failed: the section stays hidden.
      });
    return () => {
      cancelled = true;
    };
  }, [client, supported]);

  const run = useCallback(() => {
    if (!client || running) {
      return;
    }
    setRunning(true);
    setError(null);
    void client
      .runGatewayCheckin()
      .then((payload) => {
        setAccounts(payload.accounts);
        setSwitches(payload.switches ?? {});
        return undefined;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setRunning(false));
  }, [client, running]);

  const setSwitch = useCallback(
    (by: string, on: boolean) => {
      if (!client) {
        return;
      }
      void client
        .setGatewayCheckinSwitch(by, on)
        .then((payload) => {
          setSwitches(payload.switches ?? {});
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [client],
  );

  const setAccountOn = useCallback(
    (key: string, on: boolean) => {
      if (!client) {
        return;
      }
      void client
        .setGatewayCheckinAccount(key, on)
        .then((payload) => {
          setAccounts(payload.accounts);
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [client],
  );

  if (!supported || accounts.length === 0) {
    return null;
  }

  const vendorName = (by: string): string => {
    if (by === "workbuddy") return t("settings.gatewayPages.usage.checkin.vendorWorkbuddy");
    if (by === "minimax") return t("settings.gatewayPages.usage.checkin.vendorMinimax");
    if (by === "trae") return t("settings.gatewayPages.usage.checkin.vendorTrae");
    if (by === "qoder") return t("settings.gatewayPages.usage.checkin.vendorQoder");
    return by;
  };

  const said = (account: CheckinAccount): string => {
    const record = account.record;
    if (record === undefined) {
      return t("settings.gatewayPages.usage.checkin.outcome.never");
    }
    const credit = record.credit !== undefined && record.credit > 0 ? record.credit : undefined;
    switch (record.outcome) {
      case "claimed":
        return credit === undefined
          ? t("settings.gatewayPages.usage.checkin.outcome.claimed")
          : t("settings.gatewayPages.usage.checkin.outcome.claimedCredit", { credit });
      case "done":
        return credit === undefined
          ? t("settings.gatewayPages.usage.checkin.outcome.done")
          : t("settings.gatewayPages.usage.checkin.outcome.doneCredit", { credit });
      case "ineligible":
        return t("settings.gatewayPages.usage.checkin.outcome.ineligible");
      case "inactive":
        return t("settings.gatewayPages.usage.checkin.outcome.inactive");
      case "captcha":
        return t("settings.gatewayPages.usage.checkin.outcome.captcha");
      case "own-app":
        return t("settings.gatewayPages.usage.checkin.outcome.ownApp");
      default:
        return t("settings.gatewayPages.usage.checkin.outcome.failed");
    }
  };

  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.gatewayPages.usage.checkin.title")}</Text>
        <Button variant="ghost" size="sm" onPress={run} loading={running}>
          {running
            ? t("settings.gatewayPages.usage.checkin.checking")
            : t("settings.gatewayPages.usage.checkin.now")}
        </Button>
      </View>
      {accounts.map((account) => (
        <AccountRow
          key={account.key}
          account={account}
          maskedUser={maskAccounts ? maskAccount(account.user) : account.user}
          vendor={vendorName(account.by)}
          said={said(account)}
          againLabel={t("settings.gatewayPages.usage.checkin.again")}
          offLabel={t("settings.gatewayPages.usage.checkin.accountOff")}
          switchLabel={t("settings.gatewayPages.usage.checkin.accountSwitch", {
            user: account.user,
          })}
          onSetOn={setAccountOn}
        />
      ))}
      <View style={styles.vendors}>
        {VENDORS.map((vendor) => (
          <VendorRow
            key={vendor}
            vendor={vendor}
            name={vendorName(vendor)}
            value={switches[vendor] === true}
            onSet={setSwitch}
          />
        ))}
      </View>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function AccountRow({
  account,
  maskedUser,
  vendor,
  said,
  againLabel,
  offLabel,
  switchLabel,
  onSetOn,
}: {
  account: CheckinAccount;
  maskedUser: string;
  vendor: string;
  said: string;
  againLabel: string;
  offLabel: string;
  switchLabel: string;
  onSetOn: (key: string, on: boolean) => void;
}) {
  const toggle = useCallback((on: boolean) => onSetOn(account.key, on), [account.key, onSetOn]);
  return (
    <View style={styles.row}>
      <View style={styles.main}>
        <Text style={styles.user} numberOfLines={1}>
          {maskedUser}
        </Text>
        <Text style={styles.hint} numberOfLines={2}>
          {`${vendor} · ${said}${account.again === true ? ` · ${againLabel}` : ""}`}
        </Text>
        {account.on ? null : <Text style={styles.hint}>{offLabel}</Text>}
      </View>
      <Switch value={account.on} onValueChange={toggle} accessibilityLabel={switchLabel} />
    </View>
  );
}

function VendorRow({
  vendor,
  name,
  value,
  onSet,
}: {
  vendor: string;
  name: string;
  value: boolean;
  onSet: (by: string, on: boolean) => void;
}) {
  const toggle = useCallback((on: boolean) => onSet(vendor, on), [onSet, vendor]);
  return (
    <View style={styles.row}>
      <Text style={styles.user}>{name}</Text>
      <Switch value={value} onValueChange={toggle} accessibilityLabel={name} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  main: { flex: 1, gap: theme.spacing[1] },
  user: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  vendors: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
}));
