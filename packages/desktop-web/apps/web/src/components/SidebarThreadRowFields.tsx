// FILE: SidebarThreadRowFields.tsx
// Purpose: The configured second-line fields for a thread row (branch, project, services),
//          shared by local rows and connected-host rows so both lay out identically.
// Layer: Sidebar UI primitive
// Exports: SidebarThreadRowFields

import { cloneElement, isValidElement, type ReactNode } from "react";
import type { SidebarRowItems } from "~/appSettings";

import { GitBranchIcon, GlobeIcon } from "~/lib/icons";
import { SidebarGlyph } from "./sidebarGlyphs";

export function SidebarThreadRowFields({
  branch,
  projectName,
  runningServiceCount,
  rowItems,
}: {
  branch: string | null | undefined;
  projectName: string | null | undefined;
  runningServiceCount: number | null | undefined;
  rowItems: SidebarRowItems;
}): ReactNode {
  const items: Array<{ key: string; node: ReactNode }> = [];
  if (rowItems.branch && branch) {
    items.push({
      key: "branch",
      node: (
        <span className="inline-flex min-w-0 items-center gap-1">
          <SidebarGlyph icon={GitBranchIcon} variant="meta" className="size-3 shrink-0" />
          <span className="truncate" title={branch}>
            {branch}
          </span>
        </span>
      ),
    });
  }
  if (rowItems.project && projectName) {
    items.push({
      key: "project",
      node: (
        <span className="truncate" title={projectName}>
          {projectName}
        </span>
      ),
    });
  }
  const serviceCount = runningServiceCount ?? 0;
  if (rowItems.services && serviceCount > 0) {
    items.push({
      key: "services",
      node: (
        <span className="inline-flex items-center gap-1">
          <SidebarGlyph icon={GlobeIcon} variant="meta" className="size-3 shrink-0" />
          {serviceCount}
        </span>
      ),
    });
  }
  if (items.length === 0) return null;
  const children: ReactNode[] = [];
  for (const [index, item] of items.entries()) {
    if (index > 0) {
      // Keyed by the field it precedes so hiding one field never re-keys the others.
      children.push(
        <span key={`sep-${item.key}`} aria-hidden className="text-muted-foreground/30">
          ·
        </span>,
      );
    }
    children.push(
      isValidElement(item.node) ? cloneElement(item.node, { key: item.key }) : item.node,
    );
  }
  return children;
}
