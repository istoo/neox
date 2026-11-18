// FILE: GatewayKeysPane.tsx
// Purpose: Gateway access keys, their budget windows, and OIDC key-exchange rules.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayConfig,
  GatewayKeyLimit,
  GatewayKeyObject,
  GatewayOidcRule,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { asKeyObject, listText, maskSecret, stringList } from "./gatewayHelpers";
import {
  GatewayEmpty,
  GatewayField,
  GatewayNumberField,
  GatewayPill,
  GatewayRow,
  GatewayToggle,
} from "./GatewayPrimitives";

const LIMIT_PERIODS: Array<GatewayKeyLimit["period"]> = ["day", "week", "month", "days", "hours"];

export interface GatewayKeysProps {
  config: GatewayConfig;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
}

function updateKey(
  edit: GatewayKeysProps["edit"],
  index: number,
  mutate: (key: GatewayKeyObject) => void,
) {
  edit((draft) => {
    const list = draft.keys ?? [];
    const current = list[index];
    if (current === undefined) return;
    const normalized = asKeyObject(current);
    mutate(normalized);
    list[index] = normalized;
    draft.keys = [...list];
  });
}

type Translate = ReturnType<typeof useTranslation>["t"];

async function runOidcSave(
  draft: GatewayOidcRule,
  translate: Translate,
  resetDraft: () => void,
  reload: () => void,
): Promise<void> {
  if (!draft.key || !draft.issuer) return;
  try {
    const result = await neolixGatewayApi.oidcSave(draft);
    if (result.error) throw new Error(result.error);
    toastManager.add({ type: "success", title: translate("gateway:oidc_saved") });
    resetDraft();
    reload();
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  }
}

export function GatewayKeysPane({ config, edit }: GatewayKeysProps) {
  const { t } = useTranslation();
  const keys = config.keys ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const [newKey, setNewKey] = useState("");
  const [oidcOpen, setOidcOpen] = useState(false);

  const oidc = useQuery({
    queryKey: ["neolix-gateway", "oidc"],
    queryFn: neolixGatewayApi.oidcRules,
    enabled: oidcOpen,
  });

  const addKey = () => {
    const value = newKey.trim();
    if (!value) return;
    if (keys.some((entry) => asKeyObject(entry).key === value)) {
      toastManager.add({ type: "error", title: t("gateway:key_exists") });
      return;
    }
    edit((draft) => {
      draft.keys = [...(draft.keys ?? []), { key: value, models: [] }];
    });
    setNewKey("");
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:keys_title">
        <GatewayRow
          title={t("gateway:keys_section_hint")}
          description={t("gateway:keys_empty_hint")}
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newKey}
              onChange={(event) => setNewKey(event.currentTarget.value)}
              placeholder={t("gateway:new_key")}
              className="h-7 min-w-44 flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 font-mono text-ui-sm outline-none"
            />
            <Button size="xs" variant="outline" onClick={addKey}>
              {t("gateway:add_key")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setOidcOpen((value) => !value)}>
              {t("gateway:oidc")}
            </Button>
          </div>
        </GatewayRow>

        {keys.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_keys")}</GatewayEmpty>
          </div>
        ) : (
          keys.map((entry, index) => {
            const key = asKeyObject(entry);
            const label = key.label ?? maskSecret(key.key);
            return (
              <div key={`${key.key}-${key.label ?? ""}`} className="px-3 py-2.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-ui font-medium">{label}</span>
                      <GatewayPill tone={key.readOnly ? "muted" : "ok"}>
                        {key.readOnly ? t("gateway:read_only") : t("gateway:read_write")}
                      </GatewayPill>
                      <GatewayPill>
                        {key.models && key.models.length > 0
                          ? t("gateway:models_allowed", { count: key.models.length })
                          : t("gateway:all_models")}
                      </GatewayPill>
                      {key.expiresAt ? <GatewayPill>{key.expiresAt}</GatewayPill> : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-ui-xs text-muted-foreground">
                      {maskSecret(key.key)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => setOpen(open === index ? null : index)}
                    >
                      {open === index ? t("gateway:close") : t("gateway:edit")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        edit((draft) => {
                          draft.keys = (draft.keys ?? []).filter((_, at) => at !== index);
                        })
                      }
                    >
                      {t("gateway:remove")}
                    </Button>
                  </div>
                </div>
                {open === index ? <KeyEditor keyEntry={key} edit={edit} index={index} /> : null}
              </div>
            );
          })
        )}
      </SettingsSection>

      {oidcOpen ? (
        <SettingsSection title="gateway:oidc_title">
          <OidcRules
            rules={oidc.data?.rules ?? []}
            loading={oidc.isLoading}
            reload={() => void oidc.refetch()}
          />
        </SettingsSection>
      ) : null}
    </div>
  );
}

function KeyEditor({
  keyEntry,
  edit,
  index,
}: {
  keyEntry: GatewayKeyObject;
  edit: GatewayKeysProps["edit"];
  index: number;
}) {
  const { t } = useTranslation();
  const { isEnabled } = useBuiltinFeatures();
  const budgetOn = isEnabled("budget");
  const update = (mutate: (draft: GatewayKeyObject) => void) => updateKey(edit, index, mutate);
  const limits = keyEntry.limits ?? [];

  const updateLimit = (at: number, mutate: (limit: GatewayKeyLimit) => void) => {
    update((draft) => {
      const list = [...(draft.limits ?? [])];
      const limit = list[at];
      if (!limit) return;
      mutate(limit);
      draft.limits = list;
    });
  };

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[color:var(--color-border)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <GatewayField
          label={t("gateway:key_value")}
          value={keyEntry.key}
          onChange={(value) =>
            update((draft) => {
              draft.key = value;
            })
          }
        />
        <GatewayField
          label={t("gateway:label")}
          value={keyEntry.label ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.label = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:allowed_models")}
          value={listText(keyEntry.models)}
          onChange={(value) =>
            update((draft) => {
              draft.models = stringList(value);
            })
          }
          hint={t("gateway:allowed_models_hint")}
        />
        <GatewayField
          label={t("gateway:expires_at")}
          value={keyEntry.expiresAt ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.expiresAt = value || undefined;
            })
          }
          placeholder="2027-01-01T00:00:00Z"
        />
        {budgetOn ? (
          <>
            <GatewayNumberField
              label={t("gateway:daily_tokens")}
              value={keyEntry.dailyTokens}
              min={1}
              onChange={(value) =>
                update((draft) => {
                  draft.dailyTokens = value;
                })
              }
            />
            <GatewayNumberField
              label={t("gateway:monthly_usd")}
              value={keyEntry.monthlyUsd}
              min={0}
              onChange={(value) =>
                update((draft) => {
                  draft.monthlyUsd = value;
                })
              }
            />
          </>
        ) : null}
        <GatewayNumberField
          label={t("gateway:rate_per_minute")}
          value={keyEntry.ratePerMinute}
          min={1}
          onChange={(value) =>
            update((draft) => {
              draft.ratePerMinute = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:search_calls")}
          value={keyEntry.searchCallsPerMonth}
          min={1}
          onChange={(value) =>
            update((draft) => {
              draft.searchCallsPerMonth = value;
            })
          }
        />
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={keyEntry.readOnly === true}
            label={t("gateway:read_only")}
            onChange={(checked) =>
              update((draft) => {
                draft.readOnly = checked;
              })
            }
          />
          {t("gateway:read_only")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={keyEntry.issues === true}
            label={t("gateway:issues_keys")}
            onChange={(checked) =>
              update((draft) => {
                draft.issues = checked;
              })
            }
          />
          {t("gateway:issues_keys")}
        </label>
      </div>

      {budgetOn ? (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-ui-sm text-muted-foreground">{t("gateway:limits")}</span>
            <Button
              size="xs"
              variant="outline"
              disabled={limits.length >= 5}
              onClick={() =>
                update((draft) => {
                  draft.limits = [
                    ...(draft.limits ?? []),
                    { period: "day", tokens: 1_000_000, cacheReads: false },
                  ];
                })
              }
            >
              {t("gateway:add_limit")}
            </Button>
          </div>
          {limits.length === 0 ? (
            <div className="text-ui-xs text-muted-foreground">{t("gateway:no_limits")}</div>
          ) : (
            limits.map((limit, at) => (
              <div
                key={`${limit.period}-${limit.days ?? ""}-${limit.hours ?? ""}-${limit.tokens ?? ""}-${limit.cost ?? ""}-${limit.since ?? ""}`}
                className="mt-2 rounded-md border border-[color:var(--color-border)] p-2"
              >
                <div className="grid gap-2 sm:grid-cols-4">
                  <label className="flex flex-col gap-1">
                    <span className="text-ui-sm text-muted-foreground">{t("gateway:period")}</span>
                    <select
                      value={limit.period}
                      onChange={(event) => {
                        const value = event.currentTarget.value as GatewayKeyLimit["period"];
                        updateLimit(at, (draft) => {
                          draft.period = value;
                        });
                      }}
                      className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                    >
                      {LIMIT_PERIODS.map((period) => (
                        <option key={period} value={period}>
                          {t(`gateway:limit_${period}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {limit.period === "days" ? (
                    <GatewayNumberField
                      label={t("gateway:days")}
                      value={limit.days}
                      min={1}
                      onChange={(value) =>
                        updateLimit(at, (draft) => {
                          draft.days = value;
                        })
                      }
                    />
                  ) : null}
                  {limit.period === "hours" ? (
                    <GatewayNumberField
                      label={t("gateway:hours")}
                      value={limit.hours}
                      min={1}
                      onChange={(value) =>
                        updateLimit(at, (draft) => {
                          draft.hours = value;
                        })
                      }
                    />
                  ) : null}
                  <GatewayNumberField
                    label={t("gateway:limit_tokens")}
                    value={limit.tokens}
                    min={1}
                    onChange={(value) =>
                      updateLimit(at, (draft) => {
                        draft.tokens = value;
                      })
                    }
                  />
                  <GatewayNumberField
                    label={t("gateway:limit_cost")}
                    value={limit.cost}
                    min={0}
                    onChange={(value) =>
                      updateLimit(at, (draft) => {
                        draft.cost = value;
                      })
                    }
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-2 text-ui-sm">
                    <GatewayToggle
                      checked={limit.cacheReads === true}
                      label={t("gateway:limit_cache_reads")}
                      onChange={(checked) =>
                        updateLimit(at, (draft) => {
                          draft.cacheReads = checked;
                        })
                      }
                    />
                    {t("gateway:limit_cache_reads")}
                  </label>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      updateLimit(at, (draft) => {
                        draft.since = new Date().toISOString();
                      })
                    }
                  >
                    {t("gateway:reset_window")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      update((draft) => {
                        draft.limits = (draft.limits ?? []).filter(
                          (_, position) => position !== at,
                        );
                      })
                    }
                  >
                    {t("gateway:remove")}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function OidcRules({
  rules,
  loading,
  reload,
}: {
  rules: GatewayOidcRule[];
  loading: boolean;
  reload: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<GatewayOidcRule>({ key: "", issuer: "" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const startEdit = (rule: GatewayOidcRule) => {
    setEditingId(rule.id ?? null);
    setDraft({
      ...(rule.id === undefined ? {} : { id: rule.id }),
      key: rule.key,
      issuer: rule.issuer,
      ...(rule.audience === undefined ? {} : { audience: rule.audience }),
      ...(rule.claims === undefined ? {} : { claims: rule.claims }),
      ...(rule.ttlSeconds === undefined ? {} : { ttlSeconds: rule.ttlSeconds }),
    });
  };
  const resetDraft = () => {
    setEditingId(null);
    setDraft({ key: "", issuer: "" });
  };
  const save = () => runOidcSave(draft, t, resetDraft, reload);
  return (
    <>
      {loading ? (
        <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
      ) : rules.length === 0 ? (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:no_oidc")}</GatewayEmpty>
        </div>
      ) : (
        rules.map((rule) => (
          <GatewayRow
            key={rule.id ?? `${rule.issuer}-${rule.key}`}
            title={rule.id ?? rule.issuer}
            description={`${rule.issuer} · ${rule.key}${rule.audience ? ` · ${rule.audience}` : ""}`}
            trailing={
              <div className="flex items-center gap-1">
                <Button size="xs" variant="ghost" onClick={() => startEdit(rule)}>
                  {t("gateway:edit")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (!rule.id) return;
                    void neolixGatewayApi.oidcRemove(rule.id).then(reload);
                  }}
                >
                  {t("gateway:remove")}
                </Button>
              </div>
            }
          />
        ))
      )}
      <div className="grid gap-2 px-3 py-2 sm:grid-cols-2">
        <GatewayField
          label={t("gateway:oidc_issuer")}
          value={draft.issuer}
          onChange={(value) => setDraft((current) => ({ ...current, issuer: value }))}
        />
        <GatewayField
          label={t("gateway:key_value")}
          value={draft.key}
          onChange={(value) => setDraft((current) => ({ ...current, key: value }))}
        />
        <GatewayField
          label={t("gateway:oidc_audience")}
          value={draft.audience ?? ""}
          onChange={(value) =>
            setDraft((current) => ({ ...current, audience: value || undefined }))
          }
        />
        <GatewayNumberField
          label={t("gateway:oidc_ttl")}
          value={draft.ttlSeconds}
          min={1}
          onChange={(value) => setDraft((current) => ({ ...current, ttlSeconds: value }))}
        />
        <GatewayField
          label={t("gateway:oidc_claims")}
          value={Object.entries(draft.claims ?? {})
            .map(([name, value]) => `${name}=${value}`)
            .join(", ")}
          onChange={(value) => {
            const claims: Record<string, string> = {};
            for (const part of value.split(",")) {
              const [name, claimValue] = part.split("=").map((entry) => entry.trim());
              if (name && claimValue) claims[name] = claimValue;
            }
            setDraft((current) => ({ ...current, claims }));
          }}
          hint={t("gateway:oidc_claims_hint")}
        />
      </div>
      <div className="flex justify-end gap-1 px-3 pb-2">
        {editingId === null ? null : (
          <Button size="xs" variant="ghost" onClick={resetDraft}>
            {t("gateway:cancel")}
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={() => void save()}>
          {editingId === null ? t("gateway:add_rule") : t("gateway:oidc_save_changes")}
        </Button>
      </div>
      <div className="px-3 pb-2 text-ui-xs text-muted-foreground">{t("gateway:oidc_endpoint")}</div>
    </>
  );
}
