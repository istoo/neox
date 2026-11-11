// FILE: GatewayAllowancesPane.tsx
// Purpose: Account allowances — 5-hour and 7-day windows, spend, warm-up and
//          reset actions, plus the agent warm-at schedules.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type { GatewayConfig, GatewayQuotaAccount, GatewayQuotaWindow } from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { invalidWarmAts } from "./gatewayDraftValidation";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { SettingsSection } from "../SettingsPanelPrimitives";
import {
  formatCountdown,
  formatPercent,
  formatTokens,
  formatUsd,
  formatWhen,
} from "./gatewayHelpers";
import { GatewayEmpty, GatewayField, GatewayPill, GatewayRow } from "./GatewayPrimitives";

export interface GatewayAllowancesProps {
  config: GatewayConfig;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

type Translate = ReturnType<typeof useTranslation>["t"];

async function runReadNow(
  historyDays: number,
  refetch: () => Promise<unknown>,
  setReading: (value: boolean) => void,
): Promise<void> {
  setReading(true);
  try {
    await neolixGatewayApi.getQuota({ historyDays, read: true });
    await refetch();
  } finally {
    setReading(false);
  }
}

async function runWarmAccount(
  provider: string,
  account: string,
  translate: Translate,
  reload: () => void,
): Promise<void> {
  try {
    const result = await neolixGatewayApi.warmAccount({ provider, account });
    toastManager.add({
      type: result.error ? "error" : "success",
      title: result.error ?? translate("gateway:warmed", { status: result.status ?? 0 }),
    });
    reload();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runResetQuota(
  account: string,
  translate: Translate,
  reload: () => void,
): Promise<void> {
  try {
    const result = await neolixGatewayApi.resetQuota({ account, confirm: true });
    toastManager.add({
      type: result.spent ? "success" : "error",
      title: result.spent ? translate("gateway:reset_ok", { count: result.windows }) : result.code,
      ...(result.error ? { description: result.error } : {}),
    });
    reload();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runAccountWarmSave(
  providerId: string,
  accountId: string,
  next: string,
  translate: Translate,
  setBusy: (value: boolean) => void,
): Promise<void> {
  setBusy(true);
  try {
    await neolixGatewayApi.setAccountWarmAt({
      provider: providerId,
      account: accountId,
      at: next,
    });
    toastManager.add({ type: "success", title: translate("gateway:saved") });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setBusy(false);
  }
}

export function GatewayAllowancesPane({ config, apply }: GatewayAllowancesProps) {
  const { t } = useTranslation();
  const [historyDays, setHistoryDays] = useState(2);
  const [reading, setReading] = useState(false);
  const quota = useQuery({
    queryKey: ["neolix-gateway", "quota", historyDays],
    queryFn: () => neolixGatewayApi.getQuota({ historyDays }),
  });
  const accounts = quota.data?.quota.accounts ?? [];

  const readNow = () => runReadNow(historyDays, quota.refetch, setReading);

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:allowances_title">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <select
            value={historyDays}
            onChange={(event) => setHistoryDays(Number(event.currentTarget.value))}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value={2}>{t("gateway:days_2")}</option>
            <option value={7}>{t("gateway:days_7")}</option>
            <option value={30}>{t("gateway:days_30")}</option>
            <option value={45}>{t("gateway:days_45")}</option>
          </select>
          <Button size="xs" variant="outline" disabled={reading} onClick={() => void readNow()}>
            {reading ? t("gateway:reading") : t("gateway:read_now")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void quota.refetch()}>
            {t("gateway:refresh")}
          </Button>
          {quota.data ? (
            <span className="text-ui-xs text-muted-foreground">
              {t("gateway:until", { when: formatWhen(quota.data.quota.until) })}
            </span>
          ) : null}
        </div>
        {quota.isLoading ? (
          <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
        ) : quota.error ? (
          <div className="px-3 py-2">
            <GatewayEmpty tone="error">{String(quota.error)}</GatewayEmpty>
          </div>
        ) : accounts.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_allowances")}</GatewayEmpty>
          </div>
        ) : (
          accounts.map((account) => (
            <AllowanceCard key={account.id} account={account} reload={() => void quota.refetch()} />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="gateway:warmup_title">
        <GatewayRow
          title={t("gateway:codex_warmup")}
          description={t("gateway:warmup_hint")}
          trailing={
            <select
              value={config.codexWarmup ?? "off"}
              onChange={(event) =>
                void apply((draft) => {
                  draft.codexWarmup = event.currentTarget.value as GatewayConfig["codexWarmup"];
                })
              }
              className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
            >
              <option value="off">off</option>
              <option value="week">week</option>
              <option value="all">all</option>
            </select>
          }
        />
        <GatewayRow
          title={t("gateway:claude_warmup")}
          description={t("gateway:warmup_hint")}
          trailing={
            <select
              value={config.claudeWarmup ?? "off"}
              onChange={(event) =>
                void apply((draft) => {
                  draft.claudeWarmup = event.currentTarget.value as GatewayConfig["claudeWarmup"];
                })
              }
              className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
            >
              <option value="off">off</option>
              <option value="week">week</option>
              <option value="all">all</option>
            </select>
          }
        />
        <WarmAtRows
          agent="codex"
          value={(config.codexWarmAts as string[] | undefined) ?? []}
          onSave={(ats) => neolixGatewayApi.setWarmAt({ agent: "codex", ats })}
        />
        <WarmAtRows
          agent="claude"
          value={(config.claudeWarmAts as string[] | undefined) ?? []}
          onSave={(ats) => neolixGatewayApi.setWarmAt({ agent: "claude", ats })}
        />
        <AccountWarmRows config={config} />
      </SettingsSection>
    </div>
  );
}

function windowTone(window: GatewayQuotaWindow): "ok" | "warn" | "error" | "muted" {
  if (window.usedPercent === null) return "muted";
  if (window.usedPercent >= 95) return "error";
  if (window.usedPercent >= 75) return "warn";
  return "ok";
}

function AllowanceCard({ account, reload }: { account: GatewayQuotaAccount; reload: () => void }) {
  const { t } = useTranslation();
  const [warmAt, setWarmAt] = useState<string | null>(null);
  const resting = account.restingUntil !== null && account.restingUntil > Date.now();

  return (
    <div className="px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ui font-medium">{account.accountLabel || account.account}</span>
            <GatewayPill>{account.providerLabel || account.provider}</GatewayPill>
            {account.kind === "plan" ? <GatewayPill>plan</GatewayPill> : null}
            {resting ? (
              <GatewayPill tone="warn">
                {t("gateway:resting", {
                  when: formatCountdown((account.restingUntil ?? 0) - Date.now()),
                })}
              </GatewayPill>
            ) : null}
            {account.warmup ? <GatewayPill tone="muted">{t("gateway:warmup")}</GatewayPill> : null}
            <GatewayPill>
              {t("gateway:spend_of", {
                spent: formatUsd(account.spendUsd),
                cap:
                  account.monthlyUsdCap === null
                    ? t("gateway:no_cap")
                    : formatUsd(account.monthlyUsdCap),
              })}
            </GatewayPill>
          </div>
          {account.error ? (
            <div className="mt-0.5 text-ui-xs text-destructive">{account.error}</div>
          ) : null}
          <div className="mt-0.5 text-ui-xs text-muted-foreground">
            {account.lastReadAt
              ? t("gateway:read_at", { when: formatWhen(account.lastReadAt) })
              : ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {account.canWarm ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => void runWarmAccount(account.provider, account.account, t, reload)}
            >
              {t("gateway:warm_now")}
            </Button>
          ) : null}
          {account.kind !== "plan" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (!window.confirm(t("gateway:reset_confirm"))) return;
                void runResetQuota(account.account, t, reload);
              }}
            >
              {t("gateway:reset_quota")}
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setWarmAt(warmAt === null ? "" : null)}>
            {t("gateway:warm_at")}
          </Button>
        </div>
      </div>

      {warmAt !== null ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <GatewayField
            label={t("gateway:warm_at_time")}
            value={warmAt}
            onChange={setWarmAt}
            placeholder="06:00"
            hint={t("gateway:warm_at_hint")}
          />
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              try {
                await neolixGatewayApi.setAccountWarmAt({
                  provider: account.provider,
                  account: account.account,
                  at: warmAt.trim(),
                });
                toastManager.add({ type: "success", title: t("gateway:saved") });
                setWarmAt(null);
                reload();
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            {t("gateway:save")}
          </Button>
        </div>
      ) : null}

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {account.windows.length === 0 ? (
          <GatewayEmpty>{t("gateway:no_windows")}</GatewayEmpty>
        ) : (
          account.windows.map((window) => (
            <div
              key={window.id}
              className="rounded-md border border-[color:var(--color-border)] p-2"
            >
              <div className="flex items-center justify-between gap-2 text-ui-sm">
                <span className="truncate">{window.name ?? window.id}</span>
                <GatewayPill tone={windowTone(window)}>
                  {formatPercent(window.usedPercent)}
                </GatewayPill>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={`h-full rounded-full ${
                    windowTone(window) === "error"
                      ? "bg-destructive"
                      : windowTone(window) === "warn"
                        ? "bg-warning"
                        : "bg-success"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, window.usedPercent ?? 0))}%` }}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-ui-xs text-muted-foreground">
                {window.remaining !== null ? (
                  <span>{t("gateway:remaining", { value: formatTokens(window.remaining) })}</span>
                ) : null}
                {window.limit !== null ? (
                  <span>{t("gateway:limit", { value: formatTokens(window.limit) })}</span>
                ) : null}
                {window.resetsAt !== null ? (
                  <span>
                    {t("gateway:resets_in", {
                      value: formatCountdown(window.resetsAt - Date.now()),
                    })}
                  </span>
                ) : null}
                {window.pacePct !== null ? (
                  <span>{t("gateway:pace", { value: Math.round(window.pacePct) })}</span>
                ) : null}
                {window.holds ? (
                  <span>
                    {t("gateway:holds", {
                      tokens: formatTokens(window.holds.tokens),
                      cost: formatUsd(window.holds.costUsd),
                    })}
                  </span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function WarmAtRows({
  agent,
  value,
  onSave,
}: {
  agent: "codex" | "claude";
  value: string[];
  onSave: (ats: string[]) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value.join(", "));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value.join(", "));
    setError(null);
  }, [value]);
  return (
    <GatewayRow
      title={t("gateway:warm_ats", { agent })}
      description={t("gateway:warm_ats_hint")}
      trailing={
        <div className="flex items-center gap-1">
          <input
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setError(null);
            }}
            aria-label={t("gateway:warm_ats", { agent })}
            placeholder="06:00, 18:00"
            className="h-7 w-40 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
          />
          <Button
            size="xs"
            variant="outline"
            onClick={async () => {
              if (invalidWarmAts(text).length > 0) {
                setError(t("gateway:warm_ats_invalid"));
                return;
              }
              try {
                await onSave(
                  text
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0),
                );
                toastManager.add({ type: "success", title: t("gateway:saved") });
              } catch (error) {
                toastManager.add({
                  type: "error",
                  title: error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            {t("gateway:save")}
          </Button>
        </div>
      }
    >
      {error === null ? null : <div className="text-ui-xs text-destructive">{error}</div>}
    </GatewayRow>
  );
}

type AccountWarmMode = "same" | "own" | "off";

function warmModeOf(at: string | undefined): AccountWarmMode {
  if (at === undefined || at === "") return "same";
  return at === "off" ? "off" : "own";
}

function aimedWarmAt(mode: AccountWarmMode, at: string, agentAts: readonly string[]): string {
  if (mode === "same") return "";
  if (mode === "off") return "off";
  return at !== "" && at !== "off" ? at : (agentAts[0] ?? "06:00");
}

/** myna's per-account warm-up: follow the agent's times, its own, or none. */
function AccountWarmRows({ config }: { config: GatewayConfig }) {
  const { t } = useTranslation();
  const accounts = (config.providers ?? []).flatMap((provider) =>
    (provider.accounts ?? []).flatMap((account) => {
      const agent =
        account.agent === "claude-code"
          ? "claude"
          : account.agent === "chatgpt-api"
            ? "codex"
            : null;
      if (agent === null) return [];
      return [
        {
          key: `${provider.id}/${account.id}`,
          providerId: provider.id,
          accountId: account.id,
          name: account.label ?? account.id,
          at: account.warmAt ?? "",
          agentAts:
            agent === "codex"
              ? ((config.codexWarmAts as string[] | undefined) ?? [])
              : ((config.claudeWarmAts as string[] | undefined) ?? []),
        },
      ];
    }),
  );
  // Shown with two accounts or more, or while one has its own time.
  const shown = accounts.filter(
    (account) => accounts.length >= 2 || (account.at !== "" && account.at !== "off"),
  );
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((account) => (
        <AccountWarmRow
          key={account.key}
          providerId={account.providerId}
          accountId={account.accountId}
          name={account.name}
          at={account.at}
          agentAts={account.agentAts}
        />
      ))}
      <div className="px-3 py-2 text-ui-xs text-muted-foreground">
        {t("gateway:account_warm_hint")}
      </div>
    </>
  );
}

function AccountWarmRow({
  providerId,
  accountId,
  name,
  at,
  agentAts,
}: {
  providerId: string;
  accountId: string;
  name: string;
  at: string;
  agentAts: readonly string[];
}) {
  const { t } = useTranslation();
  const mode = warmModeOf(at);
  const [own, setOwn] = useState(mode === "own" ? at : (agentAts[0] ?? "06:00"));
  const [busy, setBusy] = useState(false);
  const save = (next: string) => runAccountWarmSave(providerId, accountId, next, t, setBusy);
  return (
    <GatewayRow
      title={name}
      description={
        mode === "own"
          ? t("gateway:account_warm_own_hint")
          : mode === "off"
            ? t("gateway:account_warm_off_hint")
            : agentAts.length > 0
              ? t("gateway:account_warm_same_hint", { ats: agentAts.join(", ") })
              : t("gateway:account_warm_same_off_hint")
      }
      trailing={
        <div className="flex flex-wrap items-center gap-1">
          <select
            value={mode}
            disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.value as AccountWarmMode;
              if (next === "own") {
                void save(aimedWarmAt("own", at, agentAts));
                return;
              }
              void save(aimedWarmAt(next, at, agentAts));
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
          >
            <option value="same">{t("gateway:account_warm_same")}</option>
            <option value="own">{t("gateway:account_warm_own")}</option>
            <option value="off">{t("gateway:off")}</option>
          </select>
          {mode === "own" ? (
            <>
              <input
                value={own}
                onChange={(event) => setOwn(event.currentTarget.value)}
                placeholder="06:00"
                aria-label={t("gateway:warm_at_time")}
                className="h-7 w-20 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 text-ui-xs"
              />
              <Button
                size="xs"
                variant="outline"
                disabled={busy || !/^([01]?\d|2[0-3]):[0-5]\d$/u.test(own.trim())}
                onClick={() => void save(own.trim())}
              >
                {t("gateway:save")}
              </Button>
            </>
          ) : null}
        </div>
      }
    />
  );
}
