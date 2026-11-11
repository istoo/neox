// FILE: archivedWorkspaces.ts
// Purpose: The archived-workspaces shelf: what the host can restore, plus this client's own
//          ledger of workspaces it archived, and the restore action.
// Layer: Workspace data hooks
// Used by: Sidebar (records archives), Settings › Archived (lists and restores them).

import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState } from "react";

import { useTranslation } from "~/i18n";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { executionKey } from "~/lib/hosts/executionContext";
import { newCommandId } from "~/lib/utils";
import {
  neolixArchivedWorkspacesQueryKey,
  neolixArchivedWorkspacesQueryOptions,
  neolixWorkspacesQueryKey,
} from "~/lib/workspaceLabels";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { toastManager } from "~/components/ui/toast";

export interface ArchivedWorkspaceEntry {
  readonly workspaceId: string;
  readonly name: string;
  readonly projectName: string;
  readonly directory: string;
  readonly archivedAt: string;
}

export interface ArchivedWorkspaceRow extends ArchivedWorkspaceEntry {
  /** Known only to this client's ledger (the host no longer lists it). */
  readonly localOnly: boolean;
}

const ArchivedWorkspaceEntries = Schema.Array(
  Schema.Struct({
    workspaceId: Schema.String,
    name: Schema.String,
    projectName: Schema.String,
    directory: Schema.String,
    archivedAt: Schema.String,
  }),
);

const normalizeDirectory = (value: string) => value.replace(/\/+$/, "");

/**
 * The client's ledger of workspaces it archived. The host enumerates archived workspaces through
 * their archived agents; the ledger keeps entries whose archived agents were deleted, and covers
 * an offline host. debt: only this device can restore a workspace archived here; a daemon list
 * RPC that survives agent deletion would replace the bookkeeping.
 */
export function useArchivedWorkspaceLedger() {
  return useLocalStorage(
    executionKey("archived-workspaces:v1"),
    [] as ReadonlyArray<ArchivedWorkspaceEntry>,
    ArchivedWorkspaceEntries,
  );
}

/**
 * Restores a workspace and unarchives the agents its archive took down.
 * Kept outside the hook so the React Compiler does not have to lower the
 * `try/finally` that clears the pending row.
 */
async function restoreArchivedWorkspaceRecord(input: {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  workspaceId: string;
  entry: ArchivedWorkspaceRow | undefined;
  invalidateQueries: () => Promise<unknown>;
  onRestored: () => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): Promise<void> {
  const { api, workspaceId, entry, invalidateQueries, onRestored, onError, onSettled } = input;
  try {
    if (!api.neolix) return;
    await api.neolix.workspaces.restore({ workspaceId });
    // Restoring the workspace record does not lift the archived flag from the agents the
    // archive took down. Unarchive the ones whose checkout matches, through the same
    // command the archived-threads panel uses.
    if (entry) {
      const directory = normalizeDirectory(entry.directory);
      const state = useStore.getState();
      const archivedThreadIds = (state.threadIds ?? []).filter((id) => {
        const shell = state.threadShellById?.[id];
        if (!shell?.archivedAt) return false;
        return normalizeDirectory(shell.workingDirectory ?? shell.worktreePath ?? "") === directory;
      });
      await Promise.all(
        archivedThreadIds.map((threadId) =>
          api.orchestration
            .dispatchCommand({
              type: "thread.unarchive",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined),
        ),
      );
    }
    await invalidateQueries();
    onRestored();
  } catch (error) {
    onError(error);
  } finally {
    onSettled();
  }
}

/** Archived workspaces to list, with the restore action and its pending row. */
export function useArchivedWorkspaces() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [entries, setEntries] = useArchivedWorkspaceLedger();
  const query = useQuery(neolixArchivedWorkspacesQueryOptions());
  const [restorePending, setRestorePending] = useState<string | null>(null);

  const rows = useMemo(() => {
    const result: ArchivedWorkspaceRow[] = [];
    const seen = new Set<string>();
    for (const workspace of query.data?.workspaces ?? []) {
      const directory = normalizeDirectory(workspace.directory);
      result.push({
        workspaceId: workspace.workspaceId,
        name: workspace.title?.trim() || directory.split("/").findLast(Boolean) || directory,
        projectName: workspace.projectName ?? "",
        directory,
        archivedAt: workspace.archivedAt,
        localOnly: false,
      });
      seen.add(workspace.workspaceId);
    }
    for (const entry of entries) {
      if (seen.has(entry.workspaceId)) continue;
      result.push({ ...entry, localOnly: true });
    }
    return result;
  }, [entries, query.data]);

  const restore = useCallback(
    async (workspaceId: string) => {
      const api = readNativeApi();
      if (!api?.neolix) return;
      setRestorePending(workspaceId);
      await restoreArchivedWorkspaceRecord({
        api,
        workspaceId,
        entry: rows.find((candidate) => candidate.workspaceId === workspaceId),
        invalidateQueries: async () => {
          await queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey });
          await queryClient.invalidateQueries({ queryKey: neolixArchivedWorkspacesQueryKey });
        },
        onRestored: () => {
          setEntries((current) =>
            current.filter((candidate) => candidate.workspaceId !== workspaceId),
          );
          toastManager.add({ type: "success", title: t("workspace:workspaceRestoreSuccess") });
        },
        onError: (error) => {
          toastManager.add({
            type: "error",
            title: t("workspace:workspaceRestoreFailed"),
            description: error instanceof Error ? error.message : String(error),
          });
        },
        onSettled: () => setRestorePending(null),
      });
    },
    [queryClient, rows, setEntries, t],
  );

  return { rows, restore, restorePending } as const;
}
