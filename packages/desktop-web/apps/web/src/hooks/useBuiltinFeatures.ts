// FILE: useBuiltinFeatures.ts
// Purpose: One host's built-in feature switches, their in-use counts, and the
//          surfaces they hide. Reads the daemon config through the bridge's
//          existing `neolix.host.getConfig`; the gateway document supplies the
//          counts so a feature in use keeps its switch on.
// Layer: Web hook

import { NEOLIX_BUILTIN_FEATURE_IDS, type NeolixBuiltinFeatureId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  BUILTIN_FEATURE_SETTINGS_SECTIONS,
  builtinFeatureUseCounts,
  effectiveBuiltinFeatures,
  gatewayCallsPageOf,
  hiddenBuiltinSurfaces,
  type HiddenBuiltinSurfaces,
} from "~/components/settings/builtinFeatures.logic";
import { hostConfigQueryKey } from "~/components/settings/hostSettingsModel";
import { toastManager } from "~/components/ui/toast";
import { t } from "~/i18n";
import { GATEWAY_QUERY_KEY } from "~/lib/gatewayConfigSave";
import { getHostConfig, patchHostConfig } from "~/lib/neolixHostApi";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";

export interface BuiltinFeaturesController extends HiddenBuiltinSurfaces {
  /** The stored switches; a missing id is on. */
  readonly features: Readonly<Partial<Record<NeolixBuiltinFeatureId, boolean>>> | undefined;
  readonly useCounts: Readonly<Record<NeolixBuiltinFeatureId, number>>;
  readonly isLoading: boolean;
  isEnabled(id: NeolixBuiltinFeatureId): boolean;
  setEnabled(id: NeolixBuiltinFeatureId, enabled: boolean): Promise<void>;
  /** myna's gateway schema: how many recent calls the page shows before "Show more". */
  readonly gatewayCallsPage: number;
  setGatewayCallsPage(value: number): Promise<void>;
}

function reportSaveFailure(error: unknown): void {
  toastManager.add({
    type: "error",
    title: t("settings:couldNotSaveHostSettings"),
    description: error instanceof Error ? error.message : String(error),
  });
}

export function useBuiltinFeatures(): BuiltinFeaturesController {
  const queryClient = useQueryClient();
  const hostQuery = useQuery({
    queryKey: hostConfigQueryKey,
    queryFn: getHostConfig,
    staleTime: 5_000,
  });
  // The same cache Settings › Gateway writes, so a toggle here never reads a
  // document another panel has already replaced.
  const gatewayQuery = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: neolixGatewayApi.getConfig,
    staleTime: 30_000,
    retry: false,
  });

  const config = hostQuery.data?.config;
  const features = config?.builtinFeatures;
  const useCounts = useMemo(
    () => builtinFeatureUseCounts(gatewayQuery.data?.config),
    [gatewayQuery.data],
  );
  const effective = useMemo(
    () => effectiveBuiltinFeatures(features, useCounts),
    [features, useCounts],
  );
  const hidden = useMemo(() => hiddenBuiltinSurfaces(effective), [effective]);

  const isEnabled = useCallback((id: NeolixBuiltinFeatureId) => effective[id], [effective]);

  const setEnabled = useCallback(
    async (id: NeolixBuiltinFeatureId, enabled: boolean) => {
      // In use: myna refuses to turn it off, so the switch stays where it is.
      if (!enabled && useCounts[id] > 0) return;
      // Merge over the host's stored switches so one toggle never erases another.
      const next = { ...features, [id]: enabled };
      try {
        const saved = await patchHostConfig({ builtinFeatures: next });
        queryClient.setQueryData(hostConfigQueryKey, saved);
      } catch (error) {
        reportSaveFailure(error);
      }
    },
    [features, queryClient, useCounts],
  );

  const gatewayCallsPage = gatewayCallsPageOf(config);
  const setGatewayCallsPage = useCallback(
    async (value: number) => {
      // Beside the switches, merged the same way so one setting never erases another.
      const current = config?.builtinFeatureConfig;
      try {
        const saved = await patchHostConfig({
          builtinFeatureConfig: {
            ...current,
            gateway: { ...current?.gateway, callsPage: value },
          },
        });
        queryClient.setQueryData(hostConfigQueryKey, saved);
      } catch (error) {
        reportSaveFailure(error);
      }
    },
    [config?.builtinFeatureConfig, queryClient],
  );

  return {
    features,
    useCounts,
    isLoading: hostQuery.isLoading,
    isEnabled,
    setEnabled,
    gatewayCallsPage,
    setGatewayCallsPage,
    settingsSections: hidden.settingsSections,
    gatewayTabs: hidden.gatewayTabs,
    railUsage: hidden.railUsage,
  };
}

/** Every switch id, for the Plugins page to keep the same order myna uses. */
export { NEOLIX_BUILTIN_FEATURE_IDS };
export { BUILTIN_FEATURE_SETTINGS_SECTIONS };
