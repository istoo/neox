// Shared state helpers for the Neox host settings panels. The daemon config is a single
// document: every write returns the saved copy, which becomes the query cache so the panels
// never flicker back to a stale value while a refetch is in flight.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  getHostConfig,
  getHostStatus,
  patchHostConfig,
  type NeolixHostConfigPatch,
  type NeolixHostConfigWire,
} from "~/lib/neolixHostApi";
import { toastManager } from "~/components/ui/toast";
import type { GatewayConfig } from "~/lib/gatewayTypes";
import { GATEWAY_QUERY_KEY, saveGatewayConfig } from "~/lib/gatewayConfigSave";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import { localizeNetworkError } from "~/lib/errorLocalization";
import { t } from "~/i18n";
import { localizeGatewaySaveError } from "./gateway/gatewayDraftValidation";

export const hostConfigQueryKey = ["neolix-host-config"] as const;
export const hostStatusQueryKey = ["neolix-host-status"] as const;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useHostConfig(active: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: hostConfigQueryKey,
    queryFn: getHostConfig,
    enabled: active,
    staleTime: 5_000,
  });
  const mutation = useMutation({
    mutationFn: patchHostConfig,
    onSuccess: (saved) => {
      queryClient.setQueryData(hostConfigQueryKey, saved);
    },
  });

  const patch = useCallback(
    async (next: NeolixHostConfigPatch): Promise<boolean> => {
      try {
        const saved = await mutation.mutateAsync(next);
        queryClient.setQueryData(hostConfigQueryKey, saved);
        toastManager.add({ type: "success", title: t("settings:hostSettingsSaved") });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:couldNotSaveHostSettings"),
          description: localizeNetworkError(error),
        });
        return false;
      }
    },
    [mutation, queryClient],
  );

  return {
    config: query.data?.config,
    isLoading: query.isLoading,
    error: query.error ? messageOf(query.error) : null,
    saving: mutation.isPending,
    patch,
  };
}

export function useHostStatus(active: boolean) {
  return useQuery({
    queryKey: hostStatusQueryKey,
    queryFn: getHostStatus,
    enabled: active,
    staleTime: 10_000,
  });
}

export function useGatewayConfig(active: boolean) {
  const queryClient = useQueryClient();
  // Same cache as Settings › Gateway: both edit one daemon document, so a second cache
  // would hand one of them a stale snapshot to write back.
  const query = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: neolixGatewayApi.getConfig,
    enabled: active,
    staleTime: 5_000,
  });
  // The snapshot callers spread their edit onto; it changes together with `save`.
  const snapshot = query.data?.config;
  const save = useCallback(
    async (next: Record<string, unknown>): Promise<GatewayConfigWire | null> => {
      if (!snapshot) return null;
      try {
        const saved = await saveGatewayConfig(snapshot, next as GatewayConfig);
        queryClient.setQueryData(GATEWAY_QUERY_KEY, saved);
        toastManager.add({ type: "success", title: t("settings:gatewaySettingsSaved") });
        return saved.config as GatewayConfigWire;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:couldNotSaveGatewaySettings"),
          description: localizeGatewaySaveError(error, next as GatewayConfig),
        });
        return null;
      }
    },
    [queryClient, snapshot],
  );

  return {
    config: snapshot as GatewayConfigWire | undefined,
    isLoading: query.isLoading,
    error: query.error ? messageOf(query.error) : null,
    save,
  };
}

/** The gateway fields the host settings read; everything else passes through untouched. */
export interface GatewayConfigWire {
  readonly accountDiscovery?: boolean;
  readonly codexAccountDiscovery?: boolean;
  readonly codexSignInLinkOnly?: boolean;
  readonly otel?: {
    readonly enabled?: boolean;
    readonly endpoint?: string;
    readonly metrics?: boolean;
    readonly bodies?: boolean;
    readonly bodiesWhole?: boolean;
    readonly sessions?: boolean;
  };
  readonly [key: string]: unknown;
}

export type {
  NeolixBackupAuto as BackupAutoWire,
  NeolixBackupEntry as BackupEntryWire,
  NeolixSyncConfig as SyncConfigWire,
  NeolixSyncStatus as SyncStatusWire,
} from "@synara/contracts";

export function asConfig<T>(value: unknown): T | null {
  return value !== null && typeof value === "object" ? (value as T) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatWhen(iso: string | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export type { NeolixHostConfigWire };
