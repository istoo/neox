// FILE: GatewayOverviewPane.tsx
// Purpose: Model gateway overview — running state, address and client snippets,
//          the catalog models, account health, and the most recent calls.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { getHostStatus } from "~/lib/neolixHostApi";
import type { GatewayConfig, GatewaySearchVendor, GatewayStatus } from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";

import { CopyTextButton } from "../../ui/copyTextButton";
import { Input } from "../../ui/input";
import { SettingsSection } from "../SettingsPanelPrimitives";
import {
  catalogEntries,
  formatCountdown,
  formatPercent,
  formatTokens,
  formatUsd,
  formatWhen,
  gatewayOrigin,
  parseListen,
  type GatewayTab,
} from "./gatewayHelpers";
import {
  GatewayEmpty,
  GatewayPill,
  GatewayRow,
  GatewayStat,
  GatewayToggle,
} from "./GatewayPrimitives";

const API_OPTIONS = ["openai", "responses", "anthropic", "gemini"] as const;
type GatewayApi = (typeof API_OPTIONS)[number];

/** The gateway's own MCP servers, mounted at the same origin as `/v1`. */
const MCP_ROWS = [
  { key: "vision", path: "/mcp/myna/vision" },
  { key: "image", path: "/mcp/myna/image" },
  { key: "web_search", path: "/mcp/myna/web-search" },
] as const;

function apiBase(origin: string, api: GatewayApi): string {
  const trimmed = origin.replace(/\/+$/u, "");
  return api === "openai" || api === "responses" ? `${trimmed}/v1` : trimmed;
}

function apiEnv(
  api: GatewayApi,
): "OPENAI_BASE_URL" | "ANTHROPIC_BASE_URL" | "GOOGLE_GEMINI_BASE_URL" {
  if (api === "anthropic") return "ANTHROPIC_BASE_URL";
  if (api === "gemini") return "GOOGLE_GEMINI_BASE_URL";
  return "OPENAI_BASE_URL";
}

export interface GatewayOverviewProps {
  config: GatewayConfig;
  status: GatewayStatus | null;
  searchVendors: GatewaySearchVendor[] | null;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
  onSelectTab: (tab: GatewayTab) => void;
}

export function GatewayOverviewPane({ config, status, apply, onSelectTab }: GatewayOverviewProps) {
  const { t } = useTranslation();
  const { gatewayCallsPage } = useBuiltinFeatures();
  const [api, setApi] = useState<GatewayApi>("openai");
  const [selectedModel, setSelectedModel] = useState("");
  const [filter, setFilter] = useState("");

  const hostStatus = useQuery({
    queryKey: ["neolix-host-status"],
    queryFn: getHostStatus,
    staleTime: 30_000,
  });
  const listen = parseListen(hostStatus.data?.listen);
  const origin = gatewayOrigin(listen);

  const entries = useMemo(() => catalogEntries(config), [config]);
  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.id.toLowerCase().includes(needle) ||
        (entry.provider.label ?? entry.provider.id).toLowerCase().includes(needle),
    );
  }, [entries, filter]);
  const modelId = selectedModel || entries[0]?.id || "";
  const accounts = status?.accounts ?? [];
  const recent = status?.recent ?? [];
  const running = config.enabled !== false;

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:overview_status">
        <GatewayRow
          title={
            <span className="flex items-center gap-2">
              {t("gateway:overview_title")}
              <GatewayPill tone={running ? "ok" : "muted"}>
                {running ? t("gateway:running") : t("gateway:stopped")}
              </GatewayPill>
            </span>
          }
          description={t("gateway:overview_summary", {
            models: entries.length,
            providers: config.providers?.length ?? 0,
            groups: config.groups?.length ?? 0,
          })}
          trailing={
            <GatewayToggle
              checked={running}
              label={t("gateway:enabled")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.enabled = checked;
                })
              }
            />
          }
        />
        <div className="grid grid-cols-2 gap-px bg-[color:var(--color-border)] sm:grid-cols-4">
          <div className="bg-[var(--color-background-elevated-primary-opaque)]">
            <GatewayStat
              label={t("gateway:month_spend")}
              value={formatUsd(status?.monthSpendUsd ?? 0)}
              hint={
                status?.budgetUsd === null || status?.budgetUsd === undefined
                  ? t("gateway:no_budget")
                  : t("gateway:budget_of", { amount: formatUsd(status.budgetUsd) })
              }
            />
          </div>
          <div className="bg-[var(--color-background-elevated-primary-opaque)]">
            <GatewayStat
              label={t("gateway:accounts")}
              value={`${accounts.length}`}
              hint={`${accounts.filter((account) => account.restingUntil === null).length} ${t("gateway:available")}`}
            />
          </div>
          <div className="bg-[var(--color-background-elevated-primary-opaque)]">
            <GatewayStat
              label={t("gateway:models_count")}
              value={`${entries.length}`}
              hint={`${config.groups?.length ?? 0} ${t("gateway:groups_lower")}`}
            />
          </div>
          <div className="bg-[var(--color-background-elevated-primary-opaque)]">
            <GatewayStat
              label={t("gateway:started")}
              value={status?.startedAt ? formatWhen(status.startedAt) : "—"}
              hint={status?.proxy ? `${t("gateway:proxy")} ${status.proxy}` : undefined}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="gateway:connect">
        <GatewayRow
          title={t("gateway:address")}
          description={
            listen.socket
              ? t("gateway:socket_hint")
              : listen.listen
                ? t("gateway:listen_hint", { listen: listen.listen })
                : t("gateway:listen_unknown")
          }
          trailing={origin ? <GatewayPill>{origin}</GatewayPill> : null}
        />
        <GatewayRow
          title={t("gateway:share")}
          description={
            listen.lanReachable ? (
              t("gateway:share_hint")
            ) : (
              <>
                {t("gateway:share_hint")}
                <span className="block">{t("gateway:share_localOnly")}</span>
              </>
            )
          }
          trailing={
            <div className="flex flex-wrap gap-1">
              {API_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setApi(option)}
                  className={`rounded-md border px-2 py-1 text-ui-xs ${
                    api === option
                      ? "border-foreground/25 bg-foreground/8 text-foreground"
                      : "border-[color:var(--color-border)] text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t(`gateway:api_${option}`)}
                </button>
              ))}
            </div>
          }
        >
          {origin === null ? (
            <GatewayEmpty>{t("gateway:no_address")}</GatewayEmpty>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/5 px-2 py-1.5 text-ui-sm">
                  {apiBase(origin, api)}
                </code>
                <CopyTextButton text={apiBase(origin, api)} label={t("gateway:address")} />
              </div>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/5 px-2 py-1.5 text-ui-sm">
                  export {apiEnv(api)}={apiBase(origin, api)}
                </code>
                <CopyTextButton
                  text={`export ${apiEnv(api)}=${apiBase(origin, api)}`}
                  label={t("gateway:env")}
                />
              </div>
            </div>
          )}
        </GatewayRow>
      </SettingsSection>

      {origin !== null ? (
        <SettingsSection title="gateway:mcp_title">
          {MCP_ROWS.map((row) => {
            const url = `${origin.replace(/\/+$/u, "")}${row.path}`;
            return (
              <GatewayRow
                key={row.key}
                title={t(`gateway:mcp_${row.key}`)}
                description={t(`gateway:mcp_${row.key}_hint`)}
                trailing={<CopyTextButton text={url} label={row.path} />}
              >
                <code className="block truncate rounded-md bg-foreground/5 px-2 py-1.5 text-ui-sm">
                  {url}
                </code>
              </GatewayRow>
            );
          })}
        </SettingsSection>
      ) : null}

      <SettingsSection title="gateway:models_catalog">
        <div className="flex items-center gap-2 px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={t("gateway:search_models")}
            size="sm"
            variant="soft"
          />
          <button
            type="button"
            className="shrink-0 rounded-md border border-[color:var(--color-border)] px-2 py-1 text-ui-xs text-muted-foreground hover:text-foreground"
            onClick={() => onSelectTab("providers")}
          >
            {t("gateway:manage_sources")}
          </button>
        </div>
        {visibleModels.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_models")}</GatewayEmpty>
          </div>
        ) : (
          visibleModels.slice(0, 80).map((entry) => (
            <GatewayRow
              key={entry.id}
              title={
                <span className={entry.disabled ? "line-through opacity-60" : undefined}>
                  {entry.id}
                </span>
              }
              description={`${entry.provider.label ?? entry.provider.id} · ${entry.provider.protocol}`}
              trailing={
                <div className="flex items-center gap-1">
                  {entry.model.kind && entry.model.kind !== "chat" ? (
                    <GatewayPill>{entry.model.kind}</GatewayPill>
                  ) : null}
                  {entry.model.contextWindow ? (
                    <GatewayPill>{formatTokens(entry.model.contextWindow)}</GatewayPill>
                  ) : null}
                  <button
                    type="button"
                    className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-ui-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setSelectedModel(entry.id)}
                  >
                    {modelId === entry.id ? t("gateway:use") : t("gateway:pick")}
                  </button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection title="gateway:account_health">
        {accounts.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_accounts")}</GatewayEmpty>
          </div>
        ) : (
          accounts.slice(0, 12).map((account) => {
            const resting = account.restingUntil !== null && account.restingUntil > Date.now();
            return (
              <GatewayRow
                key={`${account.provider}/${account.account}`}
                title={`${account.provider} / ${account.account}`}
                description={`${t("gateway:priority")} ${account.priority} · ${t("gateway:weight")} ${account.weight}`}
                trailing={
                  <div className="flex items-center gap-1">
                    <GatewayPill tone={resting ? "warn" : account.enabled ? "ok" : "muted"}>
                      {resting
                        ? t("gateway:resting", {
                            when: formatCountdown((account.restingUntil ?? 0) - Date.now()),
                          })
                        : account.enabled
                          ? t("gateway:ready")
                          : t("gateway:off")}
                    </GatewayPill>
                    <GatewayPill>
                      5h {formatTokens(account.tokens5h)}
                      {account.tokens5hCap ? ` / ${formatTokens(account.tokens5hCap)}` : ""}
                    </GatewayPill>
                    <GatewayPill>
                      7d {formatTokens(account.tokens7d)}
                      {account.tokens7dCap ? ` / ${formatTokens(account.tokens7dCap)}` : ""}
                    </GatewayPill>
                    {account.usedPercent !== null && account.usedPercent !== undefined ? (
                      <GatewayPill>{formatPercent(account.usedPercent)}</GatewayPill>
                    ) : null}
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="gateway:recent_calls">
        {recent.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_calls")}</GatewayEmpty>
          </div>
        ) : (
          recent
            .slice(0, gatewayCallsPage)
            .map((call) => (
              <GatewayRow
                key={`${call.time}-${call.model}-${call.provider}-${call.status}`}
                title={`${call.model} → ${call.provider}${call.account ? ` / ${call.account}` : ""}`}
                description={`${formatWhen(call.time)} · ${call.status} · ${formatTokens(call.inputTokens)} in / ${formatTokens(call.outputTokens)} out`}
                trailing={
                  <GatewayPill tone={call.ok ? "ok" : "error"}>
                    {formatUsd(call.costUsd)}
                  </GatewayPill>
                }
              />
            ))
        )}
      </SettingsSection>

      <SettingsSection title="gateway:keys_summary">
        <GatewayRow
          title={t("gateway:keys_count", { count: config.keys?.length ?? 0 })}
          description={t("gateway:keys_hint")}
          trailing={
            <button
              type="button"
              className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-ui-xs text-muted-foreground hover:text-foreground"
              onClick={() => onSelectTab("keys")}
            >
              {t("gateway:open_keys")}
            </button>
          }
        />
        <GatewayRow
          title={t("gateway:search_summary")}
          description={
            config.search?.enabled === true
              ? t("gateway:search_on", { count: config.search.apis?.length ?? 0 })
              : t("gateway:search_off")
          }
          trailing={
            <button
              type="button"
              className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-ui-xs text-muted-foreground hover:text-foreground"
              onClick={() => onSelectTab("advanced")}
            >
              {t("gateway:open_advanced")}
            </button>
          }
        />
      </SettingsSection>
    </div>
  );
}
