import type { GatewayMaskingRecordWire } from "@neolix/protocol/gateway";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/** The masking records written for one client call, read with the request. */
export function gatewayCallMaskingQueryKey(serverId: string, gatewayCallId: string) {
  return ["gateway-call-masking", serverId, gatewayCallId] as const;
}

export function useGatewayCallMasking(
  serverId: string,
  gatewayCallId: string | null,
): {
  records: GatewayMaskingRecordWire[];
  more: boolean;
  isLoading: boolean;
  error: Error | null;
} {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery<{ records: GatewayMaskingRecordWire[]; more: boolean }>({
    queryKey: gatewayCallMaskingQueryKey(serverId, gatewayCallId ?? ""),
    enabled: Boolean(gatewayCallId && client && isConnected),
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client || gatewayCallId === null) {
        return { records: [], more: false };
      }
      const payload = await client.getGatewayMaskingRecords({ gatewayCallId, limit: 20 });
      return { records: payload.records, more: payload.more };
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    records: query.data?.records ?? [],
    more: query.data?.more ?? false,
    isLoading: query.isLoading,
    error: query.error,
  };
}
