// FILE: ProviderDetailsDialog.tsx
// Purpose: One provider's model inventory — discovered and custom — plus its daemon
//   self-check, opened from a provider activity row in Settings.
// Layer: Settings UI components
// Depends on: provider discovery query, app settings, the Neox host diagnostic RPC.

import type {
  ProviderKind,
  ProviderListModelsResult,
  ServerProviderStatus,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS,
  MAX_CUSTOM_MODEL_LENGTH,
  type AppSettings,
  getCustomModelsForProvider,
  patchCustomModels,
} from "~/appSettings";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "~/i18n";
import { getProviderDiagnostic } from "~/lib/neolixHostApi";
import { providerSetupStatusLabel } from "~/lib/providerSetupStatus";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";
import { Loader2Icon, PlusIcon, RefreshCwIcon, SearchIcon, TrashCanIcon } from "~/lib/icons";
import { modelQueryOptionsForProviderInstance } from "~/hooks/useProviderModelCatalog";
import { isInitialModelDiscoveryPending } from "~/lib/providerDiscoveryReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";

import { ProviderIcon } from "../ProviderIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { validateCustomModelInput } from "./ModelsSettingsPanel";

/** The list card inside the dialog; same chrome as the settings cards behind it. */
const DETAILS_LIST_CLASS_NAME = cn(
  SETTINGS_INSET_LIST_CLASS_NAME,
  SETTINGS_STACKED_ROWS_DIVIDER_CLASS_NAME,
);

const DIAGNOSTIC_TEXT_CLASS_NAME =
  "max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[color:var(--color-border)] bg-muted/20 p-3 font-mono text-ui-xs leading-relaxed text-foreground";

/** Stable identity while discovery has no data yet, so the filter memo does not re-run. */
const EMPTY_MODEL_LIST: ProviderListModelsResult["models"] = [];

export default function ProviderDetailsDialog(props: {
  provider: ProviderKind;
  providerLabel: string;
  providerStatus: ServerProviderStatus | undefined;
  providerStatusReconciled: boolean;
  enabled: boolean;
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  // The bridge learns which providers the daemon serves while it answers this query; asking
  // for models before it lands would answer "provider is not available" from an empty map.
  const configReady = serverConfigQuery.data !== undefined;
  const cwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const modelsQuery = useQuery(
    modelQueryOptionsForProviderInstance({
      settings: props.settings,
      provider: props.provider,
      instanceId: props.provider,
      cwd,
      enabled: configReady,
    }),
  );

  const customModelConfig =
    CUSTOM_MODEL_EDITOR_PROVIDER_SETTINGS.find((config) => config.provider === props.provider) ??
    null;
  const customModels = customModelConfig
    ? getCustomModelsForProvider(props.settings, props.provider)
    : [];
  const [customModelInput, setCustomModelInput] = useState("");
  const [customModelError, setCustomModelError] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [diagnosticText, setDiagnosticText] = useState<string | null>(null);
  const [diagnosticError, setDiagnosticError] = useState<string | null>(null);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);

  const models = modelsQuery.data?.models ?? EMPTY_MODEL_LIST;
  const modelsPending = !configReady || isInitialModelDiscoveryPending(modelsQuery);
  const modelsError =
    modelsQuery.error instanceof Error
      ? modelsQuery.error.message
      : (modelsQuery.data?.error ?? null);
  const query = modelFilter.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    if (!query) return models;
    return models.filter((model) =>
      `${model.name} ${model.slug} ${model.description ?? ""}`.toLowerCase().includes(query),
    );
  }, [models, query]);

  const statusLabel = providerSetupStatusLabel(
    {
      status: props.providerStatus,
      reconciled: props.providerStatusReconciled,
      disabled: !props.enabled,
    },
    t,
  );
  const statusMessage =
    props.providerStatus?.message &&
    (props.providerStatus.status !== "ready" || props.providerStatus.authStatus !== "authenticated")
      ? props.providerStatus.message
      : null;

  const addCustomModel = () => {
    if (!customModelConfig) return;
    const result = validateCustomModelInput({
      provider: props.provider,
      value: customModelInput,
      savedModels: customModels,
    });
    if ("error" in result) {
      setCustomModelError(result.error);
      return;
    }
    props.updateSettings(patchCustomModels(props.provider, [...customModels, result.model]));
    setCustomModelInput("");
    setCustomModelError(null);
    toastManager.add({
      type: "success",
      title: t("settings:providerDetails_modelAdded", { value0: result.model }),
    });
  };

  const removeCustomModel = (model: string) => {
    props.updateSettings(
      patchCustomModels(
        props.provider,
        customModels.filter((saved) => saved !== model),
      ),
    );
    setCustomModelError(null);
    toastManager.add({
      type: "success",
      title: t("settings:providerDetails_modelRemoved", { value0: model }),
    });
  };

  const runDiagnostic = () => {
    if (diagnosticLoading) return;
    setDiagnosticLoading(true);
    setDiagnosticError(null);
    void getProviderDiagnostic({ provider: props.provider, instanceId: props.provider })
      .then((result) => setDiagnosticText(result.diagnostic))
      .catch((error: unknown) =>
        setDiagnosticError(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setDiagnosticLoading(false));
  };

  const copyDiagnostic = () => {
    if (!diagnosticText) return;
    void copyTextToClipboard(diagnosticText)
      .then(() =>
        toastManager.add({
          type: "success",
          title: t("settings:providerDetails_diagnosticCopied"),
        }),
      )
      .catch(() =>
        toastManager.add({
          type: "error",
          title: t("settings:providerDetails_diagnosticCopyFailed"),
        }),
      );
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <ProviderIcon provider={props.provider} className="size-5 shrink-0" />
            <span className="truncate">{props.providerLabel}</span>
          </DialogTitle>
          <DialogDescription>
            {statusLabel}
            {statusMessage ? <span className="mt-1 block">{statusMessage}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-6">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <h3 className="text-ui-sm font-medium text-foreground">
                {t("settings:providerDetails_discoveredModels")}
              </h3>
              <div className="flex items-center gap-2">
                <span className="text-ui-xs text-muted-foreground">
                  {t("settings:providerDetails_modelCount", { count: models.length })}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={!configReady || modelsQuery.isFetching}
                  onClick={() => void modelsQuery.refetch()}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      (modelsQuery.isFetching || !configReady) && "animate-spin",
                    )}
                  />
                  {modelsQuery.isFetching || !configReady
                    ? t("settings:providerDetails_refreshing")
                    : t("settings:providerDetails_refresh")}
                </Button>
              </div>
            </div>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:providerDetails_discoveredDescription", {
                provider: props.providerLabel,
              })}
            </p>

            {modelsPending ? (
              <div
                className="flex items-center gap-2 rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-6 text-ui-sm text-muted-foreground"
                role="status"
              >
                <Loader2Icon className="size-4 animate-spin" />
                {t("settings:providerDetails_loadingModels")}
              </div>
            ) : modelsError && models.length === 0 ? (
              <div className="space-y-2 rounded-lg border border-dashed border-destructive/30 px-3 py-4">
                <p className="text-ui-sm text-destructive">
                  {t("settings:providerDetails_modelsFailed")}
                </p>
                <p className="break-words text-ui-xs text-muted-foreground">{modelsError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={modelsQuery.isFetching}
                  onClick={() => void modelsQuery.refetch()}
                >
                  {t("settings:providerDetails_retry")}
                </Button>
              </div>
            ) : models.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-6 text-ui-sm text-muted-foreground">
                {t("settings:providerDetails_noModels")}
              </p>
            ) : (
              <div className="space-y-2">
                {modelsError ? (
                  <p className="text-ui-xs text-amber-700 dark:text-amber-300">
                    {t("settings:providerDetails_degraded")}
                  </p>
                ) : null}
                {models.length > 6 ? (
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type="search"
                      size="sm"
                      variant="soft"
                      className="ps-8"
                      value={modelFilter}
                      onChange={(event) => setModelFilter(event.target.value)}
                      placeholder={t("settings:providerDetails_searchModels")}
                      aria-label={t("settings:providerDetails_searchModels")}
                      spellCheck={false}
                    />
                  </div>
                ) : null}
                {visibleModels.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-4 text-ui-sm text-muted-foreground">
                    {t("settings:providerDetails_noModelMatches")}
                  </p>
                ) : (
                  <div className={cn(DETAILS_LIST_CLASS_NAME, "max-h-72 overflow-y-auto")}>
                    {visibleModels.map((model) => (
                      <div key={model.slug} className="min-w-0 px-3 py-2.5">
                        <p className="truncate text-ui font-medium text-foreground">{model.name}</p>
                        <code className="mt-0.5 block truncate font-mono text-ui-xs text-muted-foreground">
                          {model.slug}
                        </code>
                        {model.description && model.description !== model.name ? (
                          <p className="mt-1 line-clamp-2 text-ui-sm text-muted-foreground">
                            {model.description}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {customModelConfig ? (
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-ui-sm font-medium text-foreground">
                  {t("settings:providerDetails_customModels")}
                </h3>
                {customModels.length > 0 ? (
                  <span className="text-ui-xs text-muted-foreground">
                    {t("settings:providerDetails_modelCount", { count: customModels.length })}
                  </span>
                ) : null}
              </div>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:providerDetails_customModelsDescription", {
                  provider: props.providerLabel,
                })}
              </p>
              <div className="flex items-start gap-2">
                <Input
                  size="sm"
                  variant="soft"
                  value={customModelInput}
                  onChange={(event) => {
                    setCustomModelInput(event.target.value);
                    if (customModelError) setCustomModelError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    addCustomModel();
                  }}
                  placeholder={customModelConfig.example}
                  aria-label={t("settings:providerDetails_customModelId")}
                  aria-invalid={customModelError ? true : undefined}
                  spellCheck={false}
                />
                <Button className="shrink-0" size="sm" variant="outline" onClick={addCustomModel}>
                  <PlusIcon className="size-3.5" />
                  {t("settings:providerDetails_addModel")}
                </Button>
              </div>
              {customModelError ? (
                <p className="text-ui-sm text-destructive" role="alert">
                  {t(customModelError, { limit: MAX_CUSTOM_MODEL_LENGTH })}
                </p>
              ) : null}
              {customModels.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-4 text-ui-sm text-muted-foreground">
                  {t("settings:providerDetails_customModelsEmpty")}
                </p>
              ) : (
                <div className={DETAILS_LIST_CLASS_NAME}>
                  {customModels.map((model) => (
                    <div key={model} className="flex min-w-0 items-center gap-2 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-ui text-foreground">
                        {model}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("settings:providerDetails_removeModel", { value0: model })}
                        onClick={() => removeCustomModel(model)}
                      >
                        <TrashCanIcon className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <h3 className="text-ui-sm font-medium text-foreground">
                {t("settings:providerDetails_diagnostic")}
              </h3>
              {diagnosticText ? (
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="xs" onClick={runDiagnostic}>
                    {t("settings:providerDetails_runDiagnostic")}
                  </Button>
                  <Button variant="ghost" size="xs" onClick={copyDiagnostic}>
                    {t("settings:providerDetails_copyDiagnostic")}
                  </Button>
                </div>
              ) : null}
            </div>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:providerDetails_diagnosticDescription")}
            </p>
            {diagnosticLoading ? (
              <div
                className="flex items-center gap-2 rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-6 text-ui-sm text-muted-foreground"
                role="status"
              >
                <Loader2Icon className="size-4 animate-spin" />
                {t("settings:providerDetails_diagnosing")}
              </div>
            ) : diagnosticError ? (
              <div className="space-y-2 rounded-lg border border-dashed border-destructive/30 px-3 py-4">
                <p className="text-ui-sm text-destructive">
                  {t("settings:providerDetails_diagnosticFailed")}
                </p>
                <p className="break-words text-ui-xs text-muted-foreground">{diagnosticError}</p>
                <Button variant="outline" size="sm" onClick={runDiagnostic}>
                  {t("settings:providerDetails_retry")}
                </Button>
              </div>
            ) : diagnosticText ? (
              <pre className={DIAGNOSTIC_TEXT_CLASS_NAME}>{diagnosticText}</pre>
            ) : (
              <Button variant="outline" size="sm" onClick={runDiagnostic}>
                {t("settings:providerDetails_runDiagnostic")}
              </Button>
            )}
          </section>
        </DialogPanel>

        <DialogFooter variant="bare">
          <Button variant="outline" onClick={props.onClose}>
            {t("common:app_close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
