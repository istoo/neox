// Neox workspace labels behind Synara thread rows. The daemon assigns labels to a workspace,
// while the fork's lists are thread-keyed, so every read joins them by the workspace directory.
import type {
  NeolixWorkspace,
  NeolixWorkspaceLabelColor,
  NeolixWorkspaceLabelDefinition,
} from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { readNativeApi } from "~/nativeApi";

export const neolixWorkspacesQueryKey = ["neolix", "workspaces"] as const;
export const neolixWorkspaceLabelsQueryKey = ["neolix", "workspace-labels"] as const;
export const neolixArchivedWorkspacesQueryKey = ["neolix", "archived-workspaces"] as const;

export function neolixWorkspacesQueryOptions() {
  return {
    queryKey: neolixWorkspacesQueryKey,
    queryFn: async () => {
      const neolix = readNativeApi()?.neolix;
      if (!neolix) throw new Error("Neox workspace API is unavailable.");
      return neolix.workspaces.list();
    },
    staleTime: 10_000,
  };
}

export function neolixWorkspaceLabelsQueryOptions() {
  return {
    queryKey: neolixWorkspaceLabelsQueryKey,
    queryFn: async () => {
      const neolix = readNativeApi()?.neolix;
      if (!neolix) throw new Error("Neox workspace API is unavailable.");
      return neolix.workspaces.labels();
    },
    staleTime: 60_000,
  };
}

/** Archived workspaces the host can still restore, derived from its archived agents. */
export function neolixArchivedWorkspacesQueryOptions() {
  return {
    queryKey: neolixArchivedWorkspacesQueryKey,
    queryFn: async () => {
      const neolix = readNativeApi()?.neolix;
      if (!neolix) throw new Error("Neox workspace API is unavailable.");
      return neolix.workspaces.listArchived();
    },
    staleTime: 10_000,
  };
}

const LABEL_COLOR_CLASS: Record<NeolixWorkspaceLabelColor, string> = {
  violet: "bg-violet-500",
  sky: "bg-sky-500",
  emerald: "bg-emerald-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
  indigo: "bg-indigo-500",
  teal: "bg-teal-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
  blue: "bg-blue-500",
};

export function workspaceLabelColorClass(color: NeolixWorkspaceLabelColor): string {
  return LABEL_COLOR_CLASS[color] ?? "bg-muted-foreground/40";
}

/** The daemon stores one canonical directory; tolerate a trailing separator from either side. */
function normalizeDirectory(value: string): string {
  return value.replace(/\/+$/, "");
}

export function findWorkspaceForDirectory(
  workspaces: readonly NeolixWorkspace[],
  directory: string | null | undefined,
): NeolixWorkspace | null {
  const wanted = directory?.trim();
  if (!wanted) return null;
  const normalized = normalizeDirectory(wanted);
  return (
    workspaces.find((workspace) => normalizeDirectory(workspace.directory) === normalized) ?? null
  );
}

export function resolveWorkspaceLabelsForDirectory(
  workspaces: readonly NeolixWorkspace[],
  definitions: readonly NeolixWorkspaceLabelDefinition[],
  directory: string | null | undefined,
): NeolixWorkspaceLabelDefinition[] {
  const workspace = findWorkspaceForDirectory(workspaces, directory);
  if (!workspace || workspace.labels.length === 0) return [];
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return workspace.labels.flatMap((name) => {
    const definition = byName.get(name);
    return definition ? [definition] : [];
  });
}

export function useSetWorkspaceLabel(input: {
  readonly threadId: string;
  readonly workspaceId?: string | null;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: {
      readonly label: NeolixWorkspaceLabelDefinition;
      readonly assigned: boolean;
    }) => {
      const neolix = readNativeApi()?.neolix;
      if (!neolix) throw new Error("Neox workspace API is unavailable.");
      return neolix.workspaces.setLabel({
        threadId: input.threadId,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        label: request.label,
        assigned: request.assigned,
      });
    },
    onSettled: async () => {
      // Assigning a name the catalog has not seen creates that definition on the daemon.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey }),
        queryClient.invalidateQueries({ queryKey: neolixWorkspaceLabelsQueryKey }),
      ]);
    },
  });
}
