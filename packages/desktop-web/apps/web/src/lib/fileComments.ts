// FILE: fileComments.ts
// Purpose: Normalize, serialize, and parse inline "Local comment" requests that
//          the file viewer attaches to a thread's composer draft and prompt.
// Layer: Chat composer and transcript helpers

import type { ChatReviewAttachment } from "@synara/contracts";

import { t } from "~/i18n";

import { randomUUID } from "./utils";

// Inline comments authored against a file/line range in the editor gutter. They
// live on the composer draft like terminal contexts (not wire attachments) and
// are serialized into a trailing <file_comments> prompt block on send.
export const FILE_COMMENT_TEXT_MAX_CHARS = 4_000;

const TRAILING_FILE_COMMENTS_PATTERN = /\n*<file_comments>\n([\s\S]*?)\n<\/file_comments>\s*$/;
const FILE_COMMENT_HEADER_PATTERN = /^- (.+?) (?:line (\d+)|lines (\d+)-(\d+)):$/;

export type FileCommentReviewMode = "uncommitted" | "base" | "all";

/** Diff scope a comment was authored against, used to build the review attachment. */
export interface FileCommentReviewTarget {
  cwd: string;
  mode: FileCommentReviewMode;
  baseRef?: string | null;
}

export interface FileCommentSelection {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Which version the line numbers refer to. Diff comments on removed lines use "old". */
  side?: "old" | "new";
  /**
   * Unified-diff hunk around the commented lines (header + a few surrounding lines).
   * Diff views attach it so a review comment survives the file changing underneath it.
   */
  hunkContext?: string;
  /** Set by diff views: the checkout and comparison the hunk belongs to. */
  review?: FileCommentReviewTarget;
}

export interface FileCommentDraft extends FileCommentSelection {
  id: string;
}

export interface ParsedFileCommentEntry {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface ExtractedFileComments {
  promptText: string;
  comments: ParsedFileCommentEntry[];
}

export type FileCommentValidationError = "empty" | "too-long";

export function normalizeFileCommentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
}

function normalizeLineRange(
  startLine: number,
  endLine: number,
): { startLine: number; endLine: number } {
  const start = Math.max(1, Math.floor(startLine));
  const end = Math.max(start, Math.floor(endLine));
  return { startLine: start, endLine: end };
}

export function getFileCommentValidationError(
  comment: Pick<FileCommentSelection, "path" | "text">,
): FileCommentValidationError | null {
  const path = comment.path.trim();
  const text = normalizeFileCommentText(comment.text);
  if (path.length === 0 || text.length === 0) {
    return "empty";
  }
  if (text.length > FILE_COMMENT_TEXT_MAX_CHARS) {
    return "too-long";
  }
  return null;
}

function normalizeReviewTarget(value: unknown): FileCommentReviewTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const cwd = typeof candidate.cwd === "string" ? candidate.cwd.trim() : "";
  const mode = candidate.mode;
  if (cwd.length === 0 || (mode !== "uncommitted" && mode !== "base" && mode !== "all")) {
    return undefined;
  }
  const rawBaseRef = candidate.baseRef;
  const baseRef =
    rawBaseRef === null
      ? null
      : typeof rawBaseRef === "string" && rawBaseRef.trim().length > 0
        ? rawBaseRef.trim()
        : undefined;
  return {
    cwd,
    mode,
    ...(baseRef !== undefined ? { baseRef } : {}),
  };
}

export function normalizeFileCommentSelection(
  selection: FileCommentSelection,
): FileCommentSelection | null {
  if (getFileCommentValidationError(selection)) {
    return null;
  }
  const { startLine, endLine } = normalizeLineRange(selection.startLine, selection.endLine);
  const hunkContext = typeof selection.hunkContext === "string" ? selection.hunkContext.trim() : "";
  const review = normalizeReviewTarget(selection.review);
  return {
    path: selection.path.trim(),
    startLine,
    endLine,
    text: normalizeFileCommentText(selection.text),
    ...(selection.side ? { side: selection.side } : {}),
    ...(hunkContext.length > 0 ? { hunkContext } : {}),
    ...(review ? { review } : {}),
  };
}

export function createFileCommentDraft(selection: FileCommentSelection): FileCommentDraft | null {
  const normalized = normalizeFileCommentSelection(selection);
  if (!normalized) {
    return null;
  }
  return {
    id: randomUUID(),
    ...normalized,
  };
}

export function formatFileCommentRange(selection: { startLine: number; endLine: number }): string {
  return selection.startLine === selection.endLine
    ? t("chat:singleLine", { line: selection.startLine })
    : t("chat:lineRange", { start: selection.startLine, end: selection.endLine });
}

export function formatFileCommentLabel(selection: {
  path: string;
  startLine: number;
  endLine: number;
}): string {
  return `${selection.path} ${formatFileCommentRange(selection)}`;
}

export function formatFileCommentTitleSeed(commentCount: number): string {
  return t("chat:fileCommentTitle", { count: commentCount });
}

export function buildFileCommentsPromptBlock(
  comments: ReadonlyArray<FileCommentSelection>,
): string {
  const normalizedComments = comments
    .map((comment) => normalizeFileCommentSelection(comment))
    .filter((comment): comment is FileCommentSelection => comment !== null);
  if (normalizedComments.length === 0) {
    return "";
  }

  const lines: string[] = [];
  for (let index = 0; index < normalizedComments.length; index += 1) {
    const comment = normalizedComments[index]!;
    const sideSuffix = comment.side === "old" ? ` ${t("chat:removedLine")}` : "";
    lines.push(`- ${formatFileCommentLabel(comment)}${sideSuffix}:`);
    for (const line of comment.text.split("\n")) {
      lines.push(`  ${line}`);
    }
    if (comment.hunkContext) {
      // Fenced so the agent reads the surrounding code as code, not as more comment text.
      lines.push("  ```diff");
      for (const line of comment.hunkContext.split("\n")) {
        lines.push(`  ${line}`);
      }
      lines.push("  ```");
    }
    if (index < normalizedComments.length - 1) {
      lines.push("");
    }
  }
  return ["<file_comments>", ...lines, "</file_comments>"].join("\n");
}

export function appendFileCommentsToPrompt(
  prompt: string,
  comments: ReadonlyArray<FileCommentSelection>,
): string {
  const trimmedPrompt = prompt.trim();
  const block = buildFileCommentsPromptBlock(comments);
  if (block.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${block}` : block;
}

export function extractTrailingFileComments(prompt: string): ExtractedFileComments {
  const match = TRAILING_FILE_COMMENTS_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      comments: [],
    };
  }
  return {
    promptText: prompt.slice(0, match.index).replace(/\n+$/, ""),
    comments: parseFileCommentEntries(match[1] ?? ""),
  };
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface ParsedReviewLine {
  oldLineNumber: number | null;
  newLineNumber: number | null;
  type: "add" | "remove" | "context";
  content: string;
}

/**
 * Rebuild the structured daemon review context from the unified-diff excerpt
 * stored on a comment. The excerpt is produced by the diff renderer itself, so
 * parsing it keeps the persisted draft compact while preserving exact line
 * numbers and whether each line was added, removed, or context.
 */
export function parseReviewContextFromHunk(input: {
  readonly hunkContext: string;
  readonly startLine: number;
  readonly side: "old" | "new";
}): {
  readonly hunkHeader: string;
  readonly targetLine: ParsedReviewLine;
  readonly lines: readonly ParsedReviewLine[];
} | null {
  const rows = input.hunkContext.split("\n");
  const header = rows[0] ?? "";
  const match = HUNK_HEADER_PATTERN.exec(header);
  if (!match) return null;

  let oldLine = Number.parseInt(match[1]!, 10);
  let newLine = Number.parseInt(match[3]!, 10);
  const lines: ParsedReviewLine[] = [];
  for (const row of rows.slice(1)) {
    if (row.startsWith("\\")) continue; // "\ No newline at end of file"
    const prefix = row[0];
    const content = row.slice(1);
    if (prefix === "+") {
      lines.push({ oldLineNumber: null, newLineNumber: newLine, type: "add", content });
      newLine += 1;
    } else if (prefix === "-") {
      lines.push({ oldLineNumber: oldLine, newLineNumber: null, type: "remove", content });
      oldLine += 1;
    } else if (prefix === " " || prefix === "") {
      lines.push({
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        type: "context",
        content,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  const targetLine = lines.find((line) =>
    input.side === "old"
      ? line.oldLineNumber === input.startLine
      : line.newLineNumber === input.startLine,
  ) ?? {
    oldLineNumber: input.side === "old" ? input.startLine : null,
    newLineNumber: input.side === "old" ? null : input.startLine,
    type: "context" as const,
    // The excerpt no longer contains the line (file changed under the comment).
    content: "",
  };

  return { hunkHeader: header, targetLine, lines };
}

/**
 * Split composer comments into daemon review attachments and the comments that
 * still need the legacy `<file_comments>` prompt block. Only diff-authored
 * comments carry a review scope; plain file comments keep the text path.
 */
export function splitFileCommentsForReview(comments: ReadonlyArray<FileCommentSelection>): {
  readonly reviewAttachments: readonly ChatReviewAttachment[];
  readonly remaining: readonly FileCommentSelection[];
} {
  const remaining: FileCommentSelection[] = [];
  const groups = new Map<
    string,
    {
      target: FileCommentReviewTarget;
      comments: Array<ChatReviewAttachment["comments"][number]>;
    }
  >();

  for (const selection of comments) {
    const comment = normalizeFileCommentSelection(selection);
    if (!comment) continue;
    const target = comment.review;
    const context =
      target && comment.hunkContext
        ? parseReviewContextFromHunk({
            hunkContext: comment.hunkContext,
            startLine: comment.startLine,
            side: comment.side === "old" ? "old" : "new",
          })
        : null;
    if (!target || !context) {
      remaining.push(comment);
      continue;
    }
    const key = `${target.cwd}\u0000${target.mode}\u0000${target.baseRef ?? ""}`;
    const group = groups.get(key) ?? { target, comments: [] };
    group.comments.push({
      filePath: comment.path,
      side: comment.side === "old" ? "old" : "new",
      lineNumber: comment.startLine,
      body: comment.text,
      context,
    });
    groups.set(key, group);
  }

  const reviewAttachments = [...groups.values()].map(({ target, comments }) => ({
    type: "review" as const,
    id: randomUUID(),
    cwd: target.cwd,
    mode: target.mode,
    ...(target.baseRef !== undefined ? { baseRef: target.baseRef } : {}),
    comments,
  }));
  return { reviewAttachments, remaining };
}

function parseFileCommentEntries(block: string): ParsedFileCommentEntry[] {
  const entries: ParsedFileCommentEntry[] = [];
  let current: {
    path: string;
    startLine: number;
    endLine: number;
    lines: string[];
  } | null = null;

  const commitCurrent = () => {
    if (!current) return;
    const text = current.lines.join("\n").trimEnd();
    if (text.length > 0) {
      entries.push({
        path: current.path,
        startLine: current.startLine,
        endLine: current.endLine,
        text,
      });
    }
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = FILE_COMMENT_HEADER_PATTERN.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      const single = headerMatch[2];
      const startLine = single ? Number(single) : Number(headerMatch[3]);
      const endLine = single ? Number(single) : Number(headerMatch[4]);
      current = {
        path: headerMatch[1]!.trim(),
        startLine,
        endLine,
        lines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.lines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.lines.push("");
    }
  }

  commitCurrent();
  return entries;
}
