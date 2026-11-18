// FILE: SidebarStatusGroupList.tsx
// Purpose: Renders the "group by status" sidebar sections in bucket order, with the
//          same flat section shape the label grouping uses.
// Layer: Sidebar presentation
// Exports: SidebarStatusGroupList

import type { ReactNode } from "react";

import { SIDEBAR_SECTION_LABEL_CLASS_NAME } from "../sidebarRowStyles";
import { SidebarMenu, SidebarMenuItem, SidebarMenuSub } from "./ui/sidebar";

export interface SidebarStatusGroupRow<Thread> {
  readonly key: string;
  readonly label: string;
  readonly threads: readonly Thread[];
}

export function SidebarStatusGroupList<Thread>({
  groups,
  emptyLabel,
  renderThreadRow,
}: {
  groups: readonly SidebarStatusGroupRow<Thread>[];
  emptyLabel: ReactNode;
  renderThreadRow: (thread: Thread, orderedThreadIds: readonly Thread[]) => ReactNode;
}) {
  if (groups.length === 0) {
    return <p className="px-2 py-3 text-ui text-muted-foreground/58">{emptyLabel}</p>;
  }
  return (
    <SidebarMenu data-testid="workspace-status-group-list" className="gap-3">
      {groups.map((group) => (
        <SidebarMenuItem key={group.key} className="rounded-md">
          <div className="group/project-header relative my-1">
            <div className="flex h-7 w-full min-w-0 items-center px-2 py-0.5 pr-[4.75rem]">
              <span
                data-testid={`status-group-label-${group.key}`}
                className={SIDEBAR_SECTION_LABEL_CLASS_NAME}
              >
                {group.label}
              </span>
            </div>
          </div>
          <SidebarMenuSub className="mx-0 my-0 w-full translate-x-0 border-l-0 px-0 py-0">
            {group.threads.map((thread) => renderThreadRow(thread, group.threads))}
          </SidebarMenuSub>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
