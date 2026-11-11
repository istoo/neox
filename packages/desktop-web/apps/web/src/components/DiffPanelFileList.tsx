// FILE: DiffPanelFileList.tsx
// Purpose: Multi-file diff list for the review panel, including per-file actions and previews.
// Layer: Diff panel UI

import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs/react";
import {
  isSupportedLocalImagePath,
  isSupportedLocalPreviewFilePath,
} from "@synara/shared/localPreviewFiles";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useCopyPathToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  MessageCircleIcon,
  PencilIcon,
} from "~/lib/icons";

import {
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  hasUneditableGitMode,
  resolveFileDiffPrevPath,
} from "~/lib/diffRendering";
import { FileDiffCard, FileDiffSurface, type DiffLineClickProps } from "./chat/FileDiffView";
import {
  formatFileCommentRange,
  type FileCommentReviewTarget,
  type FileCommentSelection,
} from "~/lib/fileComments";
import { FileLineCommentBox } from "./chat/FileLineCommentBox";
import { resolveDiffLineBlameTarget, type DiffLineBlameTarget } from "./DiffLineBlamePopover";
import { LocalImagePreview } from "./LocalImagePreview";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { IconButton } from "./ui/icon-button";
import { TOOLBAR_ICON_BUTTON_TONE_CLASS_NAME } from "./ui/button-group";
import { Menu, MenuItem, MenuTrigger } from "./ui/menu";
import { useTranslation } from "~/i18n";

type DiffRenderMode = "stacked" | "split";

export interface DiffFileChatActions {
  onReferenceInChat: (filePath: string) => void;
  onAskWhyChanged: (filePath: string) => void;
  onEditFile?: ((filePath: string, options?: { basePath?: string | null }) => void) | undefined;
  /** Adds an inline line comment to the active thread's composer draft. */
  onCommentLine?: ((comment: FileCommentSelection) => void) | undefined;
}

// Old UI's review attachment quotes three lines either side of the commented line.
const DIFF_COMMENT_CONTEXT_RADIUS = 3;

interface DiffContextLine {
  readonly prefix: " " | "+" | "-";
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

// The renderer's line arrays hold plain file lines including their trailing newline, so
// the excerpt supplies the unified-diff prefix itself.
function readDiffLine(lines: ReadonlyArray<string>, index: number): string {
  return (lines[index] ?? "").replace(/\r?\n$/, "");
}

function expandHunkLines(
  fileDiff: FileDiffMetadata,
  hunk: FileDiffMetadata["hunks"][number],
): DiffContextLine[] {
  const lines: DiffContextLine[] = [];
  let additionLine = hunk.additionStart;
  let deletionLine = hunk.deletionStart;
  let additionIndex = hunk.additionLineIndex;
  let deletionIndex = hunk.deletionLineIndex;
  for (const content of hunk.hunkContent) {
    if (content.type === "context") {
      for (let index = 0; index < content.lines; index += 1) {
        lines.push({
          prefix: " ",
          text: readDiffLine(fileDiff.additionLines, additionIndex + index),
          oldLine: deletionLine + index,
          newLine: additionLine + index,
        });
      }
      additionLine += content.lines;
      deletionLine += content.lines;
      additionIndex += content.lines;
      deletionIndex += content.lines;
      continue;
    }
    for (let index = 0; index < content.deletions; index += 1) {
      lines.push({
        prefix: "-",
        text: readDiffLine(fileDiff.deletionLines, deletionIndex + index),
        oldLine: deletionLine + index,
        newLine: null,
      });
    }
    deletionLine += content.deletions;
    deletionIndex += content.deletions;
    for (let index = 0; index < content.additions; index += 1) {
      lines.push({
        prefix: "+",
        text: readDiffLine(fileDiff.additionLines, additionIndex + index),
        oldLine: null,
        newLine: additionLine + index,
      });
    }
    additionLine += content.additions;
    additionIndex += content.additions;
  }
  return lines;
}

/**
 * Unified-diff excerpt around a commented range: the hunk header plus a few lines of
 * surrounding code, so the comment keeps meaning if the file shifts afterwards.
 */
export function buildDiffCommentHunkContext(
  fileDiff: FileDiffMetadata,
  range: Pick<SelectedLineRange, "start" | "end" | "side">,
): string | null {
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const oldSide = range.side === "deletions";
  const hunk = fileDiff.hunks.find((candidate) => {
    if (oldSide) {
      return (
        start >= candidate.deletionStart &&
        start < candidate.deletionStart + Math.max(candidate.deletionCount, 1)
      );
    }
    return (
      start >= candidate.additionStart &&
      start < candidate.additionStart + Math.max(candidate.additionCount, 1)
    );
  });
  if (!hunk) return null;
  const lines = expandHunkLines(fileDiff, hunk);
  const matches = (line: DiffContextLine) => {
    const lineNumber = oldSide ? line.oldLine : line.newLine;
    return lineNumber !== null && lineNumber >= start && lineNumber <= end;
  };
  const first = lines.findIndex(matches);
  if (first === -1) return null;
  let last = first;
  for (let index = first; index < lines.length; index += 1) {
    if (matches(lines[index]!)) last = index;
  }
  const from = Math.max(0, first - DIFF_COMMENT_CONTEXT_RADIUS);
  const to = Math.min(lines.length, last + DIFF_COMMENT_CONTEXT_RADIUS + 1);
  // Number the excerpt as its own unified hunk. The stored comment keeps only this
  // string, and the composer rebuilds review line numbers by parsing it, so the
  // header must describe the excerpt rather than the original hunk's first line.
  let oldStart = hunk.deletionStart;
  let newStart = hunk.additionStart;
  for (let index = 0; index < from; index += 1) {
    const prefix = lines[index]?.prefix;
    if (prefix !== "+") oldStart += 1;
    if (prefix !== "-") newStart += 1;
  }
  const excerpt = lines.slice(from, to);
  const oldCount = excerpt.filter((line) => line.prefix !== "+").length;
  const newCount = excerpt.filter((line) => line.prefix !== "-").length;
  const sourceLabel =
    hunk.hunkSpecs?.replace(/^@@[^@]*@@\s*/, "").trim() || hunk.hunkContext?.trim() || "";
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${
    sourceLabel ? ` ${sourceLabel}` : ""
  }`;
  return [header, ...excerpt.map((line) => `${line.prefix}${line.text}`)].join("\n");
}

interface DiffLineCommentTarget {
  readonly startLine: number;
  readonly endLine: number;
  readonly oldSide: boolean;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

const DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";

// Per-file actions menu rendered in the custom header's trailing slot, left of
// the collapse chevron. Marked with data-diff-header-menu so header clicks on
// it do not toggle the file collapse state.
function DiffFileHeaderActionsMenu(props: {
  filePath: string;
  canEditFile: boolean;
  basePath: string | null;
  chatActions: DiffFileChatActions;
}) {
  const { t } = useTranslation();

  const copyPathToClipboard = useCopyPathToClipboard();

  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-xs"
            shape="capsule"
            label={t("common:fileActions")}
            title={t("common:fileActions")}
            className={TOOLBAR_ICON_BUTTON_TONE_CLASS_NAME}
          >
            <EllipsisIcon className="size-3.5" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-60 min-w-60">
        {props.chatActions.onEditFile && props.canEditFile ? (
          <MenuItem
            onClick={() => {
              props.chatActions.onEditFile?.(props.filePath, { basePath: props.basePath });
            }}
          >
            <PencilIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
            <span>{t("common:editFile")}</span>
          </MenuItem>
        ) : null}
        <MenuItem
          onClick={() => {
            props.chatActions.onReferenceInChat(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>{t("common:diff_referenceInChat")}</span>
        </MenuItem>
        <MenuItem
          onClick={() => {
            props.chatActions.onAskWhyChanged(props.filePath);
          }}
        >
          <MessageCircleIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>{t("common:workspaceFilePreviewHeader_askWhyChanged")}</span>
        </MenuItem>
        <MenuItem onClick={() => copyPathToClipboard(props.filePath)}>
          <CopyIcon className={DIFF_FILE_ACTIONS_MENU_ICON_CLASS_NAME} />
          <span>{t("common:diff_copyPath")}</span>
        </MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function DiffFileCollapseChevron(props: { collapsed: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px",
        color: "inherit",
      }}
    >
      <ChevronDownIcon
        style={{
          width: "14px",
          height: "14px",
          transition: "transform 150ms ease",
          transform: props.collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          opacity: 0.5,
        }}
      />
    </span>
  );
}

const DiffPanelFileRow = function DiffPanelFileRow(props: {
  fileDiff: FileDiffMetadata;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  isCollapsed: boolean;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
  /** Checkout / comparison the rendered hunks belong to, for review attachments. */
  reviewTarget?: FileCommentReviewTarget | undefined;
  onBlameLine?: ((target: DiffLineBlameTarget) => void) | undefined;
}) {
  const { t } = useTranslation();

  const filePath = resolveFileDiffPath(props.fileDiff);
  const fileKey = buildFileDiffRenderKey(props.fileDiff);
  const { chatActions, isCollapsed } = props;
  // A deleted file no longer exists in the working tree, binary previews
  // (images, PDFs) are rejected by the text read, and symlinks or submodule
  // entries cannot be written as the text shown here.
  const canEditFile =
    props.fileDiff.type !== "deleted" &&
    !isSupportedLocalPreviewFilePath(filePath) &&
    !hasUneditableGitMode(props.fileDiff);
  // Renames keep the base-side content under the old path.
  const basePath = resolveFileDiffPrevPath(props.fileDiff);
  const shouldPreviewImage =
    !isCollapsed && props.workspaceRoot !== null && isSupportedLocalImagePath(filePath);
  const renderHeaderTrailing = () => (
    <>
      {chatActions ? (
        <span data-diff-header-menu="true" className="inline-flex">
          <DiffFileHeaderActionsMenu
            filePath={filePath}
            canEditFile={canEditFile}
            basePath={basePath}
            chatActions={chatActions}
          />
        </span>
      ) : null}
      <DiffFileCollapseChevron collapsed={isCollapsed} />
    </>
  );
  const { onBlameLine } = props;
  const commentAction = chatActions?.onCommentLine;
  const [commentTarget, setCommentTarget] = useState<DiffLineCommentTarget | null>(null);
  const gutterPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Recompute or drop an open box whenever the diff (and with it line positions) changes.
  useEffect(() => {
    setCommentTarget(null);
  }, [fileKey]);
  useEffect(() => {
    if (!commentTarget) return;
    const close = () => setCommentTarget(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [commentTarget]);
  const rememberGutterPointer = (event: ReactMouseEvent<HTMLDivElement>) => {
    gutterPointerRef.current = { x: event.clientX, y: event.clientY };
  };
  const handleGutterUtilityClick = (range: SelectedLineRange) => {
    if (!commentAction) return;
    const startLine = Math.min(range.start, range.end);
    const endLine = Math.max(range.start, range.end);
    const oldSide = range.side === "deletions";
    const width = Math.min(440, Math.max(280, window.innerWidth - 32));
    const maxLeft = Math.max(16, window.innerWidth - width - 16);
    const pointer = gutterPointerRef.current;
    const left = pointer ? Math.min(Math.max(pointer.x - 24, 16), maxLeft) : maxLeft / 2;
    const top = pointer
      ? Math.min(Math.max(pointer.y + 10, 16), Math.max(16, window.innerHeight - 240))
      : 120;
    setCommentTarget({ startLine, endLine, oldSide, left, top, width });
  };
  const handleLineClick = onBlameLine
    ? (line: DiffLineClickProps) => {
        // Deletion lines blame the tree that still has the content: for a
        // rename that is the old path, since the new name does not exist at
        // the blame revision.
        const blamePath =
          line.lineType === "change-deletion"
            ? (resolveFileDiffPrevPath(props.fileDiff) ?? filePath)
            : filePath;
        const target = resolveDiffLineBlameTarget(blamePath, line);
        if (target) onBlameLine(target);
      }
    : undefined;
  const handleClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    const nativeEvent = event.nativeEvent;
    const composedPath = nativeEvent.composedPath?.() ?? [];
    // Clicks on the per-file actions menu must not toggle collapse.
    const clickedHeaderMenu = composedPath.some(
      (node: EventTarget) => node instanceof Element && node.hasAttribute("data-diff-header-menu"),
    );
    if (clickedHeaderMenu) return;
    const clickedHeader = composedPath.some((node: EventTarget) => {
      if (!(node instanceof Element)) return false;
      return (
        node.hasAttribute("data-diff-file-header") ||
        node.hasAttribute("data-diffs-header") ||
        node.hasAttribute("data-file-info")
      );
    });
    if (!clickedHeader) return;
    event.stopPropagation();
    props.onToggleFileCollapsed(fileKey);
  };

  return (
    <div
      data-diff-file-path={filePath}
      className="diff-render-file mb-2 rounded-md first:mt-2 last:mb-0"
      onClickCapture={handleClickCapture}
      onPointerDownCapture={commentAction ? rememberGutterPointer : undefined}
    >
      <FileDiffCard
        fileDiff={props.fileDiff}
        theme={props.resolvedTheme}
        diffStyle={props.diffRenderMode === "split" ? "split" : "unified"}
        overflow={props.diffWordWrap ? "wrap" : "scroll"}
        collapsed={props.isCollapsed}
        renderHeaderTrailing={renderHeaderTrailing}
        onLineClick={handleLineClick}
        onGutterUtilityClick={commentAction ? handleGutterUtilityClick : undefined}
      />
      {commentTarget ? (
        // Fixed wrapper so the box stays viewport-anchored over the virtualized,
        // shadow-rooted diff surface; the box itself is absolutely positioned.
        <div
          style={{
            position: "fixed",
            left: commentTarget.left,
            top: commentTarget.top,
            width: commentTarget.width,
            zIndex: 50,
          }}
        >
          <FileLineCommentBox
            lineLabel={formatFileCommentRange({
              startLine: commentTarget.startLine,
              endLine: commentTarget.endLine,
            })}
            top={0}
            left={0}
            width={commentTarget.width}
            onCancel={() => setCommentTarget(null)}
            onSubmit={(text) => {
              if (!commentAction) return;
              const hunkContext = buildDiffCommentHunkContext(props.fileDiff, {
                start: commentTarget.startLine,
                end: commentTarget.endLine,
                side: commentTarget.oldSide ? "deletions" : "additions",
              });
              commentAction({
                path: filePath,
                startLine: commentTarget.startLine,
                endLine: commentTarget.endLine,
                text,
                ...(commentTarget.oldSide ? { side: "old" as const } : {}),
                ...(hunkContext ? { hunkContext } : {}),
                ...(props.reviewTarget ? { review: props.reviewTarget } : {}),
              });
              setCommentTarget(null);
            }}
          />
        </div>
      ) : null}
      {shouldPreviewImage ? (
        <LocalImagePreview
          src={filePath}
          cwd={props.workspaceRoot}
          alt={t("common:previewOf", { value0: filePath })}
          className="diff-render-file__image-preview"
          imageClassName="max-h-[320px]"
        />
      ) : null}
    </div>
  );
};

export const DiffPanelFileList = function DiffPanelFileList(props: {
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  workspaceRoot: string | null;
  collapsedFiles: ReadonlySet<string>;
  onToggleFileCollapsed: (fileKey: string) => void;
  chatActions?: DiffFileChatActions | undefined;
  reviewTarget?: FileCommentReviewTarget | undefined;
  onBlameLine?: ((target: DiffLineBlameTarget) => void) | undefined;
}) {
  const { t } = useTranslation();

  if (props.renderableFiles.length === 0) {
    return (
      <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
        <PanelStateMessage density="compact" fill="flex">
          <p>{t("common:editor_noFilesInDiff")}</p>
        </PanelStateMessage>
      </FileDiffSurface>
    );
  }

  return (
    <FileDiffSurface className="h-full min-h-0 overflow-auto px-2 pb-2">
      {props.renderableFiles.map((fileDiff) => {
        const fileKey = buildFileDiffRenderKey(fileDiff);
        // Include render mode so @pierre/diffs remounts when stacked ↔ split changes
        // (diffStyle is effectively mount-time config on FileDiff).
        const themedFileKey = `${fileKey}:${props.resolvedTheme}:${props.diffRenderMode}`;
        return (
          <DiffPanelFileRow
            key={themedFileKey}
            fileDiff={fileDiff}
            resolvedTheme={props.resolvedTheme}
            diffRenderMode={props.diffRenderMode}
            diffWordWrap={props.diffWordWrap}
            workspaceRoot={props.workspaceRoot}
            isCollapsed={props.collapsedFiles.has(fileKey)}
            onToggleFileCollapsed={props.onToggleFileCollapsed}
            chatActions={props.chatActions}
            reviewTarget={props.reviewTarget}
            onBlameLine={props.onBlameLine}
          />
        );
      })}
    </FileDiffSurface>
  );
};
