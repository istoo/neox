// FILE: groupPanelSections.ts
// Purpose: The Group panel's secondary sections — ids, labels, and icons for
//          the rows under the Threads list, each of which opens its body in
//          place. Threads itself is always shown, so it is not listed here.
// Layer: Group panel shared descriptor (non-component module)

import { ClockIcon, GitPullRequestIcon, PageTextIcon, type LucideIcon } from "~/lib/icons";

export type GroupPanelSectionId = "pull-requests" | "automations" | "context";

export interface GroupPanelSectionDescriptor {
  readonly id: GroupPanelSectionId;
  readonly labelKey: string;
  readonly icon: LucideIcon;
}

export const GROUP_PANEL_SECTIONS: readonly GroupPanelSectionDescriptor[] = [
  { id: "pull-requests", labelKey: "chat:groupPanelPullRequests", icon: GitPullRequestIcon },
  { id: "automations", labelKey: "chat:groupPanelAutomations", icon: ClockIcon },
  { id: "context", labelKey: "chat:groupPanelContext", icon: PageTextIcon },
];
