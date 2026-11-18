import { describe, expect, it } from "vitest";

import { parseDirtyWorktreeError } from "./BranchToolbarBranchSelector";

describe("parseDirtyWorktreeError", () => {
  it("recognizes the daemon's dirty-tree rejection without a file list", () => {
    const error = new Error(
      "Working directory has uncommitted changes. Commit or stash before switching branches.",
    );

    expect(parseDirtyWorktreeError(error, "main")).toEqual({ branch: "main", files: [] });
  });

  it("reads the branch and files from the localized bridge error", () => {
    const error = {
      message: "Uncommitted changes block switch to main.",
      code: "neolix.error.git.checkout-blocked-by-changes",
      params: { branch: "main", files: "src/a.ts, src/b.ts" },
    };

    expect(parseDirtyWorktreeError(error, "fallback")).toEqual({
      branch: "main",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("ignores unrelated errors", () => {
    expect(parseDirtyWorktreeError(new Error("fatal: not a git repository"), "main")).toBeNull();
    expect(
      parseDirtyWorktreeError(new Error("Working directory has uncommitted changes.")),
    ).toBeNull();
  });
});
