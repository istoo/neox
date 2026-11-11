// FILE: GitPanel.tsx
// Purpose: Source-control changes pane for the right dock (working-tree files + per-file diff).
// Layer: Chat right-dock UI
// Depends on: gitReactQuery (diff query + discard mutation), diffRendering (patch parsing),
//             @pierre/diffs FileDiff for the per-file viewer.
//
// The pane derives its cwd like DockTerminalPane (thread worktree or project cwd) and reads the
// working-tree patch. Neox has no separate index projection, so there is no staged list and no
// stage/unstage action; those Synara RPCs stay unsupported and their UI is not offered.

import { type FileDiffMetadata } from "@pierre/diffs/react";
import { type ProjectId, type ThreadId } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getRenderablePatch,
  resolveFileDiffIndexPaths,
  resolveFileDiffPath,
  sortFileDiffsByPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import {
  gitDiscardChangesMutationOptions,
  gitQueryKeys,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { RefreshCwIcon, Trash2 } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createProjectSelector, createThreadWorkspaceMetadataSelector } from "~/storeSelectors";
import { Alert } from "../ui/alert";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiffTruncationWarning } from "../DiffTruncationWarning";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "./chatHeaderControls";
import { DiffStat } from "./DiffStatLabel";
import { FileDiffCard, FileDiffSurface } from "./FileDiffView";
import { FileEntryIcon } from "./FileEntryIcon";
import { PanelStateMessage } from "./PanelStateMessage";
import { useTranslation } from "~/i18n";

function parsePatchToSortedFiles(
  patch: string | undefined,
  cacheScope: string,
): FileDiffMetadata[] {
  const renderable = getRenderablePatch(patch, cacheScope);
  return renderable?.kind === "files" ? sortFileDiffsByPath(renderable.files) : [];
}

function GitFileRow(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  isSelected: boolean;
  actionLabel: string;
  actionDisabled: boolean;
  onSelect: (file: FileDiffMetadata) => void;
  onAction: (files: FileDiffMetadata[]) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = summarizeFileDiffStats([props.fileDiff]);
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left",
        props.isSelected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onClick={() => props.onSelect(props.fileDiff)}
        title={filePath}
      >
        <FileEntryIcon pathValue={filePath} kind="file" theme={props.theme} className="size-4" />
        <span className="min-w-0 truncate text-ui text-foreground">
          {dir ? <span className="text-muted-foreground/70">{dir}</span> : null}
          <span>{name}</span>
        </span>
      </button>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-ui-sm"
      />
      <IconButton
        size="icon-xs"
        variant="ghost"
        className="shrink-0 opacity-0 group-hover:opacity-100 data-[disabled]:opacity-40"
        label={props.actionLabel}
        tooltip={props.actionLabel}
        disabled={props.actionDisabled}
        onClick={() => props.onAction([props.fileDiff])}
      >
        <Trash2 className="size-3.5" />
      </IconButton>
    </div>
  );
}

function GitFileSection(props: {
  title: string;
  emptyLabel: string;
  files: FileDiffMetadata[];
  theme: "light" | "dark";
  selectedPath: string | null;
  actionLabel: string;
  actionDisabled: boolean;
  onSelect: (file: FileDiffMetadata) => void;
  onAction: (files: FileDiffMetadata[]) => void;
}) {
  const stat = summarizeFileDiffStats(props.files);
  return (
    <section className="min-w-0">
      <header className="flex items-center gap-2 px-1.5 py-1">
        <span className="text-ui-sm font-semibold text-muted-foreground">{props.title}</span>
        <span className="rounded-full bg-muted px-1.5 text-ui-xs font-medium text-muted-foreground">
          {props.files.length}
        </span>
        <DiffStat additions={stat.additions} deletions={stat.deletions} className="text-ui-xs" />
      </header>
      {props.files.length === 0 ? (
        <p className="px-1.5 py-1 text-ui-sm text-muted-foreground/70">{props.emptyLabel}</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {props.files.map((file) => {
            const key = buildFileDiffRenderKey(file);
            const filePath = resolveFileDiffPath(file);
            return (
              <GitFileRow
                key={key}
                fileDiff={file}
                theme={props.theme}
                isSelected={props.selectedPath === filePath}
                actionLabel={props.actionLabel}
                actionDisabled={props.actionDisabled}
                onSelect={props.onSelect}
                onAction={props.onAction}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function SelectedFileDiff(props: { fileDiff: FileDiffMetadata; theme: "light" | "dark" }) {
  return (
    <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 py-2">
      <div className="diff-render-file rounded-md">
        <FileDiffCard fileDiff={props.fileDiff} theme={props.theme} />
      </div>
    </FileDiffSurface>
  );
}

export function GitPanel(props: { hostThreadId: ThreadId; projectId: ProjectId | null }) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme as "light" | "dark";
  // Shell-only, like DockTerminalPane: only `worktreePath` is read here, and the
  // full thread selector would re-render the pane on every streamed token.
  const threadWorkspace = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.hostThreadId), [props.hostThreadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const cwd = threadWorkspace.worktreePath ?? project?.cwd ?? null;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [discardPaths, setDiscardPaths] = useState<string[] | null>(null);

  // No fixed polling: turn-driven file changes already push-invalidate the
  // working-tree-diff cache (see __root.tsx), and focus + the Refresh button +
  // post-mutation invalidation cover the rest. This keeps the pane cheap.
  const changesQuery = useQuery(gitWorkingTreeDiffQueryOptions({ cwd, scope: "unstaged" }));

  const patch = changesQuery.data?.patch;
  const files = useMemo(
    () => parsePatchToSortedFiles(patch, `git-pane:changes:${theme}`),
    [patch, theme],
  );

  const discardMutation = useMutation(gitDiscardChangesMutationOptions({ cwd, queryClient }));

  const requestDiscard = (file: FileDiffMetadata) => {
    // A rename also deletes its old path; discard both sides.
    const paths = resolveFileDiffIndexPaths(file).filter((path) => path.length > 0);
    if (paths.length === 0) return;
    setDiscardPaths(paths);
  };

  const confirmDiscard = () => {
    if (!discardPaths || discardPaths.length === 0) return;
    const paths = discardPaths;
    setDiscardPaths(null);
    discardMutation.mutate(paths);
  };

  const refresh = () => {
    if (!cwd) return;
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiff(cwd, "unstaged"),
    });
  };

  const selectedFileDiff = selectedPath
    ? (files.find((file) => resolveFileDiffPath(file) === selectedPath) ?? null)
    : null;

  const isLoading = changesQuery.isLoading;
  const truncated = changesQuery.data?.truncated === true;
  const error = changesQuery.error instanceof Error ? changesQuery.error.message : null;
  const hasChanges = files.length > 0;

  if (!cwd) {
    return <PanelStateMessage>{t("git:gitPanel_unavailableForThread")}</PanelStateMessage>;
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* The dock tab already names this pane and closes it; repeating the title and a
          second close here doubled both. Only the pane-specific action stays. */}
      <div className="flex h-9 shrink-0 items-center justify-end gap-0.5 border-b border-border/70 px-1.5">
        <IconButton
          size="icon-xs"
          variant="ghost"
          label={t("git:gitPanel_refreshLabel")}
          tooltip={t("git:gitPanel_refreshLabel")}
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          onClick={refresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </IconButton>
      </div>

      {truncated || error || isLoading || hasChanges ? (
        <div className="flex max-h-[48%] min-h-0 shrink-0 flex-col gap-2 overflow-auto px-1.5 py-2">
          {truncated ? (
            <DiffTruncationWarning>
              {t("git:synaraStoppedReadingSourceControlChangesAtTheDiff")}
            </DiffTruncationWarning>
          ) : null}
          {error ? (
            <Alert variant="error" size="sm" className="text-destructive">
              {error}
            </Alert>
          ) : null}
          {!error && isLoading && !hasChanges ? (
            <p className="px-1.5 py-1 text-ui-sm text-muted-foreground/70">
              {t("git:gitPanel_loading")}
            </p>
          ) : null}
          {hasChanges ? (
            <GitFileSection
              title={t("git:panel_changes")}
              emptyLabel={t("git:gitPanel_noChanges")}
              files={files}
              theme={theme}
              selectedPath={selectedPath}
              actionLabel={t("git:discardChanges")}
              actionDisabled={discardMutation.isPending}
              onSelect={(file) => setSelectedPath(resolveFileDiffPath(file))}
              onAction={(actionFiles) => actionFiles.forEach(requestDiscard)}
            />
          ) : null}
        </div>
      ) : null}

      <div
        className={cn(
          "diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden",
          (truncated || error || isLoading || hasChanges) && "border-t border-border/70",
        )}
      >
        {selectedFileDiff ? (
          <SelectedFileDiff
            key={`${buildFileDiffRenderKey(selectedFileDiff)}:${theme}`}
            fileDiff={selectedFileDiff}
            theme={theme}
          />
        ) : hasChanges ? (
          <PanelStateMessage density="compact">
            {t("git:gitPanel_selectFileDiff")}
          </PanelStateMessage>
        ) : !error && !isLoading ? (
          // A clean tree has nothing to select, so say that once instead of also
          // asking the user to pick a file.
          <PanelStateMessage density="compact">{t("git:gitPanel_noChanges")}</PanelStateMessage>
        ) : null}
      </div>

      <Dialog
        open={discardPaths !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardPaths(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("git:discardChangesConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("git:discardChangesConfirmMessage", { value0: discardPaths?.[0] ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" type="button" onClick={() => setDiscardPaths(null)}>
              {t("common:form_cancel")}
            </Button>
            <Button variant="destructive" size="sm" type="button" onClick={confirmDiscard}>
              {t("git:discardChangesConfirmLabel")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

export default GitPanel;
