// FILE: sidebarNavOrdering.ts
// Purpose: Names the primary navigation destinations and resolves the shared Kanban/Tasks slot.
// Layer: Web settings utility
// Exports: nav item ids and the Kanban/Tasks slot resolver.

import { normalizeIdOrder } from "./lib/orderedIds";

/** The rail drops Inbox only where INBOX_ON is off. */
export const SIDEBAR_NAV_ITEM_IDS = [
  "newThread",
  "inbox",
  "kanban",
  "tasks",
  "pullRequests",
  "automations",
] as const;

export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number];

/** Footer controls the settings page can order. Settings and the account control stay fixed. */
export const SIDEBAR_FOOTER_ITEM_IDS = ["usage", "help"] as const;
export type SidebarFooterItemId = (typeof SIDEBAR_FOOTER_ITEM_IDS)[number];

const SIDEBAR_FOOTER_ITEM_ID_SET: ReadonlySet<string> = new Set(SIDEBAR_FOOTER_ITEM_IDS);

function isSidebarFooterItemId(value: string): value is SidebarFooterItemId {
  return SIDEBAR_FOOTER_ITEM_ID_SET.has(value);
}

/** The saved footer order, completed with any item the saved list predates. */
export function normalizeSidebarFooterOrder(order: ReadonlyArray<string>): SidebarFooterItemId[] {
  return normalizeIdOrder(order, SIDEBAR_FOOTER_ITEM_IDS, isSidebarFooterItemId);
}

/**
 * Kanban and Tasks share one slot in the nav and rail (see tasksSurface.ts for which one
 * shows). Both ids stay valid in persisted settings so neither app loses its layout: the enabled surface takes the position
 * of whichever of the two comes first in the stored order, and the other is left out.
 */
export function resolveTasksSurfaceSlot<Id extends string>(
  order: readonly Id[],
  tasksEnabled: boolean,
): Id[] {
  const active = (tasksEnabled ? "tasks" : "kanban") as Id;
  let placed = false;
  const resolved: Id[] = [];
  for (const id of order) {
    if (id !== "kanban" && id !== "tasks") {
      resolved.push(id);
    } else if (!placed) {
      resolved.push(active);
      placed = true;
    }
  }
  return resolved;
}
