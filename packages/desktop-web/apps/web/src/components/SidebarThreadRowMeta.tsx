// FILE: SidebarThreadRowMeta.tsx
// Purpose: Shared trailing meta chips for thread rows, including the pull-request chip
//          used by both the local tree and connected-host rows.
// Layer: Sidebar UI primitive
// Exports: ThreadMetaChip type, resolveThreadRowPrChip

import type { ReactNode } from "react";

import type { ThreadPullRequest } from "~/hooks/useThreadPullRequests";
import {
  PR_STATE_LABEL_KEYS,
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequest/pullRequestStatePresentation";
import { SidebarGlyph } from "./sidebarGlyphs";
import { t } from "~/i18n";

export type ThreadMetaChip = {
  id: "automation" | "handoff" | "fork" | "worktree" | "pr" | "checks" | "services";
  tooltip: string;
  icon: ReactNode;
};

// The thread's PR state, as a plain meta chip that closes the row (the hover card's PR
// row is the clickable way to open it).
export function resolveThreadRowPrChip(pr: NonNullable<ThreadPullRequest>): ThreadMetaChip {
  const presentation = resolvePrStatePresentation(pr);
  return {
    id: "pr",
    tooltip: t("workspace:symbol4", {
      value0: pr.number,
      value1: t(PR_STATE_LABEL_KEYS[presentation.label]),
      value2: pr.title,
    }),
    icon: (
      <SidebarGlyph
        icon={PR_STATE_PRESENTATION_ICONS[presentation.iconKind]}
        variant="meta"
        className={presentation.colorClass}
      />
    ),
  };
}
