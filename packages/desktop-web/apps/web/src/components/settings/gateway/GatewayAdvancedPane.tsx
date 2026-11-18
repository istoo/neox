// FILE: GatewayAdvancedPane.tsx
// Purpose: The gateway's remaining settings — budget, model naming, proxy,
//          middleware aliases/overrides, search, the raw JSON document, and the
//          signed-in subscription and Codex account stores.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayConfig,
  GatewayPluginSubscriptionProvider,
  GatewayPluginSubscriptionSignInResult,
  GatewaySearchApi,
  GatewaySearchVendor,
  GatewaySignInState,
  GatewaySubscriptionAccount,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { catalogEntries, listText, stringList } from "./gatewayHelpers";
import { isProxyAddress } from "./gatewayDraftValidation";
import {
  GatewayEmpty,
  GatewayField,
  GatewayNumberField,
  GatewayRow,
  GatewayTextarea,
  GatewayToggle,
} from "./GatewayPrimitives";

const FALLBACK_SEARCH_VENDORS: GatewaySearchVendor[] = [
  { vendor: "tavily", name: "Tavily" },
  { vendor: "brave", name: "Brave Search" },
  { vendor: "exa", name: "Exa" },
  { vendor: "firecrawl", name: "Firecrawl" },
  { vendor: "you", name: "You.com" },
  { vendor: "deepseek", name: "DeepSeek" },
  { vendor: "volcengine", name: "Doubao Search" },
  { vendor: "wsa", name: "Yuanbao Search" },
  { vendor: "searxng", name: "SearXNG" },
];

export interface GatewayAdvancedProps {
  config: GatewayConfig;
  searchVendors: GatewaySearchVendor[] | null;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

/** A budget that stages its text and saves only a positive number. */
function BudgetField({
  value,
  onSave,
}: {
  value: number | undefined;
  onSave: (value: number | undefined) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value === undefined ? "" : String(value));
    setError(null);
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setError(null);
      if (value !== undefined) onSave(undefined);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError(t("gateway:error_budget"));
      return;
    }
    setError(null);
    if (parsed !== value) onSave(parsed);
  };
  return (
    <div className="flex flex-col gap-1">
      <Input
        value={text}
        inputMode="decimal"
        aria-label={t("gateway:budget")}
        size="sm"
        variant="soft"
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {error === null ? null : <span className="text-ui-xs text-destructive">{error}</span>}
    </div>
  );
}

/** A proxy that stages its text and saves only a form the daemon accepts. */
function ProxyField({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value);
    setError(null);
  }, [value]);
  const commit = () => {
    const trimmed = text.trim();
    if (trimmed === "") {
      setError(null);
      if (value !== "") onSave(undefined);
      return;
    }
    if (!isProxyAddress(trimmed)) {
      setError(t("gateway:error_proxy"));
      return;
    }
    setError(null);
    if (trimmed !== value) onSave(trimmed);
  };
  return (
    <div className="flex flex-col gap-1">
      <Input
        value={text}
        placeholder="direct, http://127.0.0.1:7890"
        aria-label={t("gateway:proxy")}
        size="sm"
        variant="soft"
        onChange={(event) => {
          setText(event.currentTarget.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
      {error === null ? null : <span className="text-ui-xs text-destructive">{error}</span>}
    </div>
  );
}

function aliasesText(aliases: Record<string, string> | undefined): string {
  return Object.entries(aliases ?? {})
    .map(([name, target]) => `${name}=${target}`)
    .join("\n");
}

function parseAliases(value: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const target = line.slice(separator + 1).trim();
    if (name && target) aliases[name] = target;
  }
  return aliases;
}

export function GatewayAdvancedPane({ config, searchVendors, edit, apply }: GatewayAdvancedProps) {
  const { t } = useTranslation();
  const { isEnabled } = useBuiltinFeatures();
  const [raw, setRaw] = useState(() => JSON.stringify(config, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);
  useEffect(() => {
    setRaw(JSON.stringify(config, null, 2));
    setRawError(null);
  }, [config]);

  const vendors = useMemo(
    () => (searchVendors && searchVendors.length > 0 ? searchVendors : FALLBACK_SEARCH_VENDORS),
    [searchVendors],
  );
  const apis = config.search?.apis ?? [];
  const catalog = catalogEntries(config);
  const disabledCount = catalog.filter((entry) => entry.disabled).length;
  const searcherChoices = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const provider of config.providers ?? []) {
      if (provider.searchesUpstream !== true && provider.searches !== true) continue;
      const name = provider.label ?? provider.id;
      out.push({ value: provider.id, label: `${name} · ${t("gateway:searcher_own")}` });
      for (const model of provider.models) {
        out.push({
          value: `${provider.id}/${model.id}`,
          label: `${model.label ?? model.id} · ${name}`,
        });
      }
    }
    return out;
  }, [config.providers, t]);
  const searcherValue = (config.search?.searcher ?? "").trim();
  const searcherExtra =
    searcherValue !== "" &&
    searcherValue !== "off" &&
    !searcherChoices.some((choice) => choice.value === searcherValue)
      ? [{ value: searcherValue, label: searcherValue }]
      : [];
  const writeApis = (next: GatewaySearchApi[]) => {
    edit((draft) => {
      draft.search = { ...draft.search, enabled: draft.search?.enabled ?? true, apis: next };
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:general_title">
        <GatewayRow
          title={t("gateway:enabled")}
          description={t("gateway:enabled_hint")}
          trailing={
            <GatewayToggle
              checked={config.enabled !== false}
              label={t("gateway:enabled")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.enabled = checked;
                })
              }
            />
          }
        />
        {isEnabled("budget") ? (
          <GatewayRow
            title={t("gateway:budget")}
            description={t("gateway:budget_hint")}
            trailing={
              <div className="w-36">
                <BudgetField
                  value={config.budget?.monthlyUsd}
                  onSave={(value) =>
                    void apply((draft) => {
                      draft.budget =
                        value === undefined ? undefined : { ...draft.budget, monthlyUsd: value };
                    })
                  }
                />
              </div>
            }
          />
        ) : null}
        <GatewayRow
          title={t("gateway:model_names")}
          description={t("gateway:model_names_hint")}
          trailing={
            <select
              value={config.modelNames ?? "on"}
              onChange={(event) =>
                void apply((draft) => {
                  draft.modelNames = event.currentTarget.value as GatewayConfig["modelNames"];
                })
              }
              className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
            >
              <option value="off">off</option>
              <option value="own">own</option>
              <option value="on">on</option>
            </select>
          }
        />
        <GatewayRow
          title={t("gateway:bare_ids")}
          description={t("gateway:bare_ids_hint")}
          trailing={
            <GatewayToggle
              checked={config.bareModelIDs === true}
              label={t("gateway:bare_ids")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.bareModelIDs = checked;
                })
              }
            />
          }
        />
        <GatewayRow
          title={t("gateway:recording")}
          description={t("gateway:recording_hint")}
          trailing={
            <GatewayToggle
              checked={config.recording?.enabled === true}
              label={t("gateway:recording")}
              onChange={(checked) =>
                void apply((draft) => {
                  draft.recording = { ...draft.recording, enabled: checked };
                })
              }
            />
          }
        />
        <GatewayRow title={t("gateway:busy_load")} description={t("gateway:busy_load_hint")}>
          <div className="w-36">
            <GatewayNumberField
              label=""
              value={config.busyLoad}
              min={0}
              max={9999}
              onChange={(value) =>
                void apply((draft) => {
                  draft.busyLoad = value;
                })
              }
            />
          </div>
        </GatewayRow>
        <GatewayRow title={t("gateway:proxy")} description={t("gateway:proxy_hint")}>
          <ProxyField
            value={typeof config.proxy === "string" ? config.proxy : ""}
            onSave={(value) =>
              void apply((draft) => {
                draft.proxy = value;
              })
            }
          />
        </GatewayRow>
        <GatewayRow
          title={t("gateway:disabled_models")}
          description={t("gateway:disabled_models_hint")}
        >
          <GatewayTextarea
            label=""
            value={listText(config.disabledModels)}
            onChange={(value) =>
              edit((draft) => {
                draft.disabledModels = stringList(value);
              })
            }
            rows={2}
            placeholder="provider/model, provider/*"
          />
          <div className="mt-1 text-ui-xs text-muted-foreground">
            {t("gateway:disabled_models_hit", {
              count: disabledCount,
              total: catalog.length,
            })}
          </div>
        </GatewayRow>
      </SettingsSection>

      <CodexPreferencesSection config={config} edit={edit} apply={apply} />

      <SettingsSection title="gateway:runtime_title">
        <GatewayRow title={t("gateway:archive_title")} description={t("gateway:archive_hint")}>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex items-center gap-2 text-ui-sm">
              <GatewayToggle
                checked={config.archive?.local === true}
                label={t("gateway:archive_title")}
                onChange={(checked) =>
                  void apply((draft) => {
                    draft.archive = { ...draft.archive, local: checked };
                  })
                }
              />
              {t("gateway:enabled")}
            </label>
            {config.archive?.local === true ? (
              <>
                <div className="w-32">
                  <GatewayNumberField
                    label={t("gateway:archive_max_mb")}
                    value={config.archive?.maxMB}
                    min={1}
                    placeholder="32"
                    onChange={(value) =>
                      edit((draft) => {
                        draft.archive = { ...draft.archive, maxMB: value };
                      })
                    }
                  />
                </div>
                <div className="w-32">
                  <GatewayNumberField
                    label={t("gateway:archive_keep_mb")}
                    value={config.archive?.keepMB}
                    min={1}
                    placeholder="1024"
                    onChange={(value) =>
                      edit((draft) => {
                        draft.archive = { ...draft.archive, keepMB: value };
                      })
                    }
                  />
                </div>
              </>
            ) : null}
          </div>
        </GatewayRow>
        {isEnabled("middleware") ? (
          <GatewayRow
            title={t("gateway:turn_done_title")}
            description={t("gateway:turn_done_hint")}
          >
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-2 text-ui-sm">
                <GatewayToggle
                  checked={(config.turnDoneSeconds ?? 0) > 0}
                  label={t("gateway:turn_done_title")}
                  onChange={(checked) =>
                    void apply((draft) => {
                      draft.turnDoneSeconds = checked ? 120 : 0;
                    })
                  }
                />
                {t("gateway:enabled")}
              </label>
              {(config.turnDoneSeconds ?? 0) > 0 ? (
                <div className="w-32">
                  <GatewayNumberField
                    label={t("gateway:turn_done_seconds")}
                    value={config.turnDoneSeconds}
                    min={1}
                    max={3600}
                    onChange={(value) =>
                      edit((draft) => {
                        draft.turnDoneSeconds = value ?? 0;
                      })
                    }
                  />
                </div>
              ) : null}
            </div>
          </GatewayRow>
        ) : null}
      </SettingsSection>

      {isEnabled("search") ? (
        <SettingsSection title="gateway:search_title">
          <GatewayRow
            title={t("gateway:search_enabled")}
            description={t("gateway:search_enabled_hint")}
            trailing={
              <GatewayToggle
                checked={config.search?.enabled === true}
                label={t("gateway:search_enabled")}
                onChange={(checked) =>
                  void apply((draft) => {
                    draft.search = { ...draft.search, enabled: checked };
                  })
                }
              />
            }
          />
          {config.search?.enabled === true ? (
            <>
              {apis.length === 0 ? (
                <div className="px-3 py-2">
                  <GatewayEmpty>{t("gateway:search_no_apis")}</GatewayEmpty>
                </div>
              ) : (
                apis.map((api, index) => (
                  <div
                    key={`${api.vendor}-${api.url ?? ""}-${api.key ?? ""}`}
                    className="px-3 py-2"
                  >
                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="flex flex-col gap-1">
                        <span className="text-ui-sm text-muted-foreground">
                          {t("gateway:search_vendor")}
                        </span>
                        <select
                          value={api.vendor}
                          onChange={(event) =>
                            writeApis(
                              apis.map((entry, at) =>
                                at === index
                                  ? { ...entry, vendor: event.currentTarget.value }
                                  : entry,
                              ),
                            )
                          }
                          className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                        >
                          {vendors.map((vendor) => (
                            <option key={vendor.vendor} value={vendor.vendor}>
                              {vendor.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <GatewayField
                        label={t("gateway:api_key")}
                        value={api.key ?? ""}
                        type="password"
                        onChange={(value) =>
                          writeApis(
                            apis.map((entry, at) =>
                              at === index ? { ...entry, key: value || undefined } : entry,
                            ),
                          )
                        }
                      />
                      <GatewayField
                        label={t("gateway:search_url")}
                        value={api.url ?? ""}
                        onChange={(value) =>
                          writeApis(
                            apis.map((entry, at) =>
                              at === index ? { ...entry, url: value || undefined } : entry,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-2 text-ui-sm">
                        <GatewayToggle
                          checked={api.off !== true}
                          label={t("gateway:search_api_on", { vendor: api.vendor })}
                          onChange={(checked) =>
                            writeApis(
                              apis.map((entry, at) =>
                                at === index
                                  ? { ...entry, off: checked ? undefined : true }
                                  : entry,
                              ),
                            )
                          }
                        />
                        {t("gateway:enabled")}
                      </label>
                      <label className="flex items-center gap-2 text-ui-sm">
                        <GatewayToggle
                          checked={api.pick === "order"}
                          label={`${api.vendor} order`}
                          onChange={(checked) =>
                            writeApis(
                              apis.map((entry, at) =>
                                at === index
                                  ? { ...entry, pick: checked ? "order" : undefined }
                                  : entry,
                              ),
                            )
                          }
                        />
                        {t("gateway:search_pick")}
                      </label>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => writeApis(apis.filter((_, at) => at !== index))}
                      >
                        {t("gateway:remove")}
                      </Button>
                    </div>
                    <SearchKeysQuota api={api} />
                  </div>
                ))
              )}
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    writeApis([...apis, { vendor: vendors[0]?.vendor ?? "tavily", key: "" }])
                  }
                >
                  {t("gateway:add_search_api")}
                </Button>
                <div className="w-40">
                  <GatewayNumberField
                    label={t("gateway:search_monthly")}
                    value={config.search?.monthlyCalls ?? undefined}
                    min={1}
                    onChange={(value) =>
                      void apply((draft) => {
                        draft.search = {
                          ...draft.search,
                          enabled: true,
                          monthlyCalls: value ?? null,
                        };
                      })
                    }
                  />
                </div>
              </div>
              <div className="grid gap-2 px-3 py-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:searcher")}</span>
                  <select
                    value={searcherValue}
                    onChange={(event) =>
                      void apply((draft) => {
                        draft.search = {
                          ...draft.search,
                          searcher: event.currentTarget.value || undefined,
                        };
                      })
                    }
                    className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                  >
                    <option value="">{t("gateway:searcher_auto")}</option>
                    <option value="off">{t("gateway:searcher_off")}</option>
                    {searcherExtra.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                    {searcherChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                  {searcherChoices.length === 0 ? (
                    <span className="text-ui-xs text-muted-foreground">
                      {t("gateway:searcher_none")}
                    </span>
                  ) : null}
                </label>
                <GatewayField
                  label={t("gateway:searcher_then")}
                  value={listText(config.search?.searcherThen)}
                  onChange={(value) =>
                    void apply((draft) => {
                      draft.search = { ...draft.search, searcherThen: stringList(value) };
                    })
                  }
                />
              </div>
              <div className="flex flex-wrap gap-4 px-3 py-2">
                <label className="flex items-center gap-2 text-ui-sm">
                  <GatewayToggle
                    checked={config.search?.searchAll === true}
                    label={t("gateway:search_all")}
                    onChange={(checked) =>
                      void apply((draft) => {
                        draft.search = { ...draft.search, searchAll: checked };
                      })
                    }
                  />
                  {t("gateway:search_all")}
                </label>
                <label className="flex items-center gap-2 text-ui-sm">
                  <select
                    value={config.search?.searchFirst ?? ""}
                    onChange={(event) =>
                      void apply((draft) => {
                        draft.search = {
                          ...draft.search,
                          searchFirst: event.currentTarget.value as "" | "model" | "api",
                        };
                      })
                    }
                    className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-xs"
                  >
                    <option value="">model</option>
                    <option value="api">api</option>
                  </select>
                  {t("gateway:search_first")}
                </label>
              </div>
            </>
          ) : null}
        </SettingsSection>
      ) : null}

      {isEnabled("middleware") ? (
        <SettingsSection title="gateway:middleware_title">
          <div className="px-3 py-2">
            <GatewayTextarea
              label={t("gateway:aliases")}
              value={aliasesText(config.middleware?.aliases)}
              onChange={(value) =>
                edit((draft) => {
                  draft.middleware = {
                    ...draft.middleware,
                    aliases: parseAliases(value),
                  };
                })
              }
              rows={3}
              placeholder="fast=deepseek/deepseek-v4-pro"
              hint={t("gateway:aliases_hint")}
            />
          </div>
          <div className="px-3 py-2">
            <GatewayTextarea
              label={t("gateway:overrides")}
              value={JSON.stringify(config.middleware?.overrides ?? [], null, 2)}
              onChange={(value) => {
                try {
                  const parsed: unknown = JSON.parse(value);
                  if (!Array.isArray(parsed)) return;
                  edit((draft) => {
                    draft.middleware = { ...draft.middleware, overrides: parsed };
                  });
                } catch {
                  // Keep typing; the last valid JSON stays in the draft.
                }
              }}
              rows={5}
              hint={t("gateway:overrides_hint")}
            />
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection title="gateway:raw_title">
        <div className="space-y-2 px-3 py-2">
          <GatewayTextarea
            label={t("gateway:raw_json")}
            value={raw}
            onChange={setRaw}
            rows={12}
            hint={t("gateway:raw_hint")}
          />
          {rawError ? <div className="text-ui-sm text-destructive">{rawError}</div> : null}
          <div className="flex justify-end">
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                try {
                  const parsed: unknown = JSON.parse(raw);
                  let invalid = false;
                  if (parsed === null) invalid = true;
                  else if (typeof parsed !== "object") invalid = true;
                  else if (Array.isArray(parsed)) invalid = true;
                  if (invalid) {
                    setRawError(t("gateway:raw_object"));
                    return;
                  }
                  edit((draft) => {
                    for (const key of Object.keys(draft)) {
                      delete (draft as Record<string, unknown>)[key];
                    }
                    Object.assign(draft, parsed);
                  });
                  setRawError(null);
                } catch (error) {
                  setRawError(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              {t("gateway:apply")}
            </Button>
          </div>
        </div>
      </SettingsSection>

      <SubscriptionsSection />
      <PluginSubscriptionsSection />
      <HeldReportsSection />
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function searchKeysOf(key: string | undefined): string[] {
  const out: string[] = [];
  for (const entry of (key ?? "").split(/[,;\s]+/u)) {
    if (entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function maskedSearchKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}

/** A search API's keys and, where the vendor reports it, what each has used. */
function SearchKeysQuota({ api }: { api: GatewaySearchApi }) {
  const { t } = useTranslation();
  const keys = searchKeysOf(api.key);
  const quotaSupported = api.vendor === "tavily";
  const quota = useQuery({
    queryKey: ["neolix-gateway", "search-quota", api.vendor, api.key ?? ""],
    queryFn: () => neolixGatewayApi.searchQuota(api.vendor),
    enabled: quotaSupported && keys.length > 0,
    staleTime: 60_000,
  });
  if (keys.length <= 1 && !(quotaSupported && keys.length > 0)) return null;
  return (
    <div className="mt-1.5 rounded-md border border-[color:var(--color-border)] px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="text-ui-xs text-muted-foreground">
          {t("gateway:search_keys_title", { count: keys.length })}
        </span>
        {quotaSupported ? (
          <Button size="xs" variant="ghost" onClick={() => void quota.refetch()}>
            {t("gateway:search_key_check")}
          </Button>
        ) : null}
      </div>
      {keys.map((key, at) => {
        const entry = quota.data?.keys[at];
        return (
          <div key={key} className="flex flex-wrap items-center justify-between gap-1 py-0.5">
            <span className="font-mono text-ui-xs text-muted-foreground">
              {maskedSearchKey(key)}
            </span>
            {quotaSupported ? (
              <span className="text-ui-xs text-muted-foreground">
                {quota.isLoading
                  ? t("gateway:search_key_loading")
                  : !entry
                    ? t("gateway:unknown")
                    : entry.err
                      ? t("gateway:search_key_unknown", { why: entry.err })
                      : entry.known === false
                        ? t("gateway:unknown")
                        : entry.unlimited === true
                          ? t("gateway:search_key_unlimited", { used: entry.used })
                          : t("gateway:search_key_used", {
                              used: entry.used,
                              limit: entry.limit,
                            })}
                {entry?.plan || entry?.of ? ` · ${entry?.plan ?? entry?.of ?? ""}` : ""}
                {entry?.paygoLeft !== undefined
                  ? ` · ${t("gateway:search_key_paygo", { left: entry.paygoLeft })}`
                  : ""}
                {entry?.usedUp === true ? ` · ${t("gateway:search_key_used_up")}` : ""}
              </span>
            ) : null}
          </div>
        );
      })}
      {keys.length > 1 ? (
        <div className="mt-0.5 text-ui-xs text-muted-foreground">
          {t("gateway:search_keys_hint")}
        </div>
      ) : null}
    </div>
  );
}

function CodexSelect({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string;
  description?: string | undefined;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <GatewayRow title={title} description={description}>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </GatewayRow>
  );
}

/** Codex's hidden-turn models and its compaction behavior, myna's Codex settings. */
function CodexPreferencesSection({
  config,
  edit,
  apply,
}: Pick<GatewayAdvancedProps, "config" | "edit" | "apply">) {
  const { t } = useTranslation();
  const models = useMemo(
    () =>
      (config.providers ?? []).flatMap((provider) =>
        provider.models.map((model) => `${provider.id}/${model.id}`),
      ),
    [config.providers],
  );
  const optionModels = models.map((id) => ({ value: id, label: id }));
  const withUnset = (extra: Array<{ value: string; label: string }>) => [
    { value: "", label: t("gateway:unset") },
    ...extra,
    ...optionModels,
  ];

  return (
    <SettingsSection title="gateway:codex_prefs_title">
      <GatewayRow
        title={t("gateway:codex_agents_v1")}
        description={t("gateway:codex_agents_v1_hint")}
      >
        <GatewayToggle
          checked={config.codexAgentsV1 === true}
          label={t("gateway:codex_agents_v1")}
          onChange={(checked) =>
            void apply((draft) => {
              draft.codexAgentsV1 = checked ? true : undefined;
            })
          }
        />
      </GatewayRow>
      <CodexSelect
        title={t("gateway:codex_subagent_model")}
        description={t("gateway:codex_subagent_model_hint")}
        value={config.codexSubagentModel ?? ""}
        options={withUnset([{ value: "lead", label: t("gateway:codex_same_as_lead") }])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexSubagentModel = value || undefined;
          })
        }
      />
      <GatewayRow title={t("gateway:full_context")} description={t("gateway:full_context_hint")}>
        <GatewayToggle
          checked={config.fullContext === true}
          label={t("gateway:full_context")}
          onChange={(checked) =>
            void apply((draft) => {
              draft.fullContext = checked ? true : undefined;
            })
          }
        />
      </GatewayRow>
      <GatewayRow title={t("gateway:compact_at")} description={t("gateway:compact_at_hint")}>
        <div className="w-36">
          <GatewayNumberField
            label=""
            value={config.compactAt}
            min={0}
            disabled={config.fullContext === true}
            placeholder="272000"
            onChange={(value) =>
              edit((draft) => {
                draft.compactAt = value;
              })
            }
          />
        </div>
      </GatewayRow>
      <GatewayRow
        title={t("gateway:codex_async_compact")}
        description={t("gateway:codex_async_compact_hint")}
      >
        <GatewayToggle
          checked={config.codexAsyncCompact === true}
          label={t("gateway:codex_async_compact")}
          onChange={(checked) =>
            void apply((draft) => {
              draft.codexAsyncCompact = checked ? true : undefined;
            })
          }
        />
      </GatewayRow>
      <GatewayRow
        title={t("gateway:codex_async_percent")}
        description={t("gateway:codex_async_percent_hint")}
      >
        <div className="w-36">
          <GatewayNumberField
            label=""
            value={config.codexAsyncCompactPercent}
            min={0}
            max={100}
            disabled={config.codexAsyncCompact !== true}
            placeholder="65"
            onChange={(value) =>
              edit((draft) => {
                draft.codexAsyncCompactPercent = value;
              })
            }
          />
        </div>
      </GatewayRow>
      <CodexSelect
        title={t("gateway:codex_titles")}
        description={t("gateway:codex_side_hint")}
        value={config.codexTitles ?? ""}
        options={withUnset([{ value: "off", label: t("gateway:codex_off") }])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexTitles = value || undefined;
          })
        }
      />
      <CodexSelect
        title={t("gateway:codex_descriptions")}
        description={t("gateway:codex_side_hint")}
        value={config.codexDescriptions ?? ""}
        options={withUnset([{ value: "off", label: t("gateway:codex_off") }])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexDescriptions = value || undefined;
          })
        }
      />
      <CodexSelect
        title={t("gateway:codex_predictions")}
        description={t("gateway:codex_side_hint")}
        value={config.codexPredictions ?? ""}
        options={withUnset([{ value: "off", label: t("gateway:codex_off") }])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexPredictions = value || undefined;
          })
        }
      />
      <CodexSelect
        title={t("gateway:codex_auto_review")}
        description={t("gateway:codex_auto_review_hint")}
        value={config.codexAutoReview ?? ""}
        options={withUnset([{ value: "session", label: t("gateway:codex_same_session") }])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexAutoReview = value || undefined;
          })
        }
      />
      <CodexSelect
        title={t("gateway:codex_memories")}
        description={t("gateway:codex_memories_hint")}
        value={config.codexMemories ?? ""}
        options={withUnset([])}
        onChange={(value) =>
          edit((draft) => {
            draft.codexMemories = value || undefined;
          })
        }
      />
    </SettingsSection>
  );
}

function PluginSubscriptionsSection() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<GatewayPluginSubscriptionProvider[]>([]);
  const [form, setForm] = useState<{
    provider: GatewayPluginSubscriptionProvider;
    method: number;
  } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{
    provider: GatewayPluginSubscriptionProvider;
    result: GatewayPluginSubscriptionSignInResult;
  } | null>(null);
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useQuery({
    queryKey: ["neolix-gateway", "plugin-subscriptions"],
    queryFn: async () => {
      const result = await neolixGatewayApi.pluginSubscriptions();
      setProviders(result.providers);
      return result;
    },
  });

  const token = pending?.result.token ?? "";
  const pendingProvider = pending?.provider;
  useEffect(() => {
    if (!pendingProvider || token === "") return;
    let stopped = false;
    const timer = setInterval(() => {
      void neolixGatewayApi
        .pluginSubscriptionSignInPoll({
          pluginId: pendingProvider.pluginId,
          providerId: pendingProvider.id,
          token,
        })
        .then((result) => {
          if (stopped || result.status !== "signed_in") return;
          setPending(null);
          setSignedIn(pendingProvider.label);
        })
        .catch((cause: unknown) => {
          if (stopped) return;
          setPending(null);
          setError(errorText(cause));
        });
    }, 1_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [pendingProvider, token]);

  const signIn = (
    provider: GatewayPluginSubscriptionProvider,
    method: number,
    inputs: Record<string, string>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSignedIn(null);
    setForm(null);
    void neolixGatewayApi
      .pluginSubscriptionSignIn({
        pluginId: provider.pluginId,
        providerId: provider.id,
        method,
        accountId: provider.id,
        inputs,
      })
      .then((result) => {
        if (result.status === "signed_in") {
          setSignedIn(provider.label);
          return;
        }
        if (result.token === undefined) {
          setError(t("gateway:plugin_sub_no_token"));
          return;
        }
        setPending({ provider, result });
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  const start = (provider: GatewayPluginSubscriptionProvider, method: number) => {
    const prompts = provider.methods[method]?.prompts ?? [];
    if (prompts.length > 0) {
      setValues({});
      setForm({ provider, method });
      return;
    }
    signIn(provider, method, {});
  };

  if (providers.length === 0) return null;

  return (
    <SettingsSection title="gateway:plugin_sub_title">
      {providers.map((provider) => (
        <GatewayRow
          key={`${provider.pluginId}/${provider.id}`}
          title={provider.label}
          description={`${provider.pluginId}/${provider.id} · ${provider.protocol}`}
          trailing={
            <div className="flex flex-wrap gap-1">
              {provider.methods.map((method, index) => (
                <Button
                  key={`${method.type}/${method.label}`}
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => start(provider, index)}
                >
                  {method.label}
                </Button>
              ))}
            </div>
          }
        />
      ))}
      {form === null ? null : (
        <div className="space-y-2 px-3 py-2">
          {(form.provider.methods[form.method]?.prompts ?? []).map((prompt) => (
            <label key={prompt.key} className="flex flex-col gap-1">
              <span className="text-ui-sm text-muted-foreground">{prompt.message}</span>
              {prompt.type === "select" ? (
                <select
                  value={values[prompt.key] ?? ""}
                  onChange={(event) => {
                    // React clears currentTarget before the updater runs.
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [prompt.key]: value,
                    }));
                  }}
                  className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                >
                  <option value="">{prompt.placeholder ?? ""}</option>
                  {(prompt.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={values[prompt.key] ?? ""}
                  placeholder={prompt.placeholder}
                  size="sm"
                  variant="soft"
                  onChange={(event) => {
                    // React clears currentTarget before the updater runs.
                    const value = event.currentTarget.value;
                    setValues((current) => ({
                      ...current,
                      [prompt.key]: value,
                    }));
                  }}
                />
              )}
            </label>
          ))}
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => signIn(form.provider, form.method, values)}
            >
              {form.provider.methods[form.method]?.label}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setForm(null);
                setValues({});
              }}
            >
              {t("gateway:cancel")}
            </Button>
          </div>
        </div>
      )}
      {pending === null ? null : (
        <div className="space-y-2 px-3 py-2">
          <div className="text-ui-sm text-muted-foreground">
            {t("gateway:plugin_sub_waiting", { name: pending.provider.label })}
          </div>
          {pending.result.instructions ? (
            <div className="text-ui-xs text-muted-foreground">{pending.result.instructions}</div>
          ) : null}
          {pending.result.url ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/5 px-2 py-1 text-ui-xs">
                {pending.result.url}
              </code>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  window.open(pending.result.url ?? "", "_blank", "noopener,noreferrer")
                }
              >
                {t("gateway:open")}
              </Button>
            </div>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setPending(null)}>
            {t("gateway:cancel")}
          </Button>
        </div>
      )}
      {signedIn === null ? null : (
        <div className="px-3 py-1 text-ui-sm text-muted-foreground">
          {t("gateway:plugin_sub_done", { name: signedIn })}
        </div>
      )}
      {error === null ? null : <div className="px-3 py-1 text-ui-sm text-destructive">{error}</div>}
    </SettingsSection>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

async function runSubscriptionImport(
  files: File[],
  agent: string,
  refetch: () => Promise<unknown>,
  translate: Translate,
  setImporting: (value: boolean) => void,
): Promise<void> {
  setImporting(true);
  try {
    const texts = await Promise.all(files.map((file) => file.text()));
    await neolixGatewayApi.subscriptionImport({ agent, files: texts });
    await refetch();
    toastManager.add({ type: "success", title: translate("gateway:saved") });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setImporting(false);
  }
}

async function runStartSignIn(
  target: string,
  site: string | undefined,
  translate: Translate,
  setSignIn: (value: GatewaySignInState) => void,
  setSignInCallback: (value: string) => void,
  setSignInError: (value: string | null) => void,
): Promise<void> {
  setSignInError(null);
  setSignInCallback("");
  try {
    const result = await neolixGatewayApi.signInStart({
      agent: target,
      ...(site === undefined || site.trim() === "" ? {} : { site: site.trim() }),
    });
    setSignIn(result.state);
    if (result.state.state === "failed") {
      setSignInError(result.state.error ?? translate("gateway:signin_failed"));
    }
  } catch (error) {
    setSignInError(errorText(error));
  }
}

async function runFinishSignIn(
  signIn: GatewaySignInState | null,
  signInCallback: string,
  translate: Translate,
  refetchSubscriptions: () => Promise<unknown>,
  refetchCodex: () => Promise<unknown>,
  setSignIn: (value: GatewaySignInState) => void,
  setSignInError: (value: string | null) => void,
): Promise<void> {
  if (!signIn || !signIn.id) return;
  setSignInError(null);
  try {
    const result = await neolixGatewayApi.signInCallback(signIn.id, signInCallback.trim());
    if (!result.ok) {
      setSignInError(result.error ?? translate("gateway:signin_failed"));
      return;
    }
    const status = await neolixGatewayApi.signInStatus(signIn.id);
    setSignIn(status.state);
    if (status.state.state === "done") {
      void refetchSubscriptions();
      void refetchCodex();
    }
  } catch (error) {
    setSignInError(errorText(error));
  }
}

async function runImportCodex(
  fromCodex: boolean,
  codexImportText: string,
  translate: Translate,
  refetchCodex: () => Promise<unknown>,
  setSignInError: (value: string | null) => void,
  setCodexNotice: (value: string | null) => void,
  setCodexImportOpen: (value: boolean) => void,
  setCodexImportText: (value: string) => void,
): Promise<void> {
  setSignInError(null);
  setCodexNotice(null);
  try {
    const result = fromCodex
      ? await neolixGatewayApi.codexAccountImport({ fromCodex: true })
      : await neolixGatewayApi.codexAccountImport({ text: codexImportText });
    setCodexImportOpen(false);
    setCodexImportText("");
    setCodexNotice(
      translate("gateway:codex_import_done", {
        added: result.added,
        updated: result.updated,
        failed: result.failed.length,
      }),
    );
    void refetchCodex();
  } catch (error) {
    setSignInError(errorText(error));
  }
}

function SubscriptionsSection() {
  const { t } = useTranslation();
  const subscriptions = useQuery({
    queryKey: ["neolix-gateway", "subscriptions"],
    queryFn: () => neolixGatewayApi.subscriptionAccounts(),
  });
  const codex = useQuery({
    queryKey: ["neolix-gateway", "codex-accounts"],
    queryFn: () => neolixGatewayApi.codexAccounts(),
  });
  const [agent, setAgent] = useState("claude");
  const [key, setKey] = useState("");
  const [importing, setImporting] = useState(false);
  const [signInAgent, setSignInAgent] = useState("chatgpt-api");
  const [signInSite, setSignInSite] = useState("");
  const [signIn, setSignIn] = useState<GatewaySignInState | null>(null);
  const [signInCallback, setSignInCallback] = useState("");
  const [signInError, setSignInError] = useState<string | null>(null);
  const [codexImportOpen, setCodexImportOpen] = useState(false);
  const [codexImportText, setCodexImportText] = useState("");
  const [codexNotice, setCodexNotice] = useState<string | null>(null);

  const accounts: GatewaySubscriptionAccount[] = subscriptions.data?.accounts ?? [];
  const codexAccounts = codex.data?.owned ?? [];
  const codexSignIn = codex.data?.codex ?? null;

  const refreshAccounts = () => {
    void subscriptions.refetch();
    void codex.refetch();
  };

  // A waiting sign-in is followed until it ends, as myna's window does.
  const waitingId = signIn?.state === "waiting" ? signIn.id : "";
  useEffect(() => {
    if (!waitingId) return;
    let stopped = false;
    const timer = setInterval(() => {
      void neolixGatewayApi
        .signInStatus(waitingId)
        .then((result) => {
          if (stopped) return;
          setSignIn(result.state);
          if (result.state.state === "done") {
            void subscriptions.refetch();
            void codex.refetch();
          }
        })
        .catch(() => undefined);
    }, 800);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // run only while a specific sign-in is waiting
  }, [waitingId, subscriptions.refetch, codex.refetch]);

  const startSignIn = (target: string, site?: string) =>
    runStartSignIn(target, site, t, setSignIn, setSignInCallback, setSignInError);

  const cancelSignIn = () => {
    if (signIn && signIn.id) {
      void neolixGatewayApi.signInCancel(signIn.id).catch(() => undefined);
    }
    setSignIn(null);
    setSignInCallback("");
  };

  const finishSignIn = () =>
    runFinishSignIn(
      signIn,
      signInCallback,
      t,
      subscriptions.refetch,
      codex.refetch,
      setSignIn,
      setSignInError,
    );

  const importCodex = (fromCodex: boolean) =>
    runImportCodex(
      fromCodex,
      codexImportText,
      t,
      codex.refetch,
      setSignInError,
      setCodexNotice,
      setCodexImportOpen,
      setCodexImportText,
    );

  const moveCodex = (id: string, delta: -1 | 1) => {
    const order = codexAccounts.map((account) => account.id);
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    void neolixGatewayApi
      .codexAccountArrange(order)
      .then(() => codex.refetch())
      .catch((error: unknown) => setSignInError(errorText(error)));
  };

  const add = async () => {
    if (!key.trim()) return;
    try {
      await neolixGatewayApi.subscriptionAdd({ agent, key: key.trim() });
      setKey("");
      await subscriptions.refetch();
      toastManager.add({ type: "success", title: t("gateway:saved") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SettingsSection title="gateway:subscriptions_title">
      <div className="flex flex-wrap items-end gap-2 px-3 py-2">
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:signin_agent")}</span>
          <select
            value={signInAgent}
            onChange={(event) => setSignInAgent(event.currentTarget.value)}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            <option value="chatgpt-api">ChatGPT API</option>
            <option value="copilot">Copilot</option>
            <option value="gemini">Gemini CLI</option>
            <option value="antigravity">Antigravity</option>
          </select>
        </label>
        {signInAgent === "copilot" ? (
          <div className="min-w-48 flex-1">
            <GatewayField
              label={t("gateway:signin_site")}
              value={signInSite}
              onChange={setSignInSite}
              placeholder="github.com"
            />
          </div>
        ) : null}
        {signInAgent === "antigravity" ? (
          <div className="basis-full text-ui-xs text-muted-foreground">
            {t("gateway:signin_risk_antigravity")}
          </div>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void startSignIn(signInAgent, signInAgent === "copilot" ? signInSite : undefined)
          }
        >
          {t("gateway:signin")}
        </Button>
      </div>
      {signIn !== null ? (
        <div className="mx-3 my-2 space-y-2 rounded-lg border border-[color:var(--color-border)] p-3">
          <div className="text-ui-sm text-foreground">
            {signIn.state === "done"
              ? t("gateway:signin_done", { user: signIn.user ?? "" })
              : signIn.state === "failed" || signIn.state === "canceled"
                ? t("gateway:signin_failed")
                : t("gateway:signin_waiting", { agent: signIn.agent })}
          </div>
          {signIn.code ? (
            <code className="block text-ui-lg tracking-widest text-foreground">{signIn.code}</code>
          ) : null}
          {signIn.code ? (
            <div className="text-ui-xs text-muted-foreground">
              {t("gateway:signin_device_hint")}
            </div>
          ) : null}
          {signIn.url ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-foreground/5 px-2 py-1 text-ui-xs">
                {signIn.url}
              </code>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => window.open(signIn.url, "_blank", "noopener,noreferrer")}
              >
                {t("gateway:open")}
              </Button>
            </div>
          ) : null}
          {signIn.pasteCallback === true && signIn.state === "waiting" ? (
            <div className="space-y-2">
              <div className="text-ui-xs text-muted-foreground">
                {t("gateway:signin_paste_hint")}
              </div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <GatewayField
                    label=""
                    value={signInCallback}
                    onChange={setSignInCallback}
                    placeholder={t("gateway:signin_paste_placeholder")}
                  />
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={signInCallback.trim() === ""}
                  onClick={() => void finishSignIn()}
                >
                  {t("gateway:signin_finish")}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex gap-1">
            {signIn.state === "done" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setSignIn(null);
                  refreshAccounts();
                }}
              >
                {t("gateway:close")}
              </Button>
            ) : (
              <Button size="xs" variant="ghost" onClick={cancelSignIn}>
                {t("gateway:cancel")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {signInError ? (
        <div className="px-3 py-1 text-ui-sm text-destructive">{signInError}</div>
      ) : null}
      <div className="flex flex-wrap items-end gap-2 px-3 py-2">
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:agent")}</span>
          <select
            value={agent}
            onChange={(event) => setAgent(event.currentTarget.value)}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="antigravity">antigravity</option>
            <option value="factory">factory</option>
            <option value="copilot">copilot</option>
            <option value="gemini">gemini</option>
          </select>
        </label>
        <div className="min-w-48 flex-1">
          <GatewayField
            label={t("gateway:add_by_key")}
            value={key}
            onChange={setKey}
            placeholder="fk-…"
            type="password"
          />
        </div>
        <Button size="xs" variant="outline" onClick={() => void add()}>
          {t("gateway:add_account")}
        </Button>
        <label className="cursor-pointer rounded-md border border-[color:var(--color-border)] px-2 py-1 text-ui-xs text-muted-foreground hover:text-foreground">
          {importing ? t("gateway:importing") : t("gateway:import_files")}
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              if (files.length === 0) return;
              void runSubscriptionImport(files, agent, subscriptions.refetch, t, setImporting);
            }}
          />
        </label>
      </div>

      {subscriptions.isLoading ? (
        <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
      ) : accounts.length === 0 ? (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:no_subscriptions")}</GatewayEmpty>
        </div>
      ) : (
        accounts.map((account) => (
          <GatewayRow
            key={account.id}
            title={account.alias ?? account.user}
            description={`${account.agent} · ${account.plan ?? ""} · ${account.lapsed ?? ""}`}
            trailing={
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    try {
                      await neolixGatewayApi.subscriptionSwitch({
                        agent: account.agent,
                        user: account.user,
                      });
                      await subscriptions.refetch();
                    } catch (error) {
                      toastManager.add({
                        type: "error",
                        title: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }}
                >
                  {t("gateway:switch")}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await neolixGatewayApi.subscriptionRemove({
                        agent: account.agent,
                        user: account.user,
                      });
                      await subscriptions.refetch();
                    } catch (error) {
                      toastManager.add({
                        type: "error",
                        title: error instanceof Error ? error.message : String(error),
                      });
                    }
                  }}
                >
                  {t("gateway:remove")}
                </Button>
              </div>
            }
          />
        ))
      )}

      <div className="px-3 py-2 text-ui-xs uppercase tracking-wide text-muted-foreground">
        {t("gateway:codex_accounts")}
      </div>
      <div className="flex flex-wrap items-center gap-1 px-3 pb-1">
        <Button size="xs" variant="outline" onClick={() => void startSignIn("codex")}>
          {t("gateway:codex_signin")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void startSignIn("codex", "device")}>
          {t("gateway:codex_device_signin")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setCodexImportOpen((open) => !open);
            setCodexNotice(null);
          }}
        >
          {t("gateway:codex_import")}
        </Button>
      </div>
      {codexImportOpen ? (
        <div className="mx-3 my-1 space-y-2 rounded-lg border border-[color:var(--color-border)] p-3">
          <GatewayTextarea
            label={t("gateway:codex_import_label")}
            value={codexImportText}
            onChange={setCodexImportText}
            rows={4}
            placeholder='{ "tokens": { … } }'
            hint={t("gateway:codex_import_hint")}
          />
          <div className="flex flex-wrap gap-1">
            <Button size="xs" variant="ghost" onClick={() => void importCodex(true)}>
              {t("gateway:codex_import_own")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={codexImportText.trim() === ""}
              onClick={() => void importCodex(false)}
            >
              {t("gateway:codex_import_action")}
            </Button>
          </div>
        </div>
      ) : null}
      {codexNotice ? (
        <div className="px-3 py-1 text-ui-sm text-muted-foreground">{codexNotice}</div>
      ) : null}
      {codexSignIn ? (
        <GatewayRow
          title={String(codexSignIn.label ?? t("gateway:codex_signin"))}
          description={`${String(codexSignIn.plan ?? "")} · ${String(
            codexSignIn.signedIn === true ? t("gateway:ready") : t("gateway:unknown"),
          )}`}
        />
      ) : null}
      {codexAccounts.length === 0 ? (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:no_codex_accounts")}</GatewayEmpty>
        </div>
      ) : (
        codexAccounts.map((account, index) => (
          <GatewayRow
            key={account.id}
            title={account.label || account.id}
            description={`${account.plan ?? ""}${
              account.disabled === true ? ` · ${t("gateway:off")}` : ""
            }`}
            trailing={
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => moveCodex(account.id, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={index === codexAccounts.length - 1}
                  onClick={() => moveCodex(account.id, 1)}
                >
                  ↓
                </Button>
                <GatewayToggle
                  checked={account.disabled !== true}
                  label={t("gateway:enabled")}
                  onChange={(checked) =>
                    void neolixGatewayApi.codexAccountSet(account.id, checked).then(() => {
                      void codex.refetch();
                    })
                  }
                />
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    void neolixGatewayApi.codexAccountRemove(account.id).then(() => {
                      void codex.refetch();
                    })
                  }
                >
                  {t("gateway:remove")}
                </Button>
              </div>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

function HeldReportsSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const held = useQuery({
    queryKey: ["neolix-gateway", "held"],
    queryFn: neolixGatewayApi.heldList,
    enabled: open,
  });
  const reports = held.data?.names ?? [];
  return (
    <SettingsSection title="gateway:held_title">
      <GatewayRow
        title={t("gateway:held_hint")}
        description={t("gateway:held_description")}
        trailing={
          <Button size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? t("gateway:hide") : t("gateway:show")}
          </Button>
        }
      />
      {open ? (
        reports.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_held")}</GatewayEmpty>
          </div>
        ) : (
          reports.map((name) => (
            <GatewayRow
              key={name}
              title={name}
              trailing={
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void neolixGatewayApi.heldRead(name).then((detail) =>
                        toastManager.add({
                          type: "info",
                          title: name,
                          description: JSON.stringify(detail).slice(0, 500),
                        }),
                      )
                    }
                  >
                    {t("gateway:open")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void neolixGatewayApi.heldReveal(name)}
                  >
                    {t("gateway:reveal")}
                  </Button>
                </div>
              }
            />
          ))
        )
      ) : null}
    </SettingsSection>
  );
}
