/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- a few per-account switches in a settings form, none in a hot list. */
import { useCallback, useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SettingsInfoTip, SettingsRow, SettingsSelect } from "@/components/settings";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { toErrorMessage } from "@/utils/error-messages";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { useSettingsHostServerId } from "./shared";

type GatewayAccount = NonNullable<
  NonNullable<GatewayConfigWire["providers"]>[number]["accounts"]
>[number];
type AutoResetMode = NonNullable<GatewayAccount["autoReset"]>;

function withoutAutoReset(account: GatewayAccount): GatewayAccount {
  const { autoReset: _autoReset, ...rest } = account;
  return rest;
}

function casesOf(mode: AutoResetMode | undefined): { week: boolean; expiring: boolean } {
  return {
    week: mode === "week" || mode === "auto",
    expiring: mode === "expiring" || mode === "auto",
  };
}

function modeOf(week: boolean, expiring: boolean): AutoResetMode | undefined {
  if (week && expiring) {
    return "auto";
  }
  if (week) {
    return "week";
  }
  return expiring ? "expiring" : undefined;
}

// myna's RESET_LEADS and resetLeadMinutes (app.js), mirrored from the
// server's codex-reset.ts: half an hour unless set, out of range reads 30.
const RESET_LEADS = [15, 30, 60, 120, 180, 360, 720, 1440] as const;
const RESET_LEAD_DEFAULT = 30;
const RESET_LEAD_LEAST = 15;
const RESET_LEAD_MOST = 24 * 60;

function resetLeadMinutes(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RESET_LEAD_LEAST &&
    value <= RESET_LEAD_MOST
    ? value
    : RESET_LEAD_DEFAULT;
}

/** myna's resetLeadWords: minutes under an hour or not whole hours, hours otherwise. */
function leadWords(minutes: number, t: TFunction): string {
  return minutes < 60 || minutes % 60
    ? t("settings.pages.quota.resetLeadMinutes", { n: minutes })
    : t("settings.pages.quota.resetLeadHours", { n: minutes / 60 });
}

/**
 * myna's Auto-use resets (codex_autoreset.go, codex_expiring.go), on the
 * Usage page: whether an account spends a Codex rate-limit reset by itself
 * when its week runs out or before one expires. How long before it runs
 * out that happens is myna's CodexResetLead, one choice shared by every
 * account, kept in `gateway.json` (`codexResetLead`).
 */
export function CodexResetRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const { config, save } = useGatewayConfig(serverId);

  // Only an account Neolix signed in to ChatGPT itself holds a Codex
  // reset; an API key account has none.
  const accounts = useMemo(() => {
    const rows: { providerId: string; providerLabel: string; account: GatewayAccount }[] = [];
    for (const provider of config?.providers ?? []) {
      for (const account of provider.accounts ?? []) {
        if (account.codexAccountId !== undefined) {
          rows.push({
            providerId: provider.id,
            providerLabel: provider.label ?? provider.id,
            account,
          });
        }
      }
    }
    return rows;
  }, [config?.providers]);

  const setAutoReset = useCallback(
    (providerId: string, accountId: string, mode: AutoResetMode | undefined) => {
      if (config === null) {
        return;
      }
      const providers = config.providers ?? [];
      const providerAt = providers.findIndex((provider) => provider.id === providerId);
      const provider = providers[providerAt];
      if (provider === undefined) {
        return;
      }
      const providerAccounts = provider.accounts ?? [];
      const accountAt = providerAccounts.findIndex((account) => account.id === accountId);
      const account = providerAccounts[accountAt];
      if (account === undefined) {
        return;
      }
      const updated =
        mode === undefined ? withoutAutoReset(account) : { ...account, autoReset: mode };
      void save({
        ...config,
        providers: [
          ...providers.slice(0, providerAt),
          {
            ...provider,
            accounts: [
              ...providerAccounts.slice(0, accountAt),
              updated,
              ...providerAccounts.slice(accountAt + 1),
            ],
          },
          ...providers.slice(providerAt + 1),
        ],
      }).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [config, save, toast],
  );

  const lead = resetLeadMinutes(config?.codexResetLead);
  // A value outside the choices (the CLI takes any minutes in range) is
  // shown in place and kept, as myna does.
  const leadOptions = useMemo(() => {
    const choices: number[] = (RESET_LEADS as readonly number[]).includes(lead)
      ? [...RESET_LEADS]
      : [...RESET_LEADS, lead].sort((a, b) => a - b);
    return choices.map((minutes) => ({
      value: String(minutes),
      label: t("settings.pages.quota.resetLeadBefore", { lead: leadWords(minutes, t) }),
    }));
  }, [lead, t]);
  const changeLead = useCallback(
    (value: string) => {
      if (config === null) {
        return;
      }
      void save({ ...config, codexResetLead: Number(value) }).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [config, save, toast],
  );

  if (config === null || accounts.length === 0) {
    return null;
  }

  return (
    <>
      {accounts.map(({ providerId, providerLabel, account }) => {
        const when = casesOf(account.autoReset);
        const name = account.label ?? account.id;
        const change = (next: { week: boolean; expiring: boolean }) => {
          setAutoReset(providerId, account.id, modeOf(next.week, next.expiring));
        };
        return (
          <SettingsRow
            key={`${providerId}/${account.id}`}
            label={name}
            hint={providerLabel}
            testID={`codex-auto-reset-${providerId}-${account.id}`}
          >
            <View style={styles.cases}>
              <View style={styles.case}>
                <Text style={styles.caseLabel}>{t("settings.pages.quota.autoResetWeek")}</Text>
                <Switch
                  value={when.week}
                  onValueChange={(week) => change({ week, expiring: when.expiring })}
                  accessibilityLabel={`${name}: ${t("settings.pages.quota.autoResetWeek")}`}
                />
              </View>
              <View style={styles.case}>
                <Text style={styles.caseLabel}>{t("settings.pages.quota.autoResetExpiring")}</Text>
                <SettingsInfoTip
                  title={t("settings.pages.quota.autoResetExpiring")}
                  info={t("settings.pages.quota.autoResetExpiringLead", {
                    lead: leadWords(lead, t),
                  })}
                  testID="codex-reset-expiring-info"
                />
                <Switch
                  value={when.expiring}
                  onValueChange={(expiring) => change({ week: when.week, expiring })}
                  accessibilityLabel={`${name}: ${t("settings.pages.quota.autoResetExpiring")}`}
                />
              </View>
            </View>
          </SettingsRow>
        );
      })}
      <SettingsSelect
        label={t("settings.pages.quota.codexResetLead")}
        hint={t("settings.pages.quota.codexResetLeadHint")}
        value={String(lead)}
        options={leadOptions}
        onValueChange={changeLead}
        testID="codex-reset-lead"
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  cases: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  case: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  caseLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
