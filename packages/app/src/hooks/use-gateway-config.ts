import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { GatewayConfigWire, GatewayStatusWire } from "@neolix/protocol/gateway";
import { gatewayConfigQueryKey } from "@/data/gateway-config";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export interface GatewaySearchVendor {
  vendor: string;
  name: string;
  keysURL?: string;
  keyOptional?: boolean;
  needURL?: boolean;
}

export interface GatewayConfigData {
  config: GatewayConfigWire;
  status: GatewayStatusWire;
  searchVendors: GatewaySearchVendor[] | null;
}

interface UseGatewayConfigResult {
  config: GatewayConfigWire | null;
  status: GatewayStatusWire | null;
  searchVendors: GatewaySearchVendor[] | null;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
  save: (config: GatewayConfigWire) => Promise<GatewayConfigWire | undefined>;
}

/**
 * Reads and writes `gateway.json` through the daemon. The route is separate
 * from the daemon config because the file holds provider keys and changes on
 * its own watcher.
 */
export function useGatewayConfig(serverId: string | null): UseGatewayConfigResult {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => gatewayConfigQueryKey(serverId), [serverId]);

  const configQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "gateway.config.changed",
    queryFn: async (): Promise<GatewayConfigData> => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getGatewayConfig();
      return {
        config: result.config,
        status: result.status,
        searchVendors: result.searchVendors ?? null,
      };
    },
  });

  const save = useCallback(
    async (config: GatewayConfigWire) => {
      if (!client) {
        return undefined;
      }
      const result = await client.setGatewayConfig(config);
      queryClient.setQueryData(queryKey, {
        config: result.config,
        status: result.status,
        searchVendors: result.searchVendors ?? null,
      });
      return result.config;
    },
    [client, queryClient, queryKey],
  );

  return {
    config: configQuery.data?.config ?? null,
    searchVendors: configQuery.data?.searchVendors ?? null,
    status: configQuery.data?.status ?? null,
    isLoading: configQuery.isLoading,
    error: configQuery.error,
    refresh: () => {
      void configQuery.refetch();
    },
    save,
  };
}
