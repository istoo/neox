import type { Href } from "expo-router";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export interface RedirectIfArchivingActiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
  /**
   * Descriptor captured before the optimistic archive removes it from the store.
   * Without it the redirect cannot seed the new workspace with the project.
   */
  archivedWorkspace?: WorkspaceDescriptor | null;
}

export interface RedirectIfArchivingActiveWorkspaceDeps {
  navigateToRoute: (route: Href) => void;
  readWorkspaces: (serverId: string) => Iterable<WorkspaceDescriptor>;
}

export function redirectIfArchivingActiveWorkspace(
  input: RedirectIfArchivingActiveWorkspaceInput,
  deps: RedirectIfArchivingActiveWorkspaceDeps,
): boolean {
  if (
    input.activeWorkspaceSelection?.serverId !== input.serverId ||
    input.activeWorkspaceSelection.workspaceId !== input.workspaceId
  ) {
    return false;
  }

  deps.navigateToRoute(
    buildWorkspaceArchiveRedirectRoute({
      serverId: input.serverId,
      archivedWorkspaceId: input.workspaceId,
      workspaces: input.archivedWorkspace
        ? [input.archivedWorkspace]
        : deps.readWorkspaces(input.serverId),
    }),
  );
  return true;
}
