// FILE: GatewayPresetDialog.tsx
// Purpose: The add-source flow: pick one of the protocol's vendor presets, then
//          fill the credential (and Vertex fields) the vendor needs.
// Layer: Settings UI dialog

import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "~/i18n";
import type {
  GatewayConfig,
  GatewayProtocol,
  GatewayProvider,
  GatewayProviderPreset,
} from "~/lib/gatewayTypes";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import {
  presetHost,
  presetMatches,
  presetProtocol,
  presetProtocols,
  uniqueProviderId,
} from "./gatewayHelpers";

const SECTIONS = ["vendor", "relay", "local"] as const;

const PROTOCOL_LABELS: Record<GatewayProtocol, string> = {
  openai: "OpenAI",
  "openai-responses": "Responses",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface GatewayPresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  presets: readonly GatewayProviderPreset[];
  loading: boolean;
  error: string | null;
  config: GatewayConfig;
  onCreate: (provider: GatewayProvider) => void;
  onImport: () => void;
}

export function GatewayPresetDialog({
  open,
  onOpenChange,
  presets,
  loading,
  error,
  config,
  onCreate,
  onImport,
}: GatewayPresetDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<GatewayProviderPreset | null>(null);
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<GatewayProtocol>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [regionId, setRegionId] = useState("");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [vertexCredentials, setVertexCredentials] = useState("");
  const [touched, setTouched] = useState(false);

  const reset = () => {
    setQuery("");
    setPicked(null);
    setTouched(false);
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/u).filter(Boolean), [query]);
  const visible = useMemo(
    () => presets.filter((preset) => presetMatches(preset, words)),
    [presets, words],
  );

  const pick = (preset: GatewayProviderPreset) => {
    const nextProtocol = presetProtocol(preset);
    setPicked(preset);
    setTouched(false);
    setId(uniqueProviderId(preset.id, config.providers ?? []));
    setLabel(preset.name);
    setProtocol(nextProtocol);
    setBaseUrl(preset.endpoints[nextProtocol] ?? preset.decide ?? "");
    setApiKey("");
    setModelsText((preset.models ?? []).join(", "));
    setRegionId("");
    setVertexProject("");
    setVertexLocation("");
    setVertexCredentials("");
  };

  const chooseRegion = (nextId: string) => {
    setRegionId(nextId);
    const region = picked?.regions?.find((entry) => entry.id === nextId);
    if (!region) return;
    setBaseUrl(region.endpoints[protocol] ?? region.decide ?? baseUrl);
  };

  const chooseProtocol = (next: GatewayProtocol) => {
    if (!picked) return;
    const previousUrl = picked.endpoints[protocol];
    const nextUrl = picked.endpoints[next];
    const region = picked.regions?.find((entry) => entry.id === regionId);
    const regionNext = region?.endpoints[next];
    const followsPreset =
      baseUrl.trim() === "" || baseUrl === previousUrl || baseUrl === region?.endpoints[protocol];
    setProtocol(next);
    if (regionNext !== undefined) setBaseUrl(regionNext);
    else if (followsPreset && nextUrl !== undefined) setBaseUrl(nextUrl);
  };

  const idError = !/^[a-z][a-z0-9-]*$/u.test(id)
    ? t("gateway:preset_id_invalid")
    : (config.providers ?? []).some((provider) => provider.id === id)
      ? t("gateway:id_taken")
      : null;
  const baseUrlError =
    !picked?.decide || Object.keys(picked.endpoints).length > 0
      ? baseUrl.trim() === ""
        ? t("gateway:preset_base_missing")
        : !httpUrl(baseUrl.trim())
          ? t("gateway:preset_base_invalid")
          : null
      : null;
  const vertexError =
    picked?.vertex === true && vertexProject.trim() === ""
      ? t("gateway:preset_project_missing")
      : null;
  const canCreate = idError === null && baseUrlError === null && vertexError === null;

  const create = () => {
    if (!picked || !canCreate) {
      setTouched(true);
      return;
    }
    const models = modelsText
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((modelId) => ({ id: modelId }));
    const provider: GatewayProvider = {
      id,
      label: label.trim() || picked.name,
      protocol,
      baseUrl: baseUrl.trim() || picked.decide || "",
      models,
      enabled: true,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(picked.decide ? { decide: picked.decide } : {}),
      ...(picked.decide && Object.keys(picked.endpoints).length === 0
        ? { modelMode: "none" as const }
        : {}),
      ...(picked.vertex === true
        ? {
            vertex: {
              project: vertexProject.trim(),
              ...(vertexLocation.trim() ? { location: vertexLocation.trim() } : {}),
              ...(vertexCredentials.trim() ? { credentials: vertexCredentials.trim() } : {}),
            },
          }
        : {}),
    };
    onCreate(provider);
    onOpenChange(false);
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {picked
              ? t("gateway:preset_add_title", { name: picked.name })
              : t("gateway:add_source")}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="max-h-[70vh] overflow-y-auto">
          {picked ? (
            <div className="space-y-3">
              <button
                type="button"
                className="text-ui-sm text-muted-foreground hover:text-foreground"
                onClick={() => setPicked(null)}
              >
                ← {t("gateway:preset_back")}
              </button>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:preset_id")}</span>
                  <Input
                    value={id}
                    onChange={(event) => setId(event.currentTarget.value)}
                    size="sm"
                    variant="soft"
                    aria-invalid={touched && idError !== null}
                  />
                  {touched && idError ? (
                    <span className="text-ui-xs text-destructive">{idError}</span>
                  ) : null}
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:label")}</span>
                  <Input
                    value={label}
                    onChange={(event) => setLabel(event.currentTarget.value)}
                    size="sm"
                    variant="soft"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:protocol")}</span>
                  <select
                    value={protocol}
                    onChange={(event) =>
                      chooseProtocol(event.currentTarget.value as GatewayProtocol)
                    }
                    className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                  >
                    {presetProtocols(picked).map((option) => (
                      <option key={option} value={option}>
                        {PROTOCOL_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </label>
                {(picked.regions ?? []).length > 0 ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-ui-sm text-muted-foreground">
                      {picked.regionLabel ?? t("gateway:preset_region")}
                    </span>
                    <select
                      value={regionId}
                      onChange={(event) => chooseRegion(event.currentTarget.value)}
                      className="h-7 rounded-md border border-[color:var(--color-border)] bg-background px-2 text-ui-sm"
                    >
                      <option value="">{t("gateway:preset_region_default")}</option>
                      {(picked.regions ?? []).map((region) => (
                        <option key={region.id} value={region.id}>
                          {region.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:base_url")}</span>
                  <Input
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    placeholder="https://api.example.com/v1"
                    size="sm"
                    variant="soft"
                    aria-invalid={touched && baseUrlError !== null}
                  />
                  {touched && baseUrlError ? (
                    <span className="text-ui-xs text-destructive">{baseUrlError}</span>
                  ) : null}
                </label>
                {picked.vertex === true ? (
                  <>
                    <label className="flex flex-col gap-1">
                      <span className="text-ui-sm text-muted-foreground">
                        {t("gateway:preset_project")}
                      </span>
                      <Input
                        value={vertexProject}
                        onChange={(event) => setVertexProject(event.currentTarget.value)}
                        size="sm"
                        variant="soft"
                        aria-invalid={touched && vertexError !== null}
                      />
                      {touched && vertexError ? (
                        <span className="text-ui-xs text-destructive">{vertexError}</span>
                      ) : null}
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-ui-sm text-muted-foreground">
                        {t("gateway:preset_location")}
                      </span>
                      <Input
                        value={vertexLocation}
                        onChange={(event) => setVertexLocation(event.currentTarget.value)}
                        placeholder="us-central1"
                        size="sm"
                        variant="soft"
                      />
                    </label>
                    <label className="flex flex-col gap-1 sm:col-span-2">
                      <span className="text-ui-sm text-muted-foreground">
                        {t("gateway:preset_credentials")}
                      </span>
                      <Input
                        value={vertexCredentials}
                        onChange={(event) => setVertexCredentials(event.currentTarget.value)}
                        placeholder={t("gateway:preset_credentials_hint")}
                        size="sm"
                        variant="soft"
                      />
                    </label>
                  </>
                ) : (
                  <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-ui-sm text-muted-foreground">{t("gateway:api_key")}</span>
                    <Input
                      value={apiKey}
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      type="password"
                      size="sm"
                      variant="soft"
                    />
                    {picked.keysUrl ? (
                      <a
                        href={picked.keysUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-ui-xs text-muted-foreground underline hover:text-foreground"
                      >
                        {t("gateway:preset_get_key")}
                      </a>
                    ) : null}
                  </label>
                )}
                <label className="flex flex-col gap-1 sm:col-span-2">
                  <span className="text-ui-sm text-muted-foreground">{t("gateway:models")}</span>
                  <textarea
                    value={modelsText}
                    onChange={(event) => setModelsText(event.currentTarget.value)}
                    rows={3}
                    placeholder="model-a, model-b"
                    className="w-full resize-y rounded-lg border border-[color:var(--color-border)] bg-transparent px-2.5 py-2 font-mono text-ui-sm outline-none focus-visible:border-foreground/30"
                  />
                  <span className="text-ui-xs text-muted-foreground">
                    {t("gateway:preset_models_hint")}
                  </span>
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <Input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("gateway:preset_search")}
                size="sm"
                variant="soft"
              />
              {loading ? (
                <div className="py-6 text-center text-ui-sm text-muted-foreground">
                  {t("gateway:loading")}
                </div>
              ) : error ? (
                <div className="py-6 text-center text-ui-sm text-destructive">{error}</div>
              ) : visible.length === 0 ? (
                <div className="py-6 text-center text-ui-sm text-muted-foreground">
                  {t("gateway:preset_none", { query })}
                </div>
              ) : (
                SECTIONS.map((section) => {
                  const entries = visible.filter((preset) => preset.kind === section);
                  if (entries.length === 0) return null;
                  return (
                    <section key={section}>
                      <div className="mb-1 flex items-baseline gap-2 px-1">
                        <h3 className="text-ui-sm font-medium text-foreground">
                          {t(`gateway:preset_section_${section}`)}
                        </h3>
                        <span className="text-ui-xs text-muted-foreground">
                          {t(`gateway:preset_section_${section}_hint`)}
                        </span>
                      </div>
                      <div className="overflow-hidden rounded-lg border border-[color:var(--color-border)]">
                        {entries.map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => pick(preset)}
                            className="flex w-full items-center justify-between gap-2 border-b border-[color:var(--color-border)] px-3 py-2 text-left last:border-b-0 hover:bg-foreground/4"
                          >
                            <span className="min-w-0">
                              <span className="flex items-center gap-2">
                                <span className="truncate text-ui-sm font-medium">
                                  {preset.name}
                                </span>
                                {preset.note ? (
                                  <span className="truncate text-ui-xs text-muted-foreground">
                                    {preset.note}
                                  </span>
                                ) : null}
                              </span>
                              <span className="block truncate text-ui-xs text-muted-foreground">
                                {presetHost(preset)}
                              </span>
                            </span>
                            <span className="shrink-0 text-ui-xs text-muted-foreground">›</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })
              )}
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const provider: GatewayProvider = {
                      id: uniqueProviderId("source", config.providers ?? []),
                      label: "",
                      protocol: "openai",
                      baseUrl: "",
                      models: [],
                      enabled: true,
                    };
                    onCreate(provider);
                    onOpenChange(false);
                    reset();
                  }}
                >
                  {t("gateway:preset_custom")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onOpenChange(false);
                    reset();
                    onImport();
                  }}
                >
                  {t("gateway:import")}
                </Button>
              </div>
            </div>
          )}
        </DialogPanel>
        {picked ? (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t("gateway:cancel")}
            </Button>
            <Button size="sm" onClick={create}>
              {t("gateway:preset_create")}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
