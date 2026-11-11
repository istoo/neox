import type { GatewayConfigWire, GatewayStatusWire } from "@neolix/protocol/gateway";

export function gatewayConfigQueryKey(serverId: string | null) {
  return ["gateway-config", serverId] as const;
}

export interface GatewayConfigPushPayload {
  config: GatewayConfigWire;
  status: GatewayStatusWire;
}

/**
 * A config push carries only the config and status; the search vendors were
 * read once and are not part of the event. Merge the push into the cached
 * read instead of replacing it, so the page does not lose its vendors until
 * the next full fetch.
 */
export function mergeGatewayConfigPush<T>(
  previous: { searchVendors?: T | null } | undefined,
  payload: GatewayConfigPushPayload,
): { config: GatewayConfigWire; status: GatewayStatusWire; searchVendors: T | null } {
  return {
    config: payload.config,
    status: payload.status,
    searchVendors: previous?.searchVendors ?? null,
  };
}
