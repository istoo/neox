// FILE: gatewayHistoryGroups.logic.ts
// Purpose: Past gateway calls grouped by the conversation they belong to. Codex's
//          hidden title turns name no session of their own, so the daemon resolves
//          their parent and they sit under it.

import type { GatewayRouteHistoryRow } from "~/lib/gatewayTypes";

/** Codex's hidden turns that only name a conversation. */
export const TITLE_KINDS = new Set([
  "thread_title",
  "thread_title_reconsideration",
  "title_generation",
]);

export interface GatewayHistoryGroup {
  key: string;
  /** The conversation's own name, when it has one. */
  label: string | null;
  /** A title turn's conversation was inferred, not named by the client. */
  matched: boolean;
  routes: GatewayRouteHistoryRow[];
}

/** Rows by the conversation they belong to; title turns under their parent. */
export function groupGatewayHistory(
  routes: readonly GatewayRouteHistoryRow[],
): GatewayHistoryGroup[] {
  const groups = new Map<string, GatewayHistoryGroup>();
  for (const route of routes) {
    const parent = route.parentSession;
    const key = parent ?? route.session ?? route.id;
    const group = groups.get(key) ?? {
      key,
      label: parent ?? route.session ?? null,
      matched: false,
      routes: [],
    };
    group.matched = group.matched || route.parentMatched === true;
    group.routes.push(route);
    groups.set(key, group);
  }
  return [...groups.values()];
}
