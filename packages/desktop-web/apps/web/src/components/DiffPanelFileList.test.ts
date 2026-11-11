import type { FileDiffMetadata } from "@pierre/diffs/react";
import { describe, expect, it } from "vitest";

import { parseReviewContextFromHunk } from "~/lib/fileComments";
import { buildDiffCommentHunkContext } from "./DiffPanelFileList";

// The renderer stores plain file lines with their trailing newline; the excerpt supplies
// the unified-diff prefix and must not duplicate the newline.
const FILE_DIFF = {
  type: "change",
  hunks: [
    {
      additionStart: 1,
      additionCount: 4,
      additionLines: 1,
      additionLineIndex: 0,
      deletionStart: 1,
      deletionCount: 4,
      deletionLines: 1,
      deletionLineIndex: 0,
      hunkContent: [
        { type: "context", lines: 2, additionLineIndex: 0, deletionLineIndex: 0 },
        { type: "change", deletions: 1, deletionLineIndex: 2, additions: 1, additionLineIndex: 2 },
        { type: "context", lines: 1, additionLineIndex: 3, deletionLineIndex: 3 },
      ],
      hunkSpecs: "@@ -1,4 +1,4 @@ function f()",
    },
  ],
  additionLines: ["aaa\n", "bbb\n", "ccc2\n", "ddd\n"],
  deletionLines: ["aaa\n", "bbb\n", "ccc\n", "ddd\n"],
} as unknown as FileDiffMetadata;

describe("buildDiffCommentHunkContext", () => {
  it("quotes the hunk around a new-side line without duplicating prefixes", () => {
    expect(buildDiffCommentHunkContext(FILE_DIFF, { start: 3, end: 3, side: "additions" })).toBe(
      ["@@ -1,4 +1,4 @@ function f()", " aaa", " bbb", "-ccc", "+ccc2", " ddd"].join("\n"),
    );
  });

  it("uses the old-side line numbers for removed lines", () => {
    expect(buildDiffCommentHunkContext(FILE_DIFF, { start: 3, end: 3, side: "deletions" })).toBe(
      ["@@ -1,4 +1,4 @@ function f()", " aaa", " bbb", "-ccc", "+ccc2", " ddd"].join("\n"),
    );
  });

  it("numbers the excerpt independently so later lines keep their real numbers", () => {
    const longDiff = {
      type: "change",
      hunks: [
        {
          additionStart: 1,
          additionCount: 15,
          additionLines: 15,
          additionLineIndex: 0,
          deletionStart: 1,
          deletionCount: 15,
          deletionLines: 15,
          deletionLineIndex: 0,
          hunkContent: [{ type: "context", lines: 15, additionLineIndex: 0, deletionLineIndex: 0 }],
        },
      ],
      additionLines: Array.from({ length: 15 }, (_, index) => `line ${index + 1}\n`),
      deletionLines: Array.from({ length: 15 }, (_, index) => `line ${index + 1}\n`),
    } as unknown as FileDiffMetadata;

    const hunkContext = buildDiffCommentHunkContext(longDiff, {
      start: 10,
      end: 10,
      side: "additions",
    });
    expect(hunkContext?.split("\n")[0]).toBe("@@ -7,7 +7,7 @@");
    const parsed = parseReviewContextFromHunk({
      hunkContext: hunkContext!,
      startLine: 10,
      side: "new",
    });
    expect(parsed?.targetLine).toEqual({
      oldLineNumber: 10,
      newLineNumber: 10,
      type: "context",
      content: "line 10",
    });
  });

  it("returns null outside every hunk", () => {
    expect(buildDiffCommentHunkContext(FILE_DIFF, { start: 40, end: 40, side: "additions" })).toBe(
      null,
    );
  });
});
