// FILE: GatewayModelsTable.tsx
// Purpose: The provider's model table: every catalog field editable, each model
//          switched on or off, plus add/remove, reorder, sort and filter.
// Layer: Settings UI component

import { useState } from "react";

import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type {
  GatewayConfig,
  GatewayModel,
  GatewayProvider,
  GatewayProviderTestResult,
} from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../../ui/toast";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { GatewayEmpty, GatewayPill, GatewayToggle } from "./GatewayPrimitives";
import { modelDisabled, providerProbeTarget } from "./gatewayHelpers";

type SortField = "order" | "id" | "context" | "kind";

export interface GatewayModelsTableProps {
  provider: GatewayProvider;
  config: GatewayConfig;
  edit: (mutate: (draft: GatewayConfig) => void) => void;
}

function positiveInteger(text: string): number | undefined {
  const value = Number.parseInt(text, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function imageChoice(images: boolean | undefined): "unknown" | "yes" | "no" {
  if (images === undefined) return "unknown";
  return images ? "yes" : "no";
}

async function runModelTest(
  provider: GatewayProvider,
  modelId: string,
  setTesting: (value: string | null) => void,
  setResults: (
    updater: (
      current: Record<string, GatewayProviderTestResult>,
    ) => Record<string, GatewayProviderTestResult>,
  ) => void,
): Promise<void> {
  setTesting(modelId);
  try {
    const result = await neolixGatewayApi.providerTestModel({
      target: providerProbeTarget(provider),
      model: modelId,
    });
    setResults((current) => ({ ...current, [modelId]: result }));
  } catch (error) {
    toastManager.add({
      type: "error",
      title: error instanceof Error ? error.message : String(error),
    });
  } finally {
    setTesting(null);
  }
}

export function GatewayModelsTable({ provider, config, edit }: GatewayModelsTableProps) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [newModel, setNewModel] = useState("");
  const [sort, setSort] = useState<SortField>("order");
  const [ascending, setAscending] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, GatewayProviderTestResult>>({});

  const updateModels = (mutate: (models: GatewayModel[]) => void) =>
    edit((draft) => {
      const target = (draft.providers ?? []).find((entry) => entry.id === provider.id);
      if (target) mutate(target.models);
    });

  const updateModel = (modelId: string, mutate: (model: GatewayModel) => void) =>
    updateModels((models) => {
      const model = models.find((entry) => entry.id === modelId);
      if (model) mutate(model);
    });

  const needle = filter.trim().toLowerCase();
  const rows = provider.models
    .map((model, index) => ({ model, index }))
    .filter(
      ({ model }) =>
        !needle ||
        model.id.toLowerCase().includes(needle) ||
        (model.label ?? "").toLowerCase().includes(needle) ||
        (model.kind ?? "chat").includes(needle),
    );
  if (sort !== "order") {
    rows.sort((left, right) => {
      const factor = ascending ? 1 : -1;
      if (sort === "id") return left.model.id.localeCompare(right.model.id) * factor;
      if (sort === "kind")
        return (left.model.kind ?? "chat").localeCompare(right.model.kind ?? "chat") * factor;
      return ((left.model.contextWindow ?? 0) - (right.model.contextWindow ?? 0)) * factor;
    });
  }

  const modelIsOff = (model: GatewayModel): boolean => {
    const full = `${provider.id}/${model.id}`;
    return (config.disabledModels ?? []).some(
      (pattern) => modelDisabled(pattern, full) || modelDisabled(pattern, model.id),
    );
  };

  const setModelOff = (model: GatewayModel, off: boolean) => {
    const full = `${provider.id}/${model.id}`;
    edit((draft) => {
      const patterns = [...(draft.disabledModels ?? [])];
      if (off) {
        if (!patterns.includes(full) && !patterns.includes(model.id)) patterns.push(full);
      } else {
        const next = patterns.filter(
          (pattern) =>
            pattern !== full &&
            pattern !== model.id &&
            !modelDisabled(pattern, full) &&
            !modelDisabled(pattern, model.id),
        );
        if (next.length === 0) delete draft.disabledModels;
        else draft.disabledModels = next;
        return;
      }
      draft.disabledModels = patterns;
    });
  };

  const addModel = () => {
    const id = newModel.trim();
    if (!id) return;
    if (provider.models.some((model) => model.id === id)) {
      toastManager.add({ type: "error", title: t("gateway:model_exists") });
      return;
    }
    updateModels((models) => {
      models.push({ id });
    });
    setNewModel("");
  };

  const changeSort = (field: SortField) => {
    if (sort === field) {
      setAscending((value) => !value);
      return;
    }
    setSort(field);
    setAscending(true);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
          placeholder={t("gateway:models_filter")}
          size="sm"
          variant="soft"
          className="min-w-32 flex-1"
        />
        <Input
          value={newModel}
          onChange={(event) => setNewModel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addModel();
          }}
          placeholder={t("gateway:model_placeholder")}
          size="sm"
          variant="soft"
          className="min-w-32 flex-1"
        />
        <Button size="xs" variant="outline" onClick={addModel}>
          {t("gateway:add_model")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => changeSort("order")}
          aria-pressed={sort === "order"}
        >
          {t("gateway:models_order")}
        </Button>
      </div>

      {provider.models.length === 0 ? (
        <GatewayEmpty>{t("gateway:models_empty")}</GatewayEmpty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[color:var(--color-border)]">
          <table className="w-full min-w-[960px] border-collapse text-ui-sm">
            <thead>
              <tr className="bg-foreground/4 text-left text-ui-xs text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">
                  <button type="button" onClick={() => changeSort("id")}>
                    {t("gateway:model_id")}
                    {sort === "id" ? (ascending ? " ↑" : " ↓") : ""}
                  </button>
                </th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:label")}</th>
                <th className="px-2 py-1.5 font-medium">
                  <button type="button" onClick={() => changeSort("kind")}>
                    {t("gateway:model_kind")}
                    {sort === "kind" ? (ascending ? " ↑" : " ↓") : ""}
                  </button>
                </th>
                <th className="px-2 py-1.5 font-medium">
                  <button type="button" onClick={() => changeSort("context")}>
                    {t("gateway:context_window")}
                    {sort === "context" ? (ascending ? " ↑" : " ↓") : ""}
                  </button>
                </th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:max_output")}</th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:model_images")}</th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:model_picked")}</th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:model_released")}</th>
                <th className="px-2 py-1.5 font-medium">{t("gateway:enabled")}</th>
                <th className="px-2 py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ model, index }) => {
                const off = modelIsOff(model);
                const result = results[model.id];
                return (
                  <tr
                    key={model.id}
                    className="border-t border-[color:var(--color-border)] align-top"
                  >
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          className="text-ui-xs text-muted-foreground disabled:opacity-30"
                          disabled={index === 0}
                          aria-label={t("gateway:models_move_up", { model: model.id })}
                          onClick={() =>
                            updateModels((models) => {
                              const [entry] = models.splice(index, 1);
                              if (entry) models.splice(index - 1, 0, entry);
                            })
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="text-ui-xs text-muted-foreground disabled:opacity-30"
                          disabled={index === provider.models.length - 1}
                          aria-label={t("gateway:models_move_down", { model: model.id })}
                          onClick={() =>
                            updateModels((models) => {
                              const [entry] = models.splice(index, 1);
                              if (entry) models.splice(index + 1, 0, entry);
                            })
                          }
                        >
                          ↓
                        </button>
                      </div>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={model.id}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.id = value;
                          });
                        }}
                        className="w-40 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-ui-xs hover:border-[color:var(--color-border)] focus:border-foreground/30 focus:outline-none"
                      />
                      {result ? (
                        <div className="mt-0.5">
                          <GatewayPill tone={result.ok ? "ok" : "error"}>
                            {result.ok
                              ? t("gateway:test_ok", { ms: Math.round(result.latencyMs) })
                              : `${result.status} ${result.error ?? ""}`}
                          </GatewayPill>
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={model.label ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.label = value || undefined;
                          });
                        }}
                        className="w-28 rounded border border-transparent bg-transparent px-1 py-0.5 text-ui-xs hover:border-[color:var(--color-border)] focus:border-foreground/30 focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={model.kind ?? "chat"}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.kind =
                              value === "chat" ? undefined : (value as "image" | "video");
                          });
                        }}
                        className="h-6 rounded border border-[color:var(--color-border)] bg-background px-1 text-ui-xs"
                      >
                        <option value="chat">chat</option>
                        <option value="image">image</option>
                        <option value="video">video</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={model.contextWindow === undefined ? "" : String(model.contextWindow)}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.contextWindow = positiveInteger(value);
                          });
                        }}
                        inputMode="numeric"
                        className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-ui-xs hover:border-[color:var(--color-border)] focus:border-foreground/30 focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={
                          model.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens)
                        }
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.maxOutputTokens = positiveInteger(value);
                          });
                        }}
                        inputMode="numeric"
                        className="w-20 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-ui-xs hover:border-[color:var(--color-border)] focus:border-foreground/30 focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={imageChoice(model.images)}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.images = value === "unknown" ? undefined : value === "yes";
                          });
                        }}
                        className="h-6 rounded border border-[color:var(--color-border)] bg-background px-1 text-ui-xs"
                      >
                        <option value="unknown">{t("gateway:model_images_unknown")}</option>
                        <option value="yes">{t("gateway:model_images_yes")}</option>
                        <option value="no">{t("gateway:model_images_no")}</option>
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <GatewayToggle
                        checked={model.picked === true}
                        disabled={provider.modelMode !== "picked"}
                        label={t("gateway:model_picked")}
                        onChange={(checked) =>
                          updateModel(model.id, (draft) => {
                            draft.picked = checked ? true : undefined;
                          })
                        }
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={model.released ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          updateModel(model.id, (draft) => {
                            draft.released = value || undefined;
                          });
                        }}
                        placeholder="2026-01-01"
                        className="w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-ui-xs hover:border-[color:var(--color-border)] focus:border-foreground/30 focus:outline-none"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <GatewayToggle
                        checked={!off}
                        label={`${model.id} ${t("gateway:enabled")}`}
                        onChange={(checked) => setModelOff(model, !checked)}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={testing === model.id}
                          onClick={() =>
                            void runModelTest(provider, model.id, setTesting, setResults)
                          }
                        >
                          {t("gateway:test")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            edit((draft) => {
                              const target = (draft.providers ?? []).find(
                                (entry) => entry.id === provider.id,
                              );
                              const at = target?.models.findIndex((entry) => entry.id === model.id);
                              if (target && at !== undefined && at >= 0) {
                                target.models.splice(at, 1);
                              }
                              const key = `${provider.id}/${model.id}`;
                              if (draft.pricing?.[key] !== undefined) delete draft.pricing[key];
                              if (draft.modelSameAs?.[key] !== undefined) {
                                delete draft.modelSameAs[key];
                              }
                            })
                          }
                        >
                          {t("gateway:remove")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
