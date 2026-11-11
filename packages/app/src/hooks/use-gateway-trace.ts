import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { GatewayRouteTraceWire } from "@neolix/protocol/gateway";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/** The Routing page is live: it reads the daemon's trace while it is on screen. */
export const GATEWAY_TRACE_POLL_MS = 1500;

export function gatewayTraceQueryKey(serverId: string) {
  return ["gateway-trace", serverId] as const;
}

export function useGatewayTrace(serverId: string): {
  trace: GatewayRouteTraceWire | null;
  isLoading: boolean;
  error: Error | null;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  // A host without the RPC would reject the message, so ask only when it says
  // it has it; the page shows its update prompt in the meantime.
  const supported = useHostFeature(serverId, "gatewayRoutingTrace");
  const queryKey = useMemo(() => gatewayTraceQueryKey(serverId), [serverId]);

  const query = useFetchQuery<GatewayRouteTraceWire>({
    queryKey,
    enabled: supported && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 0,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.getGatewayTrace();
      return payload.trace;
    },
    refetchInterval: GATEWAY_TRACE_POLL_MS,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return {
    trace: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
