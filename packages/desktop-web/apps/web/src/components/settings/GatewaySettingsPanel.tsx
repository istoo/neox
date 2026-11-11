// FILE: GatewaySettingsPanel.tsx
// Purpose: Settings → Model gateway. One page with the eight sections the
//          Neox app's Models screen had: overview, sources, routing, keys,
//          usage, allowances, advanced and masking.
// Layer: Settings panel

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { GATEWAY_QUERY_KEY, saveGatewayConfig } from "~/lib/gatewayConfigSave";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import type { GatewayConfig, GatewayStatus } from "~/lib/gatewayTypes";
import { useTranslation } from "~/i18n";
import { toastManager } from "../ui/toast";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { GATEWAY_TABS, type GatewayTab } from "./gateway/gatewayHelpers";
import { GatewayAdvancedPane } from "./gateway/GatewayAdvancedPane";
import { GatewayAllowancesPane } from "./gateway/GatewayAllowancesPane";
import { GatewayKeysPane } from "./gateway/GatewayKeysPane";
import { GatewayMaskingPane } from "./gateway/GatewayMaskingPane";
import { GatewayOverviewPane } from "./gateway/GatewayOverviewPane";
import { GatewayProvidersPane } from "./gateway/GatewayProvidersPane";
import { GatewayRoutingPane } from "./gateway/GatewayRoutingPane";
import { GatewayUsagePane } from "./gateway/GatewayUsagePane";
import {
  describeGatewayDraftIssue,
  localizeGatewaySaveError,
  validateGatewayDraft,
} from "./gateway/gatewayDraftValidation";

/** An unsaved edit together with the snapshot it started from, so a save only applies it. */
type GatewayDraft = { readonly base: GatewayConfig; readonly value: GatewayConfig };

export function GatewaySettingsPanel({
  active,
  initialTab,
}: {
  readonly active: boolean;
  /** A cross-link such as Privacy → Masking lands on its own tab. */
  readonly initialTab?: GatewayTab | undefined;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<GatewayTab>(initialTab ?? "overview");
  useEffect(() => {
    if (initialTab !== undefined) setTab(initialTab);
  }, [initialTab]);
  const [draft, setDraft] = useState<GatewayDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: neolixGatewayApi.getConfig,
    enabled: active,
    staleTime: 5_000,
  });
  const config: GatewayConfig | undefined = draft?.value ?? query.data?.config;
  const status: GatewayStatus | null = query.data?.status ?? null;

  const edit = useCallback(
    (mutate: (next: GatewayConfig) => void) => {
      setDraft((previous) => {
        const base = previous?.base ?? query.data?.config;
        if (!base) return previous;
        const next = structuredClone(previous?.value ?? base);
        mutate(next);
        return { base, value: next };
      });
    },
    [query.data?.config],
  );

  const persist = useCallback(
    async (base: GatewayConfig, next: GatewayConfig) => {
      const issues = validateGatewayDraft(next);
      if (issues.length > 0) {
        const message = describeGatewayDraftIssue(issues[0]!, t);
        setSaveError(message);
        toastManager.add({ type: "error", title: t("gateway:save_failed"), description: message });
        return;
      }
      setSaving(true);
      setSaveError(null);
      // No `finally`: React Compiler cannot lower it and would skip the whole component.
      try {
        const saved = await saveGatewayConfig(base, next);
        queryClient.setQueryData(GATEWAY_QUERY_KEY, saved);
        setDraft(null);
        setSaving(false);
        toastManager.add({ type: "success", title: t("gateway:saved") });
      } catch (error) {
        setSaving(false);
        const message = localizeGatewaySaveError(error, next, t);
        setSaveError(message);
        toastManager.add({ type: "error", title: t("gateway:save_failed"), description: message });
      }
    },
    [queryClient, t],
  );

  const apply = useCallback(
    async (mutate: (next: GatewayConfig) => void) => {
      const base = draft?.base ?? query.data?.config;
      if (!base) return;
      const next = structuredClone(draft?.value ?? base);
      mutate(next);
      await persist(base, next);
    },
    [draft, persist, query.data?.config],
  );

  if (!active) return null;

  if (query.isLoading && config === undefined) {
    return <div className="px-1 py-8 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>;
  }

  if (query.error && config === undefined) {
    return (
      <Alert variant="error">
        <AlertTitle>{t("gateway:load_failed")}</AlertTitle>
        <AlertDescription>
          <span>{query.error instanceof Error ? query.error.message : String(query.error)}</span>
          <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
            {t("gateway:retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (config === undefined) {
    return (
      <div className="px-1 py-8 text-ui-sm text-muted-foreground">{t("gateway:no_config")}</div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <nav
        aria-label={t("gateway:title")}
        className="flex flex-wrap gap-1 border-b border-[color:var(--color-border)] pb-2"
      >
        {GATEWAY_TABS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            aria-current={tab === option ? "page" : undefined}
            className={`rounded-md border px-2.5 py-1 text-ui-sm ${
              tab === option
                ? "border-foreground/25 bg-foreground/8 text-foreground"
                : "border-transparent text-muted-foreground hover:border-[color:var(--color-border)] hover:text-foreground"
            }`}
          >
            {t(`gateway:tab_${option}`)}
          </button>
        ))}
      </nav>

      {saveError ? (
        <Alert variant="error">
          <AlertTitle>{t("gateway:save_failed")}</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      ) : null}

      {tab === "overview" ? (
        <GatewayOverviewPane
          config={config}
          status={status}
          searchVendors={query.data?.searchVendors ?? null}
          apply={apply}
          onSelectTab={setTab}
        />
      ) : tab === "providers" ? (
        <GatewayProvidersPane config={config} edit={edit} apply={apply} />
      ) : tab === "routing" ? (
        <GatewayRoutingPane config={config} edit={edit} apply={apply} />
      ) : tab === "keys" ? (
        <GatewayKeysPane config={config} edit={edit} />
      ) : tab === "usage" ? (
        <GatewayUsagePane config={config} apply={apply} />
      ) : tab === "allowances" ? (
        <GatewayAllowancesPane config={config} apply={apply} />
      ) : tab === "advanced" ? (
        <GatewayAdvancedPane
          config={config}
          searchVendors={query.data?.searchVendors ?? null}
          edit={edit}
          apply={apply}
        />
      ) : (
        <GatewayMaskingPane config={config} edit={edit} apply={apply} />
      )}

      {draft !== null ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2 shadow-sm">
          <span className="text-ui-sm text-muted-foreground">{t("gateway:unsaved")}</span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              {t("gateway:discard")}
            </Button>
            <Button
              size="sm"
              variant="default"
              disabled={saving}
              onClick={() => void persist(draft.base, draft.value)}
            >
              {saving ? t("gateway:saving") : t("gateway:save")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
