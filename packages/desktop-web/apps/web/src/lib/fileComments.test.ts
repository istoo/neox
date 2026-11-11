import { describe, expect, it } from "vitest";

import {
  appendFileCommentsToPrompt,
  buildFileCommentsPromptBlock,
  createFileCommentDraft,
  extractTrailingFileComments,
  FILE_COMMENT_TEXT_MAX_CHARS,
  getFileCommentValidationError,
  normalizeFileCommentSelection,
  parseReviewContextFromHunk,
  splitFileCommentsForReview,
  type FileCommentSelection,
} from "./fileComments";

function makeSelection(overrides?: Partial<FileCommentSelection>): FileCommentSelection {
  return {
    path: "src/app.ts",
    startLine: 12,
    endLine: 12,
    text: "rename this helper",
    ...overrides,
  };
}

describe("fileComments", () => {
  it("validates path and text presence and length", () => {
    expect(getFileCommentValidationError(makeSelection())).toBeNull();
    expect(getFileCommentValidationError(makeSelection({ text: "   " }))).toBe("empty");
    expect(getFileCommentValidationError(makeSelection({ path: "  " }))).toBe("empty");
    expect(
      getFileCommentValidationError(
        makeSelection({ text: "x".repeat(FILE_COMMENT_TEXT_MAX_CHARS + 1) }),
      ),
    ).toBe("too-long");
  });

  it("normalizes a selection: trims path, clamps/orders lines, normalizes text", () => {
    expect(
      normalizeFileCommentSelection({
        path: "  src/app.ts  ",
        startLine: 9.8,
        endLine: 3,
        text: "  fix\r\nthis  ",
      }),
    ).toEqual({
      path: "src/app.ts",
      startLine: 9,
      endLine: 9,
      text: "fix\nthis",
    });
    expect(normalizeFileCommentSelection(makeSelection({ text: "" }))).toBeNull();
  });

  it("clamps a sub-1 start line up to 1 and keeps the end at/after the start", () => {
    expect(normalizeFileCommentSelection(makeSelection({ startLine: 0, endLine: 0 }))).toEqual({
      path: "src/app.ts",
      startLine: 1,
      endLine: 1,
      text: "rename this helper",
    });
  });

  it("creates a draft with an id from a valid selection only", () => {
    const draft = createFileCommentDraft(makeSelection({ startLine: 3, endLine: 5 }));
    expect(draft).not.toBeNull();
    expect(draft?.id).toBeTypeOf("string");
    expect(draft?.id.length).toBeGreaterThan(0);
    expect(draft).toMatchObject({
      path: "src/app.ts",
      startLine: 3,
      endLine: 5,
      text: "rename this helper",
    });
    expect(createFileCommentDraft(makeSelection({ text: "  " }))).toBeNull();
  });

  it("builds a numbered prompt block and skips invalid entries", () => {
    expect(
      buildFileCommentsPromptBlock([
        makeSelection({ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" }),
        makeSelection({ path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" }),
      ]),
    ).toBe(
      [
        "<file_comments>",
        "- src/app.ts lines 3-5:",
        "  rename helper",
        "",
        "- src/util.ts line 8:",
        "  guard null",
        "  here",
        "</file_comments>",
      ].join("\n"),
    );
    expect(buildFileCommentsPromptBlock([makeSelection({ text: "" })])).toBe("");
  });

  it("serializes a diff comment's side and hunk context as a fence", () => {
    expect(
      buildFileCommentsPromptBlock([
        makeSelection({
          startLine: 4,
          endLine: 4,
          text: "keep this branch",
          side: "old",
          hunkContext: "@@ -2,4 +2,4 @@ run\n  before();\n-  old();\n+  next();\n  after();",
        }),
      ]),
    ).toBe(
      [
        "<file_comments>",
        "- src/app.ts line 4 (removed line):",
        "  keep this branch",
        "  ```diff",
        "  @@ -2,4 +2,4 @@ run",
        "    before();",
        "  -  old();",
        "  +  next();",
        "    after();",
        "  ```",
        "</file_comments>",
      ].join("\n"),
    );
  });

  it("appends the block after prompt text, or returns the bare block/prompt", () => {
    expect(appendFileCommentsToPrompt("Investigate this", [makeSelection()])).toBe(
      [
        "Investigate this",
        "",
        "<file_comments>",
        "- src/app.ts line 12:",
        "  rename this helper",
        "</file_comments>",
      ].join("\n"),
    );
    expect(appendFileCommentsToPrompt("Investigate this", [])).toBe("Investigate this");
    expect(appendFileCommentsToPrompt("", [makeSelection()])).toBe(
      ["<file_comments>", "- src/app.ts line 12:", "  rename this helper", "</file_comments>"].join(
        "\n",
      ),
    );
  });

  it("extracts trailing file comments and the leading prompt text", () => {
    const prompt = appendFileCommentsToPrompt("Investigate this", [
      makeSelection({ path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" }),
      makeSelection({ path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" }),
    ]);
    expect(extractTrailingFileComments(prompt)).toEqual({
      promptText: "Investigate this",
      comments: [
        { path: "src/app.ts", startLine: 3, endLine: 5, text: "rename helper" },
        { path: "src/util.ts", startLine: 8, endLine: 8, text: "guard null\nhere" },
      ],
    });
  });
});

const HUNK = ["@@ -10,3 +10,4 @@ function run() {", " context", "-old", "+new", "+added"].join(
  "\n",
);

describe("review attachments", () => {
  it("rebuilds line numbers and line kinds from the stored hunk excerpt", () => {
    const parsed = parseReviewContextFromHunk({ hunkContext: HUNK, startLine: 11, side: "new" });
    expect(parsed?.hunkHeader).toBe("@@ -10,3 +10,4 @@ function run() {");
    expect(parsed?.targetLine).toEqual({
      oldLineNumber: null,
      newLineNumber: 11,
      type: "add",
      content: "new",
    });
    expect(parsed?.lines).toEqual([
      { oldLineNumber: 10, newLineNumber: 10, type: "context", content: "context" },
      { oldLineNumber: 11, newLineNumber: null, type: "remove", content: "old" },
      { oldLineNumber: null, newLineNumber: 11, type: "add", content: "new" },
      { oldLineNumber: null, newLineNumber: 12, type: "add", content: "added" },
    ]);
  });

  it("falls back to a synthetic target when the excerpt no longer has the line", () => {
    const parsed = parseReviewContextFromHunk({ hunkContext: HUNK, startLine: 99, side: "new" });
    expect(parsed?.targetLine).toEqual({
      oldLineNumber: null,
      newLineNumber: 99,
      type: "context",
      content: "",
    });
  });

  it("groups diff comments into one review attachment and keeps plain comments as text", () => {
    const result = splitFileCommentsForReview([
      makeSelection({
        startLine: 11,
        endLine: 11,
        text: "split this",
        side: "new",
        hunkContext: HUNK,
        review: { cwd: "/repo", mode: "uncommitted" },
      }),
      makeSelection({
        path: "src/other.ts",
        startLine: 20,
        text: "guard this",
        hunkContext: HUNK,
        review: { cwd: "/repo", mode: "uncommitted" },
      }),
      makeSelection({ path: "src/plain.ts", startLine: 1, text: "plain file comment" }),
    ]);

    expect(result.reviewAttachments).toHaveLength(1);
    expect(result.reviewAttachments[0]).toMatchObject({
      type: "review",
      cwd: "/repo",
      mode: "uncommitted",
    });
    expect(result.reviewAttachments[0]?.id).toBeTruthy();
    expect(result.reviewAttachments[0]?.comments.map((comment) => comment.filePath)).toEqual([
      "src/app.ts",
      "src/other.ts",
    ]);
    expect(result.remaining.map((comment) => comment.path)).toEqual(["src/plain.ts"]);
    expect(appendFileCommentsToPrompt("", result.remaining)).toContain("plain file comment");
  });

  it("separates reviews authored against different comparisons", () => {
    const result = splitFileCommentsForReview([
      makeSelection({
        hunkContext: HUNK,
        side: "new",
        startLine: 11,
        review: { cwd: "/repo", mode: "uncommitted" },
      }),
      makeSelection({
        hunkContext: HUNK,
        side: "new",
        startLine: 11,
        review: { cwd: "/repo", mode: "base", baseRef: "main" },
      }),
    ]);

    expect(result.reviewAttachments.map((attachment) => attachment.mode)).toEqual([
      "uncommitted",
      "base",
    ]);
    expect(result.reviewAttachments[1]?.baseRef).toBe("main");
  });
});
