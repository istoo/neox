// FILE: GatewayProviderAdvanced.tsx
// Purpose: A provider's advanced fields — headers, extra body, family, decision
//          address, icon, time-of-day rate windows — plus its model prices,
//          aliases and the Claude Code run mode.
// Layer: Settings UI components

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayAccount,
  GatewayClaudeMode,
  GatewayConfig,
  GatewayPrice,
  GatewayProvider,
  GatewayRateWindow,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { GatewayField, GatewayNumberField, GatewayPill, GatewayToggle } from "./GatewayPrimitives";

type Edit = (mutate: (draft: GatewayConfig) => void) => void;

/** Header names whose values are credentials, hidden as they are typed. */
const SECRET_HEADER = /authorization|api[-_]?key|token|secret|cookie|^key$/iu;

function headerRows(headers: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(headers ?? {});
}

function headersFrom(rows: Array<[string, string]>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of rows) {
    if (name.trim().length > 0) headers[name.trim()] = value;
  }
  return headers;
}

function updateProvider(edit: Edit, id: string, mutate: (provider: GatewayProvider) => void) {
  edit((draft) => {
    const provider = (draft.providers ?? []).find((entry) => entry.id === id);
    if (provider) mutate(provider);
  });
}

export function ProviderHeaders({ provider, edit }: { provider: GatewayProvider; edit: Edit }) {
  const { t } = useTranslation();
  // A half-typed header (no name yet) is not a valid header to save, but the
  // row has to stay while it is being typed.
  const [rows, setRows] = useState<Array<[string, string]>>(() => headerRows(provider.headers));

  useEffect(() => {
    setRows(headerRows(provider.headers));
    // Only when the editor moves to another provider, so a keystroke does not
    // rewrite the row it is being typed in.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  const write = (next: Array<[string, string]>) => {
    setRows(next);
    updateProvider(edit, provider.id, (draft) => {
      const headers = headersFrom(next);
      draft.headers = Object.keys(headers).length === 0 ? undefined : headers;
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-sm text-muted-foreground">{t("gateway:provider_headers")}</span>
      {rows.length === 0 ? (
        <span className="text-ui-xs text-muted-foreground">
          {t("gateway:provider_headers_empty")}
        </span>
      ) : (
        rows.map(([name, value], index) => (
          // The rows are positional: keying by a name being typed would remount
          // the input and drop focus on every keystroke.
          // oxlint-disable-next-line react/no-array-index-key
          <div key={index} className="flex items-center gap-1.5">
            <Input
              value={name}
              placeholder={t("common:headerPlaceholder")}
              size="sm"
              variant="soft"
              className="min-w-0 flex-1"
              onChange={(event) => {
                const next = rows.map((row, at) =>
                  at === index ? ([event.currentTarget.value, row[1]] as [string, string]) : row,
                );
                write(next);
              }}
            />
            <Input
              value={value}
              type={SECRET_HEADER.test(name) ? "password" : "text"}
              size="sm"
              variant="soft"
              className="min-w-0 flex-1"
              autoComplete="off"
              onChange={(event) => {
                const next = rows.map((row, at) =>
                  at === index ? ([row[0], event.currentTarget.value] as [string, string]) : row,
                );
                write(next);
              }}
            />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => write(rows.filter((_, at) => at !== index))}
            >
              {t("gateway:remove")}
            </Button>
          </div>
        ))
      )}
      <div>
        <Button size="xs" variant="ghost" onClick={() => write([...rows, ["", ""]])}>
          {t("gateway:provider_add_header")}
        </Button>
      </div>
    </div>
  );
}

export function ProviderExtraBody({ provider, edit }: { provider: GatewayProvider; edit: Edit }) {
  const { t } = useTranslation();
  const [text, setText] = useState(() =>
    provider.extraBody === undefined ? "" : JSON.stringify(provider.extraBody, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(provider.extraBody === undefined ? "" : JSON.stringify(provider.extraBody, null, 2));
    setError(null);
    // Only when the editor moves to another provider: our own keystrokes
    // already wrote `extraBody`, and re-reading it would move the caret.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id]);

  return (
    <label className="flex flex-col gap-1">
      <span className="text-ui-sm text-muted-foreground">{t("gateway:provider_extra_body")}</span>
      <textarea
        value={text}
        rows={4}
        placeholder='{ "reasoning_effort": "high" }'
        onChange={(event) => {
          const value = event.currentTarget.value;
          setText(value);
          if (value.trim() === "") {
            setError(null);
            updateProvider(edit, provider.id, (draft) => {
              draft.extraBody = undefined;
            });
            return;
          }
          try {
            const parsed: unknown = JSON.parse(value);
            let invalid = false;
            if (parsed === null) invalid = true;
            else if (typeof parsed !== "object") invalid = true;
            else if (Array.isArray(parsed)) invalid = true;
            if (invalid) {
              setError(t("gateway:provider_extra_body_object"));
              return;
            }
            setError(null);
            updateProvider(edit, provider.id, (draft) => {
              draft.extraBody = parsed as Record<string, unknown>;
            });
          } catch {
            setError(t("gateway:provider_extra_body_invalid"));
          }
        }}
        className="w-full resize-y rounded-md border border-[color:var(--color-border)] bg-background px-2 py-1.5 font-mono text-ui-xs outline-none focus-visible:border-foreground/30"
      />
      <span
        className={
          error === null ? "text-ui-xs text-muted-foreground" : "text-ui-xs text-destructive"
        }
      >
        {error ?? t("gateway:provider_extra_body_hint")}
      </span>
    </label>
  );
}

const DAY_KEYS = [
  "day_sun",
  "day_mon",
  "day_tue",
  "day_wed",
  "day_thu",
  "day_fri",
  "day_sat",
] as const;
const MAX_RATE_WINDOWS = 8;
const CLOCK = /^([01]?\d|2[0-4]):[0-5]\d$/u;
let rateRowSeq = 0;

function nextRateRowKey(): string {
  rateRowSeq += 1;
  return `rate-row-${rateRowSeq}`;
}

export function ProviderRateWindows({ provider, edit }: { provider: GatewayProvider; edit: Edit }) {
  const { t } = useTranslation();
  const windows = provider.rateWindows ?? [];
  // Stable per row while the count holds: keying by the values being typed
  // would remount the input and drop focus on every keystroke.
  const rowKeys = useMemo(
    () => Array.from({ length: windows.length }, () => nextRateRowKey()),
    [windows.length],
  );
  const write = (next: GatewayRateWindow[]) =>
    updateProvider(edit, provider.id, (draft) => {
      draft.rateWindows = next.length === 0 ? undefined : next;
    });
  const change = (index: number, next: GatewayRateWindow) =>
    write(windows.map((window, at) => (at === index ? next : window)));

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-sm text-muted-foreground">{t("gateway:rate_windows")}</span>
      {windows.map((window, index) => (
        <div
          key={rowKeys[index]}
          className="flex flex-col gap-1.5 rounded-md border border-[color:var(--color-border)] p-2"
        >
          <div className="flex flex-wrap gap-1">
            {DAY_KEYS.map((key, day) => {
              const on = (window.days ?? []).includes(day);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const days = on
                      ? (window.days ?? []).filter((entry) => entry !== day)
                      : [...(window.days ?? []), day].toSorted((left, right) => left - right);
                    change(index, { ...window, days });
                  }}
                  className={`rounded border px-1.5 py-0.5 text-ui-xs ${
                    on
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-[color:var(--color-border)] text-muted-foreground"
                  }`}
                >
                  {t(`gateway:${key}`)}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={window.start}
              placeholder="00:00"
              size="sm"
              variant="soft"
              className="w-20"
              aria-label={t("gateway:rate_window_start")}
              onChange={(event) => change(index, { ...window, start: event.currentTarget.value })}
            />
            <span className="text-ui-xs text-muted-foreground">–</span>
            <Input
              value={window.end}
              placeholder="24:00"
              size="sm"
              variant="soft"
              className="w-20"
              aria-label={t("gateway:rate_window_end")}
              onChange={(event) => change(index, { ...window, end: event.currentTarget.value })}
            />
            <Input
              value={Number.isFinite(window.rate) ? String(window.rate) : ""}
              placeholder="1.5"
              inputMode="decimal"
              size="sm"
              variant="soft"
              className="w-20"
              aria-label={t("gateway:rate_window_rate")}
              onChange={(event) =>
                change(index, { ...window, rate: Number(event.currentTarget.value) })
              }
            />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => write(windows.filter((_, at) => at !== index))}
            >
              {t("gateway:rate_window_remove")}
            </Button>
          </div>
          {CLOCK.test(window.start) && CLOCK.test(window.end) ? null : (
            <span className="text-ui-xs text-destructive">{t("gateway:rate_window_invalid")}</span>
          )}
        </div>
      ))}
      {windows.length >= MAX_RATE_WINDOWS ? null : (
        <div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => write([...windows, { days: [], start: "00:00", end: "00:00", rate: 1 }])}
          >
            {t("gateway:rate_window_add")}
          </Button>
        </div>
      )}
      <span className="text-ui-xs text-muted-foreground">{t("gateway:rate_windows_hint")}</span>
    </div>
  );
}

/** The provider's workspace tag, filled into a `{WorkspaceId}` decide address. */
export function ProviderWorkspace({ provider, edit }: { provider: GatewayProvider; edit: Edit }) {
  const { t } = useTranslation();
  const template = `${provider.baseUrl} ${provider.decide ?? ""}`;
  const [value, setValue] = useState("");
  if (!template.includes("{WorkspaceId}")) return null;
  return (
    <GatewayField
      label={t("gateway:provider_workspace")}
      value={value}
      placeholder="workspace-id"
      hint={t("gateway:provider_workspace_hint")}
      onChange={(next) => {
        setValue(next);
        updateProvider(edit, provider.id, (draft) => {
          const workspace = next.trim();
          draft.baseUrl = draft.baseUrl.replaceAll("{WorkspaceId}", workspace);
          if (draft.decide !== undefined) {
            draft.decide = draft.decide.replaceAll("{WorkspaceId}", workspace);
          }
        });
      }}
    />
  );
}

function priceOf(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): GatewayPrice | undefined {
  const entry = config.pricing?.[`${providerId}/${modelId}`];
  return entry ?? undefined;
}

function writePrice(
  edit: Edit,
  providerId: string,
  modelId: string,
  mutate: (price: GatewayPrice) => void,
) {
  edit((draft) => {
    const key = `${providerId}/${modelId}`;
    const pricing = { ...draft.pricing };
    const current = pricing[key] ?? { inputPerMTok: 0, outputPerMTok: 0 };
    const next: GatewayPrice = { ...current };
    mutate(next);
    pricing[key] = next;
    draft.pricing = pricing;
  });
}

const PRICE_FIELDS = [
  ["inputPerMTok", "price_input"],
  ["outputPerMTok", "price_output"],
  ["cacheReadPerMTok", "price_cache_read"],
  ["cacheWritePerMTok", "price_cache_write"],
  ["cacheWrite1hPerMTok", "price_cache_write_1h"],
] as const;

type PriceField = (typeof PRICE_FIELDS)[number][0];

function setPriceField(
  edit: Edit,
  providerId: string,
  modelId: string,
  field: PriceField,
  value: number | undefined,
) {
  writePrice(edit, providerId, modelId, (price) => {
    if (field === "inputPerMTok" || field === "outputPerMTok") {
      price[field] = value ?? 0;
      return;
    }
    if (value === undefined) {
      delete price[field];
      return;
    }
    price[field] = value;
  });
}

function setTierField(
  edit: Edit,
  providerId: string,
  modelId: string,
  field: "aboveTokens" | "inputPerMTok" | "outputPerMTok",
  value: number | undefined,
) {
  writePrice(edit, providerId, modelId, (price) => {
    const existing = price.tiers?.[0];
    const next = {
      aboveTokens: existing?.aboveTokens ?? 0,
      inputPerMTok: existing?.inputPerMTok ?? price.inputPerMTok,
      outputPerMTok: existing?.outputPerMTok ?? price.outputPerMTok,
    };
    if (value !== undefined) {
      if (field === "aboveTokens") next.aboveTokens = value;
      else if (field === "inputPerMTok") next.inputPerMTok = value;
      else next.outputPerMTok = value;
    }
    if (next.aboveTokens > 0) {
      price.tiers = [next];
    } else {
      delete price.tiers;
    }
  });
}

function setSameAs(edit: Edit, providerId: string, modelId: string, value: string) {
  edit((draft) => {
    const key = `${providerId}/${modelId}`;
    const table = { ...draft.modelSameAs };
    const trimmed = value.trim();
    if (trimmed.length === 0) delete table[key];
    else table[key] = trimmed;
    draft.modelSameAs = Object.keys(table).length === 0 ? undefined : table;
  });
}

export function ProviderModelPricing({
  provider,
  config,
  edit,
}: {
  provider: GatewayProvider;
  config: GatewayConfig;
  edit: Edit;
}) {
  const { t } = useTranslation();
  const [openModel, setOpenModel] = useState<string | null>(null);
  const models = provider.models.map((model) => model.id);
  const catalog = useQuery({
    queryKey: ["neolix-gateway", "pricing", provider.id, models.join("\n")],
    queryFn: () => neolixGatewayApi.getPricing({ provider: provider.id, models }),
    enabled: models.length > 0,
    staleTime: 60_000,
  });
  const prices = catalog.data?.prices ?? {};

  if (models.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-sm text-muted-foreground">{t("gateway:prices_title")}</span>
      <span className="text-ui-xs text-muted-foreground">{t("gateway:prices_hint")}</span>
      {models.map((modelId) => {
        const price = priceOf(config, provider.id, modelId);
        const listed = prices[modelId] ?? null;
        const sameAs = config.modelSameAs?.[`${provider.id}/${modelId}`] ?? "";
        const open = openModel === modelId;
        return (
          <div
            key={modelId}
            className="rounded-md border border-[color:var(--color-border)] px-2 py-1.5"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-ui-xs">{modelId}</span>
              <Input
                value={sameAs}
                placeholder={t("gateway:model_same_as_placeholder")}
                size="sm"
                variant="soft"
                className="w-44"
                aria-label={t("gateway:model_same_as", { model: modelId })}
                onChange={(event) =>
                  setSameAs(edit, provider.id, modelId, event.currentTarget.value)
                }
              />
              <GatewayPill tone={price === undefined ? "muted" : "ok"}>
                {price === undefined
                  ? t("gateway:price_catalog")
                  : `${price.inputPerMTok}/${price.outputPerMTok}`}
              </GatewayPill>
              <Button size="xs" variant="ghost" onClick={() => setOpenModel(open ? null : modelId)}>
                {open ? t("gateway:close") : t("gateway:price_edit")}
              </Button>
            </div>
            {open ? (
              <div className="mt-2 space-y-2">
                <div className="grid gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
                  {PRICE_FIELDS.map(([field, key]) => (
                    <GatewayNumberField
                      key={field}
                      label={t(`gateway:${key}`)}
                      value={price?.[field]}
                      min={0}
                      placeholder={listed?.[field] === undefined ? "" : String(listed[field])}
                      onChange={(value) => setPriceField(edit, provider.id, modelId, field, value)}
                    />
                  ))}
                </div>
                <div className="grid gap-1.5 sm:grid-cols-3">
                  <GatewayNumberField
                    label={t("gateway:price_tier_above")}
                    value={price?.tiers?.[0]?.aboveTokens}
                    min={1}
                    onChange={(value) =>
                      setTierField(edit, provider.id, modelId, "aboveTokens", value)
                    }
                  />
                  <GatewayNumberField
                    label={t("gateway:price_tier_input")}
                    value={price?.tiers?.[0]?.inputPerMTok}
                    min={0}
                    onChange={(value) =>
                      setTierField(edit, provider.id, modelId, "inputPerMTok", value)
                    }
                  />
                  <GatewayNumberField
                    label={t("gateway:price_tier_output")}
                    value={price?.tiers?.[0]?.outputPerMTok}
                    min={0}
                    onChange={(value) =>
                      setTierField(edit, provider.id, modelId, "outputPerMTok", value)
                    }
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

const CLAUDE_MODE_WHY: Record<GatewayClaudeMode["why"], string> = {
  "": "claude_mode_ok",
  off: "claude_mode_why_off",
  os: "claude_mode_why_os",
  missing: "claude_mode_why_missing",
};

export function ProviderClaudeMode({
  provider,
  config,
  apply,
}: {
  provider: GatewayProvider;
  config: GatewayConfig;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const visible = (provider.accounts ?? []).some((account) => account.agent === "claude-code");
  const mode = useQuery({
    queryKey: ["neolix-gateway", "claude-mode"],
    queryFn: neolixGatewayApi.claudeMode,
    enabled: visible,
    staleTime: 30_000,
  });
  if (!visible || mode.data === undefined) return null;
  const current = mode.data.mode;
  const picked = config.claudePrintMode === true ? "p" : "tui";
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ui-sm text-muted-foreground">{t("gateway:claude_mode")}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {(["tui", "p"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={picked === option}
            onClick={() =>
              void apply((draft) => {
                draft.claudePrintMode = option === "p";
              }).then(() =>
                queryClient.invalidateQueries({ queryKey: ["neolix-gateway", "claude-mode"] }),
              )
            }
            className={`rounded-md border px-2.5 py-1 text-ui-sm ${
              picked === option
                ? "border-foreground/30 bg-foreground/8 text-foreground"
                : "border-[color:var(--color-border)] text-muted-foreground"
            }`}
          >
            {t(option === "tui" ? "gateway:claude_mode_tui" : "gateway:claude_mode_p")}
          </button>
        ))}
        <GatewayPill tone={current.why === "" ? "ok" : "warn"}>
          {t(`gateway:${CLAUDE_MODE_WHY[current.why]}`)}
        </GatewayPill>
      </div>
      <span className="text-ui-xs text-muted-foreground">{t("gateway:claude_mode_hint")}</span>
    </div>
  );
}

const ACCOUNT_AGENTS: Array<NonNullable<GatewayAccount["agent"]>> = [
  "claude-code",
  "chatgpt-api",
  "copilot",
  "gemini",
  "antigravity",
  "factory",
];

export function AccountAdvancedFields({
  account,
  onChange,
}: {
  account: GatewayAccount;
  onChange: (mutate: (draft: GatewayAccount) => void) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <GatewayField
        label={t("gateway:account_base_url")}
        value={account.baseUrl ?? ""}
        placeholder="https://api.example.com/v1"
        onChange={(value) =>
          onChange((draft) => {
            draft.baseUrl = value.trim() || undefined;
          })
        }
      />
      <GatewayField
        label={t("gateway:account_models")}
        value={(account.models ?? []).join(", ")}
        hint={t("gateway:account_models_hint")}
        onChange={(value) =>
          onChange((draft) => {
            const models = value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0);
            draft.models = models.length === 0 ? undefined : models;
          })
        }
      />
      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-muted-foreground">{t("gateway:account_agent")}</span>
        <select
          value={account.agent ?? ""}
          onChange={(event) => {
            // Read before the deferred draft update: React clears the event.
            const value = event.currentTarget.value;
            onChange((draft) => {
              draft.agent = (value || undefined) as GatewayAccount["agent"];
            });
          }}
          className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
        >
          <option value="">{t("gateway:unset")}</option>
          {ACCOUNT_AGENTS.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-muted-foreground">{t("gateway:account_auto_reset")}</span>
        <select
          value={account.autoReset ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange((draft) => {
              draft.autoReset = (value || undefined) as GatewayAccount["autoReset"];
            });
          }}
          className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
        >
          <option value="">{t("gateway:unset")}</option>
          <option value="week">week</option>
          <option value="expiring">expiring</option>
          <option value="auto">auto</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-muted-foreground">
          {t("gateway:account_credits_mode")}
        </span>
        <select
          value={account.creditsMode ?? ""}
          onChange={(event) => {
            const value = event.currentTarget.value;
            onChange((draft) => {
              draft.creditsMode = (value || undefined) as GatewayAccount["creditsMode"];
            });
          }}
          className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
        >
          <option value="">{t("gateway:unset")}</option>
          <option value="on">on</option>
          <option value="first">first</option>
          <option value="last">last</option>
          <option value="off">off</option>
        </select>
      </label>
      <GatewayField
        label={t("gateway:account_warm_at")}
        value={account.warmAt ?? ""}
        placeholder="HH:MM / off"
        hint={t("gateway:account_warm_at_hint")}
        onChange={(value) =>
          onChange((draft) => {
            draft.warmAt = value;
          })
        }
      />
      <GatewayField
        label={t("gateway:account_usage_url")}
        value={account.usageUrl ?? ""}
        hint={t("gateway:account_usage_url_hint")}
        onChange={(value) =>
          onChange((draft) => {
            draft.usageUrl = value.trim() || undefined;
          })
        }
      />
      <GatewayNumberField
        label={t("gateway:account_usage_interval")}
        value={account.usageIntervalMs}
        min={1}
        onChange={(value) =>
          onChange((draft) => {
            draft.usageIntervalMs = value;
          })
        }
      />
      <GatewayField
        label={t("gateway:account_proxy")}
        value={account.proxy ?? ""}
        placeholder="direct, socks5://…"
        onChange={(value) =>
          onChange((draft) => {
            draft.proxy = value.trim() || undefined;
          })
        }
      />
    </>
  );
}

export function ProviderCountFree({ provider, edit }: { provider: GatewayProvider; edit: Edit }) {
  const { t } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-ui-sm">
      <GatewayToggle
        checked={provider.countFree === true}
        label={t("gateway:provider_count_free")}
        onChange={(checked) =>
          updateProvider(edit, provider.id, (draft) => {
            draft.countFree = checked;
          })
        }
      />
      {t("gateway:provider_count_free")}
    </label>
  );
}
