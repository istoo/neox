// FILE: workspaceExplorer.tsx
// Purpose: Shared workspace file-tree explorer + file-search building blocks used
//          by both the full editor view and the right-dock explorer pane.
// Layer: Chat workspace-browsing UI primitives
// Exports: WorkspaceFilesSidebar, WorkspaceSearchSidebar, WorkspaceExplorerSidebar,
//          useExplorerEntryPrefetch, setFileReferenceDragData, ExplorerActivityBarButton.

import type { ProjectEntry, ProjectFileSystemEntry } from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentPropsWithoutRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  forwardRef,
  useState,
} from "react";

import { ensureNativeApi } from "~/nativeApi";

import {
  CHAT_FILE_REFERENCE_DRAG_TYPE,
  formatChatFileReference,
  type ChatFileReference,
} from "~/lib/chatReferences";
import { splitRepoRelativePath } from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import {
  invalidateProjectFileQueriesForCwds,
  projectListDirectoriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { getSyntaxHighlighterPromise, getSyntaxLanguageForPath } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import {
  EyeClosedIcon,
  EyeIcon,
  FileIcon,
  FolderAddIcon,
  RefreshCwIcon,
  SortIcon,
} from "~/lib/icons";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { RenameDialog } from "../RenameDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { SearchInput } from "../ui/search-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "./explorerListNavigation";
import { FileEntryIcon } from "./FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "./fileRowStyles";
import { PanelStateMessage } from "./PanelStateMessage";
import { useTranslation, t } from "~/i18n";

const EXPLORER_SORT_STORAGE_KEY = "neolix.workspaceExplorer.sort";
const EXPLORER_SHOW_HIDDEN_STORAGE_KEY = "neolix.workspaceExplorer.showHiddenFiles";

export type WorkspaceExplorerSortOption = "name" | "modified" | "type";

function readStoredExplorerSort(): WorkspaceExplorerSortOption {
  try {
    const value = globalThis.localStorage?.getItem(EXPLORER_SORT_STORAGE_KEY);
    return value === "modified" || value === "type" ? value : "name";
  } catch {
    return "name";
  }
}

/** Old UI defaults to showing dotfiles; keep that default on first run. */
function readStoredShowHiddenFiles(): boolean {
  try {
    return globalThis.localStorage?.getItem(EXPLORER_SHOW_HIDDEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function useWorkspaceExplorerPreferences() {
  const [sortOption, setSortOptionState] =
    useState<WorkspaceExplorerSortOption>(readStoredExplorerSort);
  const [showHiddenFiles, setShowHiddenFilesState] = useState(readStoredShowHiddenFiles);
  const setSortOption = (option: WorkspaceExplorerSortOption) => {
    setSortOptionState(option);
    try {
      const storage = globalThis.localStorage;
      if (storage) {
        storage.setItem(EXPLORER_SORT_STORAGE_KEY, option);
      }
    } catch {
      // Storage can be unavailable (private mode); the in-memory preference still applies.
    }
  };
  const setShowHiddenFiles = (show: boolean) => {
    setShowHiddenFilesState(show);
    try {
      const storage = globalThis.localStorage;
      if (storage) {
        storage.setItem(EXPLORER_SHOW_HIDDEN_STORAGE_KEY, String(show));
      }
    } catch {
      // Same as above: persistence is best-effort.
    }
  };
  return { sortOption, showHiddenFiles, setSortOption, setShowHiddenFiles };
}

function explorerEntryExtension(entry: ProjectFileSystemEntry): string {
  if (entry.kind === "directory") return "";
  const dot = entry.name.lastIndexOf(".");
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
}

function sortExplorerEntries(
  entries: ReadonlyArray<ProjectFileSystemEntry>,
  sortOption: WorkspaceExplorerSortOption,
): ProjectFileSystemEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    // Directories always lead, matching the old explorer.
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    if (sortOption === "modified") {
      const aTime = a.modifiedAt ? Date.parse(a.modifiedAt) : Number.NaN;
      const bTime = b.modifiedAt ? Date.parse(b.modifiedAt) : Number.NaN;
      const diff = (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    }
    if (sortOption === "type") {
      const extensionDiff = explorerEntryExtension(a).localeCompare(explorerEntryExtension(b));
      return extensionDiff !== 0 ? extensionDiff : a.name.localeCompare(b.name);
    }
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

const EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

// Mirrors the composer mention search: debounce keystrokes so they don't fan
// out into fuzzy-search RPCs, and cap results to keep the sidebar light.
const EXPLORER_SEARCH_QUERY_DEBOUNCE_MS = 120;
const EXPLORER_SEARCH_RESULTS_LIMIT = 80;
const EMPTY_WORKSPACE_SEARCH_FILE_MATCHES: ReadonlyArray<ProjectEntry> = [];

// Default sidebar shell: a full-height column in the editor's wide row layout
// that collapses to a stacked block on narrow viewports. Surfaces with a fixed
// horizontal layout (e.g. the right dock) override this via `containerClassName`.
const EXPLORER_SIDEBAR_CONTAINER_CLASS =
  "flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 app-content-surface lg:h-full lg:w-56 lg:border-b-0 lg:border-r";

// Marks the drag payload so the chat composer can accept it as a reference.
export function setFileReferenceDragData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

function shouldShowExplorerEntry(entry: ProjectFileSystemEntry, showHiddenFiles: boolean): boolean {
  if (!showHiddenFiles && entry.name.startsWith(".")) {
    return false;
  }
  if (entry.kind !== "directory") {
    return true;
  }
  if (entry.name.startsWith(".synara")) {
    return false;
  }
  return !EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name);
}

/**
 * Warms caches for an explorer entry before it is clicked: directory listings
 * for folders, file contents plus the matching syntax highlighter for files.
 */
export function useExplorerEntryPrefetch(cwd: string | null) {
  const queryClient = useQueryClient();
  return (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => {
    if (!cwd) {
      return;
    }
    if (entry.kind === "directory") {
      void queryClient.prefetchQuery(
        projectListDirectoriesQueryOptions({
          cwd,
          relativePath: entry.path,
          includeFiles: true,
        }),
      );
      return;
    }
    void queryClient.prefetchQuery(projectReadFileQueryOptions({ cwd, relativePath: entry.path }));
    void getSyntaxHighlighterPromise(getSyntaxLanguageForPath(entry.path)).catch(() => undefined);
  };
}

interface WorkspaceEntryActions {
  openCreate: (parentPath: string, kind: "file" | "directory") => void;
  openRename: (entry: ProjectFileSystemEntry) => void;
  duplicate: (entry: ProjectFileSystemEntry) => void;
  openDelete: (entry: ProjectFileSystemEntry) => void;
  refresh: () => void;
  dialogs: ReactNode;
}

type PendingEntryEdit =
  | { readonly type: "create"; readonly parentPath: string; readonly kind: "file" | "directory" }
  | { readonly type: "rename"; readonly entry: ProjectFileSystemEntry };

async function deleteWorkspaceEntry(params: {
  cwd: string;
  relativePath: string;
  onDeleted: () => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): Promise<void> {
  try {
    await ensureNativeApi().projects.deleteEntry({
      cwd: params.cwd,
      relativePath: params.relativePath,
    });
    params.onDeleted();
  } catch (error) {
    params.onError(error);
  } finally {
    params.onSettled();
  }
}

/**
 * Explorer mutations (create / rename / duplicate / delete) backed by the
 * daemon's fs.entry RPCs. Every success invalidates the workspace's directory
 * and search caches, so both the tree and the name search refresh together.
 */
function useWorkspaceEntryActions(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  /** Drops the preview when the selected file itself, or an ancestor folder, is deleted. */
  onSelectionDeleted?: (() => void) | undefined;
}): WorkspaceEntryActions {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [pendingEdit, setPendingEdit] = useState<PendingEntryEdit | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectFileSystemEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const refresh = () => {
    if (!props.workspaceRoot) return;
    void invalidateProjectFileQueriesForCwds(queryClient, [props.workspaceRoot]);
  };

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
  };

  const commitCreate = async (
    input: { parentPath: string; kind: "file" | "directory" },
    name: string,
  ) => {
    if (!props.workspaceRoot) return;
    try {
      const result = await ensureNativeApi().projects.createEntry({
        cwd: props.workspaceRoot,
        parentPath: input.parentPath,
        name,
        kind: input.kind,
      });
      refresh();
      if (input.kind === "file") {
        props.onSelectFile(result.relativePath);
      }
    } catch (error) {
      reportFailure(t("workspace:workspaceExplorer_createFailed"), error);
      throw error;
    }
  };

  const commitRename = async (entry: ProjectFileSystemEntry, name: string) => {
    if (!props.workspaceRoot || name === entry.name) return;
    try {
      const result = await ensureNativeApi().projects.renameEntry({
        cwd: props.workspaceRoot,
        relativePath: entry.path,
        name,
      });
      refresh();
      const selected = props.selectedFilePath;
      if (selected === entry.path) {
        props.onSelectFile(result.relativePath);
      } else {
        if (selected) {
          if (selected.startsWith(`${entry.path}/`)) {
            props.onSelectFile(`${result.relativePath}${selected.slice(entry.path.length)}`);
          }
        }
      }
    } catch (error) {
      reportFailure(t("workspace:workspaceExplorer_renameFailed"), error);
      throw error;
    }
  };

  const duplicate = (entry: ProjectFileSystemEntry) => {
    if (!props.workspaceRoot) return;
    void ensureNativeApi()
      .projects.duplicateEntry({ cwd: props.workspaceRoot, relativePath: entry.path })
      .then((result) => {
        refresh();
        // Duplicating a folder only adds a sibling; selecting it would ask the
        // file preview to open a directory.
        if (entry.kind === "file") {
          props.onSelectFile(result.relativePath);
        }
      })
      .catch((error: unknown) => {
        reportFailure(t("workspace:workspaceExplorer_duplicateFailed"), error);
      });
  };

  const confirmDelete = async () => {
    const entry = pendingDelete;
    if (!props.workspaceRoot || !entry) return;
    setIsDeleting(true);
    await deleteWorkspaceEntry({
      cwd: props.workspaceRoot,
      relativePath: entry.path,
      onDeleted: () => {
        refresh();
        setPendingDelete(null);
        const selected = props.selectedFilePath;
        if (selected === entry.path || selected?.startsWith(`${entry.path}/`)) {
          props.onSelectionDeleted?.();
        }
      },
      onError: (error) => {
        reportFailure(t("workspace:workspaceExplorer_deleteFailed"), error);
      },
      onSettled: () => {
        setIsDeleting(false);
      },
    });
  };

  const dialogs = (
    <>
      <RenameDialog
        open={pendingEdit !== null}
        title={
          pendingEdit?.type === "create"
            ? pendingEdit.kind === "file"
              ? t("workspace:workspaceExplorer_createFileTitle")
              : t("workspace:workspaceExplorer_createFolderTitle")
            : t("workspace:workspaceExplorer_renameTitle")
        }
        placeholder={t("workspace:workspaceExplorer_namePlaceholder")}
        initialValue={pendingEdit?.type === "rename" ? pendingEdit.entry.name : ""}
        onOpenChange={(open) => {
          if (!open) setPendingEdit(null);
        }}
        onSave={(name) => {
          if (pendingEdit?.type === "create") {
            return commitCreate(pendingEdit, name);
          }
          if (pendingEdit?.type === "rename") {
            return commitRename(pendingEdit.entry, name);
          }
          return Promise.resolve();
        }}
      />
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.kind === "directory"
                ? t("workspace:workspaceExplorer_deleteFolderTitle")
                : t("workspace:workspaceExplorer_deleteFileTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace:workspaceExplorer_deleteDescription", {
                name: pendingDelete?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />} disabled={isDeleting}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? t("workspace:deleting") : t("workspace:workspaceExplorer_deleteEntry")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );

  return {
    openCreate: (parentPath, kind) => setPendingEdit({ type: "create", parentPath, kind }),
    openRename: (entry) => setPendingEdit({ type: "rename", entry }),
    duplicate,
    openDelete: (entry) => setPendingDelete(entry),
    refresh,
    dialogs,
  };
}

/** Browser download: the bridge reads the bytes; the DOM turns them into a file save. */
function downloadWorkspaceFile(cwd: string, relativePath: string): void {
  void ensureNativeApi()
    .projects.downloadFile({ cwd, relativePath })
    .then((result) => {
      const binary = atob(result.bytesBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const blob = new Blob([bytes], { type: result.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    })
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: t("workspace:workspaceExplorer_downloadFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    });
}

// Explorer toolbar (tree surfaces only): sort, refresh and root-level creation, mirroring
// the old file explorer's sort cycle, hidden-files toggle, and New file / New folder controls.
function WorkspaceExplorerToolbar(props: {
  disabled: boolean;
  sortOption: WorkspaceExplorerSortOption;
  showHiddenFiles: boolean;
  onSortChange: (option: WorkspaceExplorerSortOption) => void;
  onToggleHiddenFiles: () => void;
  onRefresh: () => void;
  onCreateFile: () => void;
  onCreateFolder: () => void;
}) {
  const { t } = useTranslation();
  const sortLabels: Record<WorkspaceExplorerSortOption, string> = {
    name: t("workspace:workspaceExplorer_sortName"),
    modified: t("workspace:workspaceExplorer_sortModified"),
    type: t("workspace:workspaceExplorer_sortType"),
  };
  return (
    <div className="flex shrink-0 items-center justify-between gap-0.5 px-2 py-1">
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              label={t("workspace:workspaceExplorer_sortBy")}
              tooltip={sortLabels[props.sortOption]}
              size="icon-xs"
            >
              <SortIcon className="size-3.5" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="start" side="bottom" className="w-44 min-w-44">
          <MenuGroup>
            <MenuGroupLabel>{t("workspace:workspaceExplorer_sortBy")}</MenuGroupLabel>
            <MenuRadioGroup
              value={props.sortOption}
              onValueChange={(value) => {
                if (value === "name" || value === "modified" || value === "type") {
                  props.onSortChange(value);
                }
              }}
            >
              <MenuRadioItem value="name">{sortLabels.name}</MenuRadioItem>
              <MenuRadioItem value="modified">{sortLabels.modified}</MenuRadioItem>
              <MenuRadioItem value="type">{sortLabels.type}</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>
      <div className="flex items-center gap-0.5">
        <IconButton
          label={t("workspace:workspaceExplorer_refresh")}
          tooltip={t("workspace:workspaceExplorer_refresh")}
          size="icon-xs"
          disabled={props.disabled}
          onClick={props.onRefresh}
        >
          <RefreshCwIcon className="size-3.5" />
        </IconButton>
        <IconButton
          label={t("workspace:workspaceExplorer_newFile")}
          tooltip={t("workspace:workspaceExplorer_newFile")}
          size="icon-xs"
          disabled={props.disabled}
          onClick={props.onCreateFile}
        >
          <FileIcon className="size-3.5" />
        </IconButton>
        <IconButton
          label={t("workspace:workspaceExplorer_newFolder")}
          tooltip={t("workspace:workspaceExplorer_newFolder")}
          size="icon-xs"
          disabled={props.disabled}
          onClick={props.onCreateFolder}
        >
          <FolderAddIcon className="size-3.5" />
        </IconButton>
        <IconButton
          label={
            props.showHiddenFiles
              ? t("workspace:workspaceExplorer_hideHiddenFiles")
              : t("workspace:workspaceExplorer_showHiddenFiles")
          }
          tooltip={
            props.showHiddenFiles
              ? t("workspace:workspaceExplorer_hideHiddenFiles")
              : t("workspace:workspaceExplorer_showHiddenFiles")
          }
          size="icon-xs"
          aria-pressed={props.showHiddenFiles}
          onClick={props.onToggleHiddenFiles}
        >
          {props.showHiddenFiles ? (
            <EyeIcon className="size-3.5" />
          ) : (
            <EyeClosedIcon className="size-3.5" />
          )}
        </IconButton>
      </div>
    </div>
  );
}

// Forwards its ref and spreads incoming props so directory rows can act as the
// Collapsible trigger (Base UI injects onClick/aria/data + ref onto this element).
const ExplorerRow = forwardRef<
  HTMLButtonElement,
  {
    entry: ProjectFileSystemEntry;
    depth: number;
    selected: boolean;
    expanded: boolean;
    onSelectFile: (path: string) => void;
    onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
    onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
  } & ComponentPropsWithoutRef<"button">
>(function ExplorerRow(
  {
    entry,
    depth,
    selected,
    expanded,
    onSelectFile,
    onPrefetchEntry,
    onEntryContextMenu,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const isDirectory = entry.kind === "directory";
  // Directory rows are the Collapsible trigger: chain Base UI's injected onClick
  // (which toggles open/close) and skip file selection. File rows open the preview.
  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (isDirectory) {
      return;
    }
    onSelectFile(entry.path);
  };
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };
  const handleContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    onEntryContextMenu(entry, { x: event.clientX, y: event.clientY });
  };
  const handleDragStart = (event: ReactDragEvent<HTMLButtonElement>) => {
    setFileReferenceDragData(event.dataTransfer, entry.path);
  };

  return (
    <button
      {...rest}
      {...EXPLORER_ROW_PROPS}
      ref={ref}
      type="button"
      className={fileRowClassName(selected, cn("h-7 pr-2", className))}
      style={fileRowIndentStyle(depth)}
      title={entry.path}
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={handleContextMenu}
    >
      {isDirectory ? (
        <DisclosureChevron open={expanded} className="opacity-75" />
      ) : (
        <FileEntryIcon
          pathValue={entry.path}
          kind={entry.kind}
          className="size-3.5 shrink-0 opacity-75"
        />
      )}
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
});

const EXPLORER_SKELETON_ROW_WIDTHS = ["w-9/12", "w-6/12", "w-7/12"];

function ExplorerLoadingRows(props: { depth: number }) {
  const { t } = useTranslation();

  return (
    <div
      className="space-y-1.5 py-1.5 pr-2"
      style={fileRowIndentStyle(props.depth)}
      role="status"
      aria-label={t("workspace:workspaceExplorer_loadingDirectory")}
    >
      {EXPLORER_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-5 items-center gap-1.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceDirectory(props: {
  cwd: string;
  relativePath: string | null;
  depth: number;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  sortOption: WorkspaceExplorerSortOption;
  showHiddenFiles: boolean;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();

  const query = useQuery(
    projectListDirectoriesQueryOptions({
      cwd: props.cwd,
      relativePath: props.relativePath,
      includeFiles: true,
    }),
  );

  if (query.isLoading && !query.data) {
    return <ExplorerLoadingRows depth={props.depth} />;
  }

  if (query.error) {
    return (
      <p className="px-3 py-2 text-ui-sm text-destructive/80">
        {query.error instanceof Error
          ? query.error.message
          : t("workspace:workspaceExplorer_couldNotLoadDirectory")}
      </p>
    );
  }

  return (
    <>
      {sortExplorerEntries(
        (query.data?.entries ?? []).filter((entry) =>
          shouldShowExplorerEntry(entry, props.showHiddenFiles),
        ),
        props.sortOption,
      ).map((entry) => {
        if (entry.kind !== "directory") {
          return (
            <ExplorerRow
              key={entry.path}
              entry={entry}
              depth={props.depth}
              selected={entry.path === props.selectedFilePath}
              expanded={false}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          );
        }
        const expanded = props.expandedDirectories.has(entry.path);
        return (
          <Collapsible
            key={entry.path}
            open={expanded}
            onOpenChange={() => props.onToggleDirectory(entry.path)}
          >
            <CollapsibleTrigger
              render={
                <ExplorerRow
                  entry={entry}
                  depth={props.depth}
                  selected={false}
                  expanded={expanded}
                  onSelectFile={props.onSelectFile}
                  onPrefetchEntry={props.onPrefetchEntry}
                  onEntryContextMenu={props.onEntryContextMenu}
                />
              }
            />
            {/* Keep children mounted only while open (plus the closing transition Base UI
                manages) so the height animation plays and lazy listings stay cached. */}
            <CollapsiblePanel>
              <WorkspaceDirectory
                cwd={props.cwd}
                relativePath={entry.path}
                depth={props.depth + 1}
                selectedFilePath={props.selectedFilePath}
                expandedDirectories={props.expandedDirectories}
                sortOption={props.sortOption}
                showHiddenFiles={props.showHiddenFiles}
                onSelectFile={props.onSelectFile}
                onToggleDirectory={props.onToggleDirectory}
                onPrefetchEntry={props.onPrefetchEntry}
                onEntryContextMenu={props.onEntryContextMenu}
              />
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
    </>
  );
}

// Opening the file-reference context menu from a tree row (full entry) or a
// search-result row (path only). Both wrap the same menu, so they live here
// instead of being re-declared in every sidebar that renders these rows.
function useTreeEntryContextMenu(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
  actions: WorkspaceEntryActions,
  workspaceRoot: string | null,
) {
  return (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({
      path: entry.path,
      position,
      onReferenceInChat,
      isDirectory: entry.kind === "directory",
      onCreateFile: (parentPath) => actions.openCreate(parentPath, "file"),
      onCreateFolder: (parentPath) => actions.openCreate(parentPath, "directory"),
      onRename: () => actions.openRename(entry),
      onDuplicate: () => actions.duplicate(entry),
      onDelete: () => actions.openDelete(entry),
      ...(workspaceRoot && entry.kind !== "directory"
        ? { onDownload: () => downloadWorkspaceFile(workspaceRoot, entry.path) }
        : {}),
    });
  };
}

function useResultEntryContextMenu(
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined,
  workspaceRoot: string | null,
) {
  return (path: string, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({
      path,
      position,
      onReferenceInChat,
      ...(workspaceRoot ? { onDownload: () => downloadWorkspaceFile(workspaceRoot, path) } : {}),
    });
  };
}

// Scrollable file-tree body, shared by the standalone files sidebar and the
// combined explorer sidebar (which shows it whenever the search box is empty).
function WorkspaceFilesTreeBody(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  sortOption: WorkspaceExplorerSortOption;
  showHiddenFiles: boolean;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
      {props.workspaceRoot ? (
        <WorkspaceDirectory
          cwd={props.workspaceRoot}
          relativePath={null}
          depth={0}
          selectedFilePath={props.selectedFilePath}
          expandedDirectories={props.expandedDirectories}
          sortOption={props.sortOption}
          showHiddenFiles={props.showHiddenFiles}
          onSelectFile={props.onSelectFile}
          onToggleDirectory={props.onToggleDirectory}
          onPrefetchEntry={props.onPrefetchEntry}
          onEntryContextMenu={props.onEntryContextMenu}
        />
      ) : (
        <PanelStateMessage density="compact" fill="flex">
          <p>{t("workspace:workspaceExplorer_noWorkspace")}</p>
        </PanelStateMessage>
      )}
    </div>
  );
}

export function WorkspaceFilesSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onSelectionDeleted?: (() => void) | undefined;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const actions = useWorkspaceEntryActions(props);
  const preferences = useWorkspaceExplorerPreferences();
  const handleEntryContextMenu = useTreeEntryContextMenu(
    props.onReferenceInChat,
    actions,
    props.workspaceRoot,
  );
  const handleListKeyDown = useExplorerListNavigation();
  return (
    <>
      <aside
        className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
        onKeyDown={handleListKeyDown}
      >
        <WorkspaceExplorerToolbar
          disabled={!props.workspaceRoot}
          sortOption={preferences.sortOption}
          showHiddenFiles={preferences.showHiddenFiles}
          onSortChange={preferences.setSortOption}
          onToggleHiddenFiles={() => preferences.setShowHiddenFiles(!preferences.showHiddenFiles)}
          onRefresh={actions.refresh}
          onCreateFile={() => actions.openCreate(".", "file")}
          onCreateFolder={() => actions.openCreate(".", "directory")}
        />
        <WorkspaceFilesTreeBody
          workspaceRoot={props.workspaceRoot}
          selectedFilePath={props.selectedFilePath}
          expandedDirectories={props.expandedDirectories}
          sortOption={preferences.sortOption}
          showHiddenFiles={preferences.showHiddenFiles}
          onSelectFile={props.onSelectFile}
          onToggleDirectory={props.onToggleDirectory}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleEntryContextMenu}
        />
      </aside>
      {actions.dialogs}
    </>
  );
}

function WorkspaceSearchResultRow(props: {
  entry: ProjectEntry;
  selected: boolean;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => void;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { entry, onEntryContextMenu, onPrefetchEntry, onSelectFile } = props;
  const { dir, name } = splitRepoRelativePath(entry.path);
  const handlePrefetch = () => {
    onPrefetchEntry(entry);
  };

  return (
    <button
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={entry.path}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, entry.path);
      }}
      onClick={() => onSelectFile(entry.path)}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={(event) => {
        event.preventDefault();
        onEntryContextMenu(entry.path, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon pathValue={entry.path} kind="file" className="size-3.5 shrink-0 opacity-75" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 truncate font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 truncate text-ui-sm text-muted-foreground/55">{dir}</span>
        ) : null}
      </div>
    </button>
  );
}

interface WorkspaceFileSearchState {
  // Trimmed live input — drives the "is the box empty?" decision (tree vs results).
  inputQuery: string;
  fileMatches: ReadonlyArray<ProjectEntry>;
  searchResultsPending: boolean;
  searchResultsCurrent: boolean;
  isFetching: boolean;
  error: Error | null;
  truncated: boolean;
}

// Fuzzy file-name search shared by the standalone search sidebar and the
// combined explorer sidebar: debounce keystrokes, then expose the matches plus
// the freshness flags both surfaces need to gate selection on stale results.
function useWorkspaceFileSearch(
  workspaceRoot: string | null,
  query: string,
): WorkspaceFileSearchState {
  const [debouncedQuery] = useDebouncedValue(query, {
    wait: EXPLORER_SEARCH_QUERY_DEBOUNCE_MS,
  });
  const inputQuery = query.trim();
  const trimmedQuery = debouncedQuery.trim();
  const entriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: workspaceRoot,
      query: trimmedQuery,
      kind: "file",
      limit: EXPLORER_SEARCH_RESULTS_LIMIT,
    }),
  );
  // Results are tied to the debounced query. While the user is ahead of that
  // query, keep old results non-selectable so Enter cannot open a stale match.
  const searchResultsPending = inputQuery !== trimmedQuery || entriesQuery.isPlaceholderData;
  const searchResultsCurrent = !searchResultsPending;
  const fileMatches = searchResultsCurrent
    ? (entriesQuery.data?.entries ?? EMPTY_WORKSPACE_SEARCH_FILE_MATCHES)
    : EMPTY_WORKSPACE_SEARCH_FILE_MATCHES;
  return {
    inputQuery,
    fileMatches,
    searchResultsPending,
    searchResultsCurrent,
    isFetching: entriesQuery.isFetching,
    error: searchResultsCurrent ? entriesQuery.error : null,
    truncated: entriesQuery.data?.truncated ?? false,
  };
}

// Search-box header: a fixed, full-width input that selects the top match on
// Enter and clears (returning to the tree, in the combined sidebar) on Escape.
function WorkspaceSearchInputHeader(props: {
  query: string;
  search: WorkspaceFileSearchState;
  autoFocus?: boolean;
  onQueryChange: (query: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const { t } = useTranslation();

  const { onQueryChange, onSelectFile, query, search } = props;
  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (!search.searchResultsCurrent) {
        return;
      }
      const topMatch = search.fileMatches[0];
      if (topMatch) {
        onSelectFile(topMatch.path);
      }
      return;
    }
    if (event.key === "Escape" && query.length > 0) {
      event.stopPropagation();
      onQueryChange("");
    }
  };

  return (
    <div className="shrink-0 border-b border-border/65 p-2">
      <SearchInput
        value={query}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={t("workspace:workspaceExplorer_searchFiles")}
        aria-label={t("workspace:editor_searchFiles")}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleInputKeyDown}
      />
    </div>
  );
}

// Scrollable search-results body (matches list + truncation hint). Callers only
// mount it once the query is non-empty, so the empty-query state lives outside.
function WorkspaceSearchResultsBody(props: {
  workspaceRoot: string | null;
  search: WorkspaceFileSearchState;
  selectedFilePath: string | null;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => void;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();

  const { fileMatches } = props.search;
  return (
    <>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          fileMatches.length === 0 && "flex flex-col",
        )}
      >
        {!props.workspaceRoot ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>{t("workspace:workspaceExplorer_noWorkspace")}</p>
          </PanelStateMessage>
        ) : props.search.searchResultsCurrent && props.search.error ? (
          <PanelStateMessage density="compact" fill="flex">
            <p className="text-destructive/85">
              {props.search.error instanceof Error
                ? props.search.error.message
                : t("workspace:workspaceExplorer_couldNotSearchFiles")}
            </p>
          </PanelStateMessage>
        ) : fileMatches.length === 0 ? (
          props.search.searchResultsPending || props.search.isFetching ? (
            <ExplorerLoadingRows depth={0} />
          ) : (
            <PanelStateMessage density="compact" fill="flex">
              <p>{t("common:workspaceExplorer_noMatchingFiles")}</p>
            </PanelStateMessage>
          )
        ) : (
          fileMatches.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              selected={entry.path === props.selectedFilePath}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          ))
        )}
      </div>
      {fileMatches.length > 0 && props.search.truncated ? (
        <p className="shrink-0 border-t border-border/45 px-3 py-1.5 text-ui-xs text-muted-foreground/70">
          {t("workspace:workspaceExplorer_showingTopMatches")}
        </p>
      ) : null}
    </>
  );
}

export function WorkspaceSearchSidebar(props: {
  workspaceRoot: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  selectedFilePath: string | null;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const { t } = useTranslation();

  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const handleEntryContextMenu = useResultEntryContextMenu(
    props.onReferenceInChat,
    props.workspaceRoot,
  );
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(props.workspaceRoot, props.query);

  return (
    <aside
      className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
      onKeyDown={handleListKeyDown}
    >
      <WorkspaceSearchInputHeader
        query={props.query}
        search={search}
        autoFocus
        onQueryChange={props.onQueryChange}
        onSelectFile={props.onSelectFile}
      />
      {search.inputQuery.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col px-1 py-1">
          <PanelStateMessage density="compact" fill="flex">
            <p>{t("workspace:workspaceExplorer_searchFilesByPath")}</p>
          </PanelStateMessage>
        </div>
      ) : (
        <WorkspaceSearchResultsBody
          workspaceRoot={props.workspaceRoot}
          search={search}
          selectedFilePath={props.selectedFilePath}
          onSelectFile={props.onSelectFile}
          onPrefetchEntry={prefetchEntry}
          onEntryContextMenu={handleEntryContextMenu}
        />
      )}
    </aside>
  );
}

// Combined explorer: one panel with a fixed search box on top that shows the
// full file tree while empty and switches to fuzzy file-name results as soon as
// the user types — no separate Files/Search activity rail needed.
export function WorkspaceExplorerSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  query: string;
  onQueryChange: (query: string) => void;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onSelectionDeleted?: (() => void) | undefined;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const actions = useWorkspaceEntryActions(props);
  const preferences = useWorkspaceExplorerPreferences();
  const handleTreeEntryContextMenu = useTreeEntryContextMenu(
    props.onReferenceInChat,
    actions,
    props.workspaceRoot,
  );
  const handleResultEntryContextMenu = useResultEntryContextMenu(
    props.onReferenceInChat,
    props.workspaceRoot,
  );
  const handleListKeyDown = useExplorerListNavigation();
  const search = useWorkspaceFileSearch(props.workspaceRoot, props.query);

  return (
    <>
      <aside
        className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}
        onKeyDown={handleListKeyDown}
      >
        <WorkspaceSearchInputHeader
          query={props.query}
          search={search}
          onQueryChange={props.onQueryChange}
          onSelectFile={props.onSelectFile}
        />
        <WorkspaceExplorerToolbar
          disabled={!props.workspaceRoot}
          sortOption={preferences.sortOption}
          showHiddenFiles={preferences.showHiddenFiles}
          onSortChange={preferences.setSortOption}
          onToggleHiddenFiles={() => preferences.setShowHiddenFiles(!preferences.showHiddenFiles)}
          onRefresh={actions.refresh}
          onCreateFile={() => actions.openCreate(".", "file")}
          onCreateFolder={() => actions.openCreate(".", "directory")}
        />
        {search.inputQuery.length === 0 ? (
          <WorkspaceFilesTreeBody
            workspaceRoot={props.workspaceRoot}
            selectedFilePath={props.selectedFilePath}
            expandedDirectories={props.expandedDirectories}
            sortOption={preferences.sortOption}
            showHiddenFiles={preferences.showHiddenFiles}
            onSelectFile={props.onSelectFile}
            onToggleDirectory={props.onToggleDirectory}
            onPrefetchEntry={prefetchEntry}
            onEntryContextMenu={handleTreeEntryContextMenu}
          />
        ) : (
          <WorkspaceSearchResultsBody
            workspaceRoot={props.workspaceRoot}
            search={search}
            selectedFilePath={props.selectedFilePath}
            onSelectFile={props.onSelectFile}
            onPrefetchEntry={prefetchEntry}
            onEntryContextMenu={handleResultEntryContextMenu}
          />
        )}
      </aside>
      {actions.dialogs}
    </>
  );
}

export function ExplorerActivityBarButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        "relative flex h-12 w-full cursor-pointer items-center justify-center text-muted-foreground/72 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        props.active && "bg-[var(--color-background-button-secondary)] text-foreground",
      )}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-transparent",
          props.active && "bg-foreground/85",
        )}
        aria-hidden="true"
      />
      {props.children}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
