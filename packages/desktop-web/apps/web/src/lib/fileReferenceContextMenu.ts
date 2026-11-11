// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows, file previews, and chat file
//          links (editor explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu, getRevealInFolderLabel

import { t } from "~/i18n";
import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

/** Workspace-relative parent of a repo path; the root itself is ".". */
function parentDirectoryOf(path: string): string {
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash <= 0 ? "." : path.slice(0, slash);
}

export function getRevealInFolderLabel(platform: string): string {
  if (isWindowsPlatform(platform)) {
    return t("workspace:revealExplorer");
  }
  if (isMacPlatform(platform)) {
    return t("workspace:revealFinder");
  }
  return t("workspace:revealFolder");
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(input: {
  path: string;
  /** Absolute path to reveal in the platform file manager. Omit when the
   * surface only knows a repository-relative path. */
  revealPath?: string;
  position: { x: number; y: number };
  /** Line/column range from source views, or a quoted snippet from surfaces
   * without stable source lines (rendered markdown preview). */
  selection?: Omit<ChatFileReference, "path"> | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
  /** True for directory rows; New file / New folder then target the row itself
   * instead of its parent. */
  isDirectory?: boolean;
  onCreateFile?: ((parentPath: string) => void) | undefined;
  onCreateFolder?: ((parentPath: string) => void) | undefined;
  onRename?: (() => void) | undefined;
  onDuplicate?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /** Browser builds download the file through the bridge; omit for directories. */
  onDownload?: (() => void) | undefined;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const revealPath =
    input.revealPath && typeof window !== "undefined" && window.desktopBridge
      ? input.revealPath
      : undefined;
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference, t);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const targetDirectory = input.isDirectory ? input.path : parentDirectoryOf(input.path);
  const clicked = await api.contextMenu.show(
    [
      ...(input.onCreateFile
        ? [
            {
              id: "new-file" as const,
              label: t("workspace:workspaceExplorer_newFile"),
            },
          ]
        : []),
      ...(input.onCreateFolder
        ? [
            {
              id: "new-folder" as const,
              label: t("workspace:workspaceExplorer_newFolder"),
            },
          ]
        : []),
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel
                ? t("workspace:referenceRange", { range: rangeLabel })
                : hasSnippet
                  ? t("workspace:referenceSelection")
                  : t("workspace:referenceFile"),
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel
                ? t("workspace:askWhyRangeChanged", { range: rangeLabel })
                : t("workspace:askWhyChanged"),
            },
          ]
        : []),
      ...(revealPath
        ? [
            {
              id: "reveal-in-folder" as const,
              label: getRevealInFolderLabel(getNavigatorPlatform()),
            },
          ]
        : []),
      ...(input.onDownload
        ? [
            {
              id: "download" as const,
              label: t("workspace:workspaceExplorer_download"),
            },
          ]
        : []),
      { id: "copy-path" as const, label: t("common:diff_copyPath") },
      ...(input.onRename
        ? [
            {
              id: "rename" as const,
              label: t("workspace:workspaceExplorer_renameEntry"),
              separatorBefore: true,
            },
          ]
        : []),
      ...(input.onDuplicate
        ? [
            {
              id: "duplicate" as const,
              label: t("workspace:workspaceExplorer_duplicateEntry"),
            },
          ]
        : []),
      ...(input.onDelete
        ? [
            {
              id: "delete" as const,
              label: t("workspace:workspaceExplorer_deleteEntry"),
              separatorBefore: !input.onDuplicate,
              destructive: true,
            },
          ]
        : []),
    ],
    input.position,
  );
  if (clicked === "new-file" && input.onCreateFile) {
    input.onCreateFile(targetDirectory);
    return;
  }
  if (clicked === "new-folder" && input.onCreateFolder) {
    input.onCreateFolder(targetDirectory);
    return;
  }
  if (clicked === "rename" && input.onRename) {
    input.onRename();
    return;
  }
  if (clicked === "duplicate" && input.onDuplicate) {
    input.onDuplicate();
    return;
  }
  if (clicked === "delete" && input.onDelete) {
    input.onDelete();
    return;
  }
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "reveal-in-folder" && revealPath) {
    try {
      await api.shell.showInFolder(revealPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("workspace:revealFileFailed"),
        description: error instanceof Error ? error.message : t("workspace:revealFileUnknownError"),
      });
    }
    return;
  }
  if (clicked === "copy-path") {
    await copyTextToClipboard(input.path);
    return;
  }
  if (clicked === "download") {
    input.onDownload?.();
  }
}
