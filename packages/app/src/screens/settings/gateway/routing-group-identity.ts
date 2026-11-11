import type { GatewayConfigWire } from "@neolix/protocol/gateway";

/**
 * Renames a group inside `groupOrder` too. The daemon ranks groups by that
 * list, so an id edited without it would lose its place.
 */
export function syncGroupOrder(config: GatewayConfigWire, from: string, to: string): void {
  config.groupOrder = (config.groupOrder ?? []).map((id) => (id === from ? to : id));
}
