// FILE: GatewayProvidersPane.tsx
// Purpose: Model sources — add, edit, reorder, enable and test providers, their
//          models and credential accounts, and import sources from other apps.
// Layer: Settings panel pane

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayAccount,
  GatewayConfig,
  GatewayImportSource,
  GatewayProvider,
  GatewayProviderDetectResult,
  GatewayProviderTestResult,
  GatewayUpstreamStatus,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { providerAccountName, providerKeySummary, providerProbeTarget } from "./gatewayHelpers";
import {
  GatewayEmpty,
  GatewayField,
  GatewayNumberField,
  GatewayPill,
  GatewayRow,
  GatewayToggle,
} from "./GatewayPrimitives";
import { GatewayPresetDialog } from "./GatewayPresetDialog";
import { GatewayModelsTable } from "./GatewayModelsTable";
import {
  AccountAdvancedFields,
  ProviderClaudeMode,
  ProviderCountFree,
  ProviderExtraBody,
  ProviderHeaders,
  ProviderModelPricing,
  ProviderRateWindows,
  ProviderWorkspace,
} from "./GatewayProviderAdvanced";

export interface GatewayProvidersProps {
  config: GatewayConfig;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
  apply: (mutate: (draft: GatewayConfig) => void) => Promise<void>;
}

function updateProvider(
  edit: GatewayProvidersProps["edit"],
  id: string,
  mutate: (provider: GatewayProvider) => void,
) {
  edit((draft) => {
    const provider = (draft.providers ?? []).find((candidate) => candidate.id === id);
    if (provider) mutate(provider);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function importKey(sourceId: string, ref: string): string {
  return `${sourceId}/${ref}`;
}

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

type Translate = ReturnType<typeof useTranslation>["t"];

async function runProviderTest(
  provider: GatewayProvider,
  translate: Translate,
  setTesting: (value: string | null) => void,
  setTestResult: (
    updater: (
      current: Record<string, GatewayProviderTestResult>,
    ) => Record<string, GatewayProviderTestResult>,
  ) => void,
): Promise<void> {
  const model = provider.models[0]?.id;
  if (!model) {
    toastManager.add({ type: "error", title: translate("gateway:no_models_to_test") });
    return;
  }
  setTesting(provider.id);
  try {
    const result = await neolixGatewayApi.providerTestModel({
      target: providerProbeTarget(provider),
      model,
    });
    setTestResult((current) => ({ ...current, [provider.id]: result }));
    toastManager.add({
      type: result.ok ? "success" : "error",
      title: result.ok
        ? translate("gateway:test_ok", { ms: Math.round(result.latencyMs) })
        : translate("gateway:test_failed", { status: result.status }),
      ...(result.error ? { description: result.error } : {}),
    });
  } catch (error) {
    toastManager.add({ type: "error", title: messageOf(error) });
  } finally {
    setTesting(null);
  }
}

async function runFetchModels(
  provider: GatewayProvider,
  edit: GatewayProvidersProps["edit"],
  translate: Translate,
): Promise<void> {
  try {
    const result = await neolixGatewayApi.providerModels(providerProbeTarget(provider));
    if (result.error) throw new Error(result.error);
    if (result.models.length === 0) {
      toastManager.add({ type: "info", title: translate("gateway:no_models_found") });
      return;
    }
    updateProvider(edit, provider.id, (draft) => {
      const known = new Set(draft.models.map((model) => model.id));
      for (const id of result.models) {
        if (!known.has(id)) draft.models.push({ id });
      }
    });
    toastManager.add({
      type: "success",
      title: translate("gateway:models_added", { count: result.models.length }),
    });
  } catch (error) {
    toastManager.add({ type: "error", title: messageOf(error) });
  }
}

async function runReadBalance(
  provider: GatewayProvider,
  translate: Translate,
  setBalance: (updater: (current: Record<string, string>) => Record<string, string>) => void,
): Promise<void> {
  if (!provider.balanceUrl) {
    toastManager.add({ type: "error", title: translate("gateway:no_balance_url") });
    return;
  }
  try {
    const bases = [
      provider.baseUrl.trim(),
      ...(provider.accounts ?? []).map((account) => account.baseUrl?.trim() ?? ""),
    ].filter((entry) => entry.length > 0);
    const result = await neolixGatewayApi.providerBalance({
      target: {
        balanceUrl: provider.balanceUrl,
        ...(provider.balancePath === undefined ? {} : { balancePath: provider.balancePath }),
        ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
        ...(bases.length === 0 ? {} : { baseUrls: bases }),
        ...(provider.headers === undefined ? {} : { headers: provider.headers }),
        ...(provider.balanceMethod === undefined ? {} : { method: provider.balanceMethod }),
        ...(provider.balanceToken === undefined ? {} : { token: provider.balanceToken }),
      } as never,
    });
    setBalance((current) => ({
      ...current,
      [provider.id]: result.amount ?? result.error ?? translate("gateway:unknown"),
    }));
  } catch (error) {
    toastManager.add({ type: "error", title: messageOf(error) });
  }
}

async function runPreviewImport(
  translate: Translate,
  setImporting: (value: boolean) => void,
  setSelectedImports: (value: string[]) => void,
  setImportSources: (value: GatewayImportSource[] | null) => void,
): Promise<void> {
  setImporting(true);
  try {
    const result = await neolixGatewayApi.providerPreviewImport();
    setSelectedImports([]);
    setImportSources(result.sources);
  } catch (error) {
    toastManager.add({ type: "error", title: messageOf(error) });
  } finally {
    setImporting(false);
  }
}

export function GatewayProvidersPane({ config, edit, apply }: GatewayProvidersProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [maskAccounts, setMaskAccounts] = useState(true);
  const [offOpen, setOffOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [importSources, setImportSources] = useState<GatewayImportSource[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [selectedImports, setSelectedImports] = useState<string[]>([]);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, GatewayProviderTestResult>>({});
  const [detectResult, setDetectResult] = useState<Record<string, GatewayProviderDetectResult>>({});
  const [balance, setBalance] = useState<Record<string, string>>({});
  const [upstream, setUpstream] = useState<GatewayUpstreamStatus | null>(null);

  const presets = useQuery({
    queryKey: ["neolix-gateway", "presets"],
    queryFn: neolixGatewayApi.presets,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const providers = config.providers ?? [];
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? providers.filter(
        (provider) =>
          provider.id.toLowerCase().includes(needle) ||
          (provider.label ?? "").toLowerCase().includes(needle) ||
          provider.baseUrl.toLowerCase().includes(needle),
      )
    : providers;

  const addProvider = (provider: GatewayProvider) => {
    edit((draft) => {
      draft.providers = [...(draft.providers ?? []), provider];
    });
    setEditing(provider.id);
  };

  const moveProvider = (id: string, direction: -1 | 1) => {
    edit((draft) => {
      const list = draft.providers ?? [];
      const index = list.findIndex((provider) => provider.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= list.length) return;
      const [entry] = list.splice(index, 1);
      if (entry) list.splice(target, 0, entry);
    });
  };

  const detect = async (provider: GatewayProvider) => {
    try {
      const result = await neolixGatewayApi.providerDetect({
        target: providerProbeTarget(provider),
      });
      setDetectResult((current) => ({ ...current, [provider.id]: result }));
    } catch (error) {
      toastManager.add({ type: "error", title: messageOf(error) });
    }
  };

  const existingIds = new Set(providers.map((provider) => provider.id));
  const existingBaseUrls = new Set(
    providers.map((provider) => normalizedBaseUrl(provider.baseUrl)),
  );
  const importTaken = (item: GatewayImportSource["providers"][number]) =>
    existingBaseUrls.has(normalizedBaseUrl(item.baseUrl)) ||
    existingIds.has(item.name.toLowerCase().replace(/[^a-z0-9-]/gu, "-"));

  const toggleImport = (key: string) => {
    setSelectedImports((current) =>
      current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
    );
  };

  const importSelected = () => {
    for (const source of importSources ?? []) {
      for (const item of source.providers) {
        if (selectedImports.includes(importKey(source.id, item.ref))) {
          importProvider(source, item.ref);
        }
      }
    }
    setImportSources(null);
    setSelectedImports([]);
  };

  const importProvider = (source: GatewayImportSource, ref: string) => {
    const imported = source.providers.find((entry) => entry.ref === ref);
    if (!imported) return;
    edit((draft) => {
      const list = draft.providers ?? [];
      let id =
        imported.name
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/gu, "-")
          .replace(/^-+|-+$/gu, "") || "imported";
      const base = id;
      let index = 2;
      while (list.some((provider) => provider.id === id)) {
        id = `${base}-${index}`;
        index += 1;
      }
      list.push({
        id,
        label: imported.name,
        protocol: imported.protocol,
        baseUrl: imported.baseUrl,
        ...(imported.apiKey === undefined ? {} : { apiKey: imported.apiKey }),
        ...(imported.headers === undefined ? {} : { headers: imported.headers }),
        models: imported.models.map((model) => ({ id: model })),
        enabled: imported.enabled !== false,
      });
      draft.providers = list;
    });
    toastManager.add({ type: "success", title: t("gateway:imported", { name: imported.name }) });
  };

  const readUpstream = async () => {
    try {
      setUpstream(await neolixGatewayApi.providerUpstreamStatus());
    } catch (error) {
      toastManager.add({ type: "error", title: messageOf(error) });
    }
  };

  const onVisible = visible.filter((provider) => provider.enabled !== false);
  const offVisible = visible.filter((provider) => provider.enabled === false);

  const renderProvider = (provider: GatewayProvider) => {
    const enabled = provider.enabled !== false;
    const testState = testResult[provider.id];
    const detectState = detectResult[provider.id];
    const key = providerKeySummary(provider);
    const accountName = providerAccountName(provider);
    return (
      <div key={provider.id} className="px-3 py-2.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={enabled ? "text-ui font-medium" : "text-ui font-medium opacity-60"}>
                {provider.label ?? provider.id}
              </span>
              <GatewayPill>{provider.protocol}</GatewayPill>
              <GatewayPill>
                {t("gateway:model_count", { count: provider.models.length })}
              </GatewayPill>
              {provider.accounts && provider.accounts.length > 0 ? (
                <GatewayPill>
                  {t("gateway:account_count", { count: provider.accounts.length })}
                </GatewayPill>
              ) : null}
              <GatewayPill
                tone={key.kind === "key" ? "ok" : key.kind === "needsKey" ? "warn" : "muted"}
              >
                {key.kind === "key" ? key.text : t(`gateway:provider_key_${key.kind}`)}
              </GatewayPill>
              {balance[provider.id] ? (
                <GatewayPill tone="ok">{balance[provider.id]}</GatewayPill>
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-ui-xs text-muted-foreground">
              {provider.baseUrl || t("gateway:no_base_url")}
              {maskAccounts && accountName ? ` · ${t("gateway:account_hidden")}` : ""}
              {!maskAccounts && accountName ? ` · ${accountName}` : ""}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <GatewayToggle
              checked={enabled}
              label={provider.id}
              onChange={(checked) =>
                void apply((draft) => {
                  const target = draft.providers?.find((entry) => entry.id === provider.id);
                  if (target) target.enabled = checked;
                })
              }
            />
            <Button size="xs" variant="ghost" onClick={() => moveProvider(provider.id, -1)}>
              ↑
            </Button>
            <Button size="xs" variant="ghost" onClick={() => moveProvider(provider.id, 1)}>
              ↓
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={testing === provider.id}
              onClick={() => void runProviderTest(provider, t, setTesting, setTestResult)}
            >
              {t("gateway:test")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void runFetchModels(provider, edit, t)}
            >
              {t("gateway:fetch_models")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void detect(provider)}>
              {t("gateway:detect")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void runReadBalance(provider, t, setBalance)}
            >
              {t("gateway:balance")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setEditing(editing === provider.id ? null : provider.id)}
            >
              {editing === provider.id ? t("gateway:close") : t("gateway:edit")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                if (!window.confirm(t("gateway:remove_source_confirm", { name: provider.id }))) {
                  return;
                }
                edit((draft) => {
                  draft.providers = (draft.providers ?? []).filter(
                    (entry) => entry.id !== provider.id,
                  );
                });
                setEditing(null);
              }}
            >
              {t("gateway:remove")}
            </Button>
          </div>
        </div>

        {testState !== undefined ? (
          <div className="mt-1 text-ui-xs text-muted-foreground">
            {testState.ok
              ? t("gateway:test_ok", { ms: Math.round(testState.latencyMs) })
              : `${testState.status} ${testState.error ?? ""}`}
          </div>
        ) : null}
        {detectState !== undefined ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {detectState.results.map((result) => (
              <GatewayPill
                key={`${result.protocol}-${result.base}`}
                tone={result.ok ? "ok" : "muted"}
              >
                {result.protocol} {result.status}
              </GatewayPill>
            ))}
          </div>
        ) : null}

        {editing === provider.id ? (
          <ProviderEditor provider={provider} config={config} edit={edit} apply={apply} />
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection title="gateway:providers_title">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Input
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
            placeholder={t("gateway:search_sources")}
            size="sm"
            variant="soft"
            className="min-w-40 flex-1"
          />
          <Button size="sm" variant="outline" onClick={() => setPresetOpen(true)}>
            {t("gateway:add_source")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={importing}
            onClick={() =>
              void runPreviewImport(t, setImporting, setSelectedImports, setImportSources)
            }
          >
            {importing ? t("gateway:importing") : t("gateway:import")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void readUpstream()}>
            {t("gateway:upstream")}
          </Button>
          <label className="flex items-center gap-1.5 text-ui-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={maskAccounts}
              onChange={(event) => setMaskAccounts(event.currentTarget.checked)}
            />
            {t("gateway:mask_accounts")}
          </label>
        </div>

        {importSources !== null ? (
          <div className="space-y-2 px-3 py-2">
            {importSources.length === 0 ? (
              <GatewayEmpty>{t("gateway:nothing_to_import")}</GatewayEmpty>
            ) : (
              <>
                {importSources.map((source) => (
                  <div
                    key={source.id}
                    className="rounded-lg border border-[color:var(--color-border)] p-2"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-ui-sm font-medium">{source.name}</span>
                      <span className="truncate text-ui-xs text-muted-foreground">
                        {source.path}
                      </span>
                    </div>
                    {source.found === false ? (
                      <GatewayEmpty>{t("gateway:import_not_found")}</GatewayEmpty>
                    ) : source.providers.length === 0 ? (
                      <GatewayEmpty>{source.error ?? t("gateway:no_imports_found")}</GatewayEmpty>
                    ) : (
                      source.providers.map((provider) => {
                        const key = importKey(source.id, provider.ref);
                        const taken = importTaken(provider);
                        const selected = selectedImports.includes(key);
                        return (
                          <button
                            key={provider.ref}
                            type="button"
                            disabled={taken}
                            aria-checked={selected}
                            role="checkbox"
                            onClick={() => toggleImport(key)}
                            className={`flex w-full items-center gap-2 border-t border-[color:var(--color-border)] py-1.5 text-left first:border-t-0 ${
                              taken ? "opacity-60" : "hover:bg-foreground/4"
                            }`}
                          >
                            <span
                              className={`flex size-4 shrink-0 items-center justify-center rounded border text-ui-xs ${
                                selected
                                  ? "border-foreground/40 text-foreground"
                                  : "border-[color:var(--color-border)]"
                              }`}
                              aria-hidden="true"
                            >
                              {selected ? "✓" : null}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-ui-sm">
                                {provider.name} · {provider.models.length}
                              </span>
                              <span className="block truncate text-ui-xs text-muted-foreground">
                                {provider.baseUrl} · {provider.protocol}
                              </span>
                            </span>
                            <span
                              className={`shrink-0 text-ui-xs ${
                                taken ? "text-amber-500" : "text-muted-foreground"
                              }`}
                            >
                              {taken
                                ? t("gateway:import_already_added")
                                : provider.apiKey
                                  ? t("gateway:import_has_key")
                                  : t("gateway:import_no_key")}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                ))}
                <div className="flex justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setImportSources(null);
                      setSelectedImports([]);
                    }}
                  >
                    {t("gateway:cancel")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={selectedImports.length === 0}
                    onClick={importSelected}
                  >
                    {t("gateway:import_action", { count: selectedImports.length })}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {upstream !== null ? (
          <div className="px-3 py-2">
            {upstream.statuses.length === 0 ? (
              <GatewayEmpty>{t("gateway:no_upstream")}</GatewayEmpty>
            ) : (
              upstream.statuses.map((status) => (
                <GatewayRow
                  key={status.vendor}
                  title={status.name}
                  description={status.error ?? status.parts.map((part) => part.name).join(", ")}
                  trailing={
                    <GatewayPill
                      tone={
                        status.level === "ok"
                          ? "ok"
                          : status.level === null
                            ? "muted"
                            : status.level === "maintenance"
                              ? "muted"
                              : "warn"
                      }
                    >
                      {status.level ?? t("gateway:unknown")}
                    </GatewayPill>
                  }
                />
              ))
            )}
          </div>
        ) : null}

        {providers.length === 0 ? (
          <div className="px-3 py-2">
            <GatewayEmpty>{t("gateway:no_sources")}</GatewayEmpty>
          </div>
        ) : (
          <>
            {onVisible.map(renderProvider)}
            {offVisible.length > 0 ? (
              <div className="border-t border-[color:var(--color-border)]">
                <button
                  type="button"
                  aria-expanded={offOpen}
                  onClick={() => setOffOpen((open) => !open)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-ui-sm text-muted-foreground hover:text-foreground"
                >
                  <span>{t("gateway:off_sources", { count: offVisible.length })}</span>
                  <span aria-hidden="true">{offOpen ? "▾" : "▸"}</span>
                </button>
                {offOpen ? offVisible.map(renderProvider) : null}
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>
      <GatewayPresetDialog
        open={presetOpen}
        onOpenChange={setPresetOpen}
        presets={presets.data ?? []}
        loading={presets.isLoading}
        error={presets.error ? String(presets.error) : null}
        config={config}
        onCreate={addProvider}
        onImport={() =>
          void runPreviewImport(t, setImporting, setSelectedImports, setImportSources)
        }
      />
    </div>
  );
}

function ProviderEditor({
  provider,
  config,
  edit,
  apply,
}: {
  provider: GatewayProvider;
  config: GatewayConfig;
  edit: GatewayProvidersProps["edit"];
  apply: GatewayProvidersProps["apply"];
}) {
  const { t } = useTranslation();
  const update = (mutate: (draft: GatewayProvider) => void) =>
    updateProvider(edit, provider.id, mutate);

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[color:var(--color-border)] p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <GatewayField
          label={t("gateway:label")}
          value={provider.label ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.label = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:base_url")}
          value={provider.baseUrl}
          onChange={(value) =>
            update((draft) => {
              draft.baseUrl = value;
            })
          }
          placeholder="https://api.example.com/v1"
        />
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:protocol")}</span>
          <select
            value={provider.protocol}
            onChange={(event) => {
              const value = event.currentTarget.value as GatewayProvider["protocol"];
              update((draft) => {
                draft.protocol = value;
              });
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            <option value="openai">openai</option>
            <option value="openai-responses">openai-responses</option>
            <option value="anthropic">anthropic</option>
            <option value="gemini">gemini</option>
          </select>
        </label>
        <GatewayField
          label={t("gateway:api_key")}
          value={provider.apiKey ?? ""}
          type="password"
          onChange={(value) =>
            update((draft) => {
              draft.apiKey = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:models_url")}
          value={provider.modelsUrl ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.modelsUrl = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:provider_family")}
          value={provider.family ?? ""}
          hint={t("gateway:provider_family_hint")}
          onChange={(value) =>
            update((draft) => {
              draft.family = value.trim() || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:provider_decide")}
          value={provider.decide ?? ""}
          hint={t("gateway:provider_decide_hint")}
          onChange={(value) =>
            update((draft) => {
              draft.decide = value.trim() || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:provider_icon")}
          value={provider.icon ?? ""}
          hint={t("gateway:provider_icon_hint")}
          onChange={(value) =>
            update((draft) => {
              draft.icon = value.trim() || undefined;
            })
          }
        />
        <ProviderWorkspace provider={provider} edit={edit} />
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:model_mode")}</span>
          <select
            value={provider.modelMode ?? "list"}
            onChange={(event) => {
              const value = event.currentTarget.value as GatewayProvider["modelMode"];
              update((draft) => {
                draft.modelMode = value;
              });
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            <option value="list">list</option>
            <option value="picked">picked</option>
            <option value="best">best</option>
            <option value="none">none</option>
          </select>
        </label>
        <GatewayNumberField
          label={t("gateway:max_accounts")}
          value={provider.maxAccounts}
          min={1}
          onChange={(value) =>
            update((draft) => {
              draft.maxAccounts = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:queue_wait")}
          value={provider.queueWaitMs}
          min={0}
          onChange={(value) =>
            update((draft) => {
              draft.queueWaitMs = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:price_rate")}
          value={provider.priceRate}
          min={0}
          onChange={(value) =>
            update((draft) => {
              draft.priceRate = value;
            })
          }
        />
        <GatewayField
          label={t("gateway:balance_url")}
          value={provider.balanceUrl ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.balanceUrl = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:balance_path")}
          value={provider.balancePath ?? ""}
          onChange={(value) =>
            update((draft) => {
              draft.balancePath = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:balance_token")}
          value={provider.balanceToken ?? ""}
          hint={t("gateway:balance_token_hint")}
          type="password"
          onChange={(value) =>
            update((draft) => {
              draft.balanceToken = value || undefined;
            })
          }
        />
        <label className="flex flex-col gap-1">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:balance_method")}</span>
          <select
            value={provider.balanceMethod ?? "GET"}
            onChange={(event) => {
              const value = event.currentTarget.value as "GET" | "POST";
              update((draft) => {
                draft.balanceMethod = value;
              });
            }}
            className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={provider.exposeModels !== false}
            label={t("gateway:expose_models")}
            onChange={(checked) =>
              update((draft) => {
                draft.exposeModels = checked;
              })
            }
          />
          {t("gateway:expose_models")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={provider.unredacted === true}
            label={t("gateway:unredacted")}
            onChange={(checked) =>
              update((draft) => {
                draft.unredacted = checked;
              })
            }
          />
          {t("gateway:unredacted")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={provider.searches === true}
            label={t("gateway:searches")}
            onChange={(checked) =>
              update((draft) => {
                draft.searches = checked;
              })
            }
          />
          {t("gateway:searches")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={provider.sink === true}
            label={t("gateway:sink")}
            onChange={(checked) =>
              update((draft) => {
                draft.sink = checked;
              })
            }
          />
          {t("gateway:sink")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={provider.insecureTls === true}
            label={t("gateway:insecure_tls")}
            onChange={(checked) =>
              update((draft) => {
                draft.insecureTls = checked;
              })
            }
          />
          {t("gateway:insecure_tls")}
        </label>
      </div>

      <div className="space-y-3 rounded-lg border border-[color:var(--color-border)] p-3">
        <div className="text-ui-sm font-medium text-foreground">
          {t("gateway:provider_advanced")}
        </div>
        <ProviderHeaders provider={provider} edit={edit} />
        <ProviderExtraBody provider={provider} edit={edit} />
        <ProviderRateWindows provider={provider} edit={edit} />
        <ProviderCountFree provider={provider} edit={edit} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:models")}</span>
        </div>
        <GatewayModelsTable provider={provider} config={config} edit={edit} />
      </div>

      <ProviderModelPricing provider={provider} config={config} edit={edit} />

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:accounts")}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              update((draft) => {
                draft.accounts = [
                  ...(draft.accounts ?? []),
                  { id: `account-${(draft.accounts?.length ?? 0) + 1}`, apiKey: "" },
                ];
              })
            }
          >
            {t("gateway:add_account")}
          </Button>
        </div>
        {(provider.accounts ?? []).length === 0 ? (
          <div className="text-ui-xs text-muted-foreground">{t("gateway:single_account_hint")}</div>
        ) : (
          (provider.accounts ?? []).map((account, index) => (
            <AccountEditor
              key={`${account.id}-${account.label ?? ""}-${account.apiKey ?? ""}`}
              account={account}
              onChange={(mutate) =>
                update((draft) => {
                  const target = draft.accounts?.[index];
                  if (target) mutate(target);
                })
              }
              onRemove={() =>
                update((draft) => {
                  draft.accounts = (draft.accounts ?? []).filter((_, at) => at !== index);
                })
              }
            />
          ))
        )}
      </div>

      <ProviderClaudeMode provider={provider} config={config} apply={apply} />
    </div>
  );
}

function AccountEditor({
  account,
  onChange,
  onRemove,
}: {
  account: GatewayAccount;
  onChange: (mutate: (draft: GatewayAccount) => void) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 rounded-md border border-[color:var(--color-border)] p-2">
      <div className="grid gap-2 sm:grid-cols-3">
        <GatewayField
          label={t("gateway:account_id")}
          value={account.id}
          onChange={(value) =>
            onChange((draft) => {
              draft.id = value;
            })
          }
        />
        <GatewayField
          label={t("gateway:label")}
          value={account.label ?? ""}
          onChange={(value) =>
            onChange((draft) => {
              draft.label = value || undefined;
            })
          }
        />
        <GatewayField
          label={t("gateway:api_key")}
          value={account.apiKey ?? ""}
          type="password"
          onChange={(value) =>
            onChange((draft) => {
              draft.apiKey = value || undefined;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:priority")}
          value={account.priority}
          onChange={(value) =>
            onChange((draft) => {
              draft.priority = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:weight")}
          value={account.weight}
          min={0}
          onChange={(value) =>
            onChange((draft) => {
              draft.weight = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:max_rpm")}
          value={account.maxRpm}
          min={1}
          onChange={(value) =>
            onChange((draft) => {
              draft.maxRpm = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:max_concurrency")}
          value={account.maxConcurrency}
          min={1}
          onChange={(value) =>
            onChange((draft) => {
              draft.maxConcurrency = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:monthly_usd")}
          value={account.monthlyUsd}
          min={0}
          onChange={(value) =>
            onChange((draft) => {
              draft.monthlyUsd = value;
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:tokens_5h")}
          value={account.quota?.tokens5h}
          min={1}
          onChange={(value) =>
            onChange((draft) => {
              draft.quota = { ...draft.quota, tokens5h: value };
            })
          }
        />
        <GatewayNumberField
          label={t("gateway:tokens_7d")}
          value={account.quota?.tokens7d}
          min={1}
          onChange={(value) =>
            onChange((draft) => {
              draft.quota = { ...draft.quota, tokens7d: value };
            })
          }
        />
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <AccountAdvancedFields account={account} onChange={onChange} />
        {account.agent === "claude-code" ? (
          <GatewayField
            label={t("gateway:account_config_dir")}
            value={account.configDir ?? ""}
            hint={t("gateway:account_config_dir_hint")}
            onChange={(value) =>
              onChange((draft) => {
                draft.configDir = value.trim() || undefined;
              })
            }
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={account.enabled !== false}
            label={`${account.id} enabled`}
            onChange={(checked) =>
              onChange((draft) => {
                draft.enabled = checked;
              })
            }
          />
          {t("gateway:enabled")}
        </label>
        <label className="flex items-center gap-2 text-ui-sm">
          <GatewayToggle
            checked={account.warmup === true}
            label={`${account.id} warmup`}
            onChange={(checked) =>
              onChange((draft) => {
                draft.warmup = checked;
              })
            }
          />
          {t("gateway:warmup")}
        </label>
        <Button size="xs" variant="ghost" onClick={onRemove}>
          {t("gateway:remove")}
        </Button>
      </div>
    </div>
  );
}
