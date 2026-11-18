// FILE: pullRequestAutoMerge.logic.ts
// Purpose: Decide which auto-merge entries the pull request actions menu offers. The forge
//          reports whether it can enable or disable auto-merge; the menu only offers the one
//          it can run and never shows both at once.
// Layer: Pull request presentation logic

import type { PullRequestMergeMethod } from "@synara/contracts";

export interface PullRequestAutoMergeCapability {
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly mergeBlocker: string | null;
  readonly allowedMethods: ReadonlyArray<PullRequestMergeMethod>;
  readonly autoMergeEnabled: boolean;
  readonly canEnableAutoMerge: boolean;
  readonly canDisableAutoMerge: boolean;
}

export interface PullRequestAutoMergeActions {
  /** Methods offered to turn auto-merge on; empty when the menu should not offer enabling. */
  readonly enableMethods: ReadonlyArray<PullRequestMergeMethod>;
  /** Whether to offer turning the already-enabled auto-merge off. */
  readonly disable: boolean;
}

export const EMPTY_AUTO_MERGE_ACTIONS: PullRequestAutoMergeActions = {
  enableMethods: [],
  disable: false,
};

export function resolvePullRequestAutoMergeActions(
  input: PullRequestAutoMergeCapability,
): PullRequestAutoMergeActions {
  // A merged or closed pull request has no next merge, and a draft or a blocked pull request
  // cannot start one now.
  if (input.state !== "open" || input.isDraft || input.mergeBlocker !== null) {
    return EMPTY_AUTO_MERGE_ACTIONS;
  }
  if (input.canDisableAutoMerge && input.autoMergeEnabled) {
    return { enableMethods: [], disable: true };
  }
  if (!input.canEnableAutoMerge || input.autoMergeEnabled || input.allowedMethods.length === 0) {
    return EMPTY_AUTO_MERGE_ACTIONS;
  }
  return { enableMethods: input.allowedMethods, disable: false };
}
