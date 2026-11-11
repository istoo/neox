import type { TFunction } from "i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";

export function resolveSidebarWorkspacePrimaryLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "currentBranch">;
  workspaceTitleSource: WorkspaceTitleSource;
}): string {
  if (input.workspaceTitleSource === "branch") {
    return input.workspace.currentBranch ?? input.workspace.name;
  }
  return input.workspace.name;
}

/**
 * The fact that separates this row from same-named siblings in its project. Built from the
 * same model fields the row draws, so the visible title and the accessible name agree.
 */
export function resolveSidebarWorkspaceDisambiguator(input: {
  workspace: Pick<
    SidebarWorkspaceEntry,
    "currentBranch" | "nameDisambiguator" | "branchDisambiguator"
  >;
  workspaceTitleSource: WorkspaceTitleSource;
}): string | null {
  if (input.workspaceTitleSource === "branch") {
    // A null branch falls back to the name, so the name's duplicate group applies to it.
    return (
      input.workspace.branchDisambiguator ??
      (input.workspace.currentBranch === null ? (input.workspace.nameDisambiguator ?? null) : null)
    );
  }
  return input.workspace.nameDisambiguator ?? null;
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "currentBranch" | "statusBucket">;
  workspaceTitleSource: WorkspaceTitleSource;
  leadingProjectName?: string | null;
  disambiguator?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  serviceLabel?: string | null;
  t: TFunction;
}): string {
  return [
    input.leadingProjectName,
    resolveSidebarWorkspacePrimaryLabel(input),
    input.disambiguator,
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.serviceLabel,
    input.workspace.statusBucket === "done"
      ? null
      : getStatusBucketLabel(input.workspace.statusBucket, input.t),
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
