import { describe, expect, it } from "vitest";
import { resolveWorkspaceTrailingStatus } from "@/components/sidebar/sidebar-workspace-status-trailing";

describe("resolveWorkspaceTrailingStatus", () => {
  it("surfaces a needs-input row as an amber badge", () => {
    expect(resolveWorkspaceTrailingStatus("needs_input")).toEqual({
      kind: "badge",
      variant: "warning",
    });
  });

  it("surfaces failed and ready-to-review rows with their own badge variants", () => {
    expect(resolveWorkspaceTrailingStatus("failed")).toEqual({ kind: "badge", variant: "error" });
    expect(resolveWorkspaceTrailingStatus("attention")).toEqual({
      kind: "badge",
      variant: "success",
    });
  });

  it("treats running as the spinner and text, not a badge", () => {
    expect(resolveWorkspaceTrailingStatus("running")).toEqual({ kind: "running" });
  });

  it("stays silent for idle rows", () => {
    expect(resolveWorkspaceTrailingStatus("done")).toEqual({ kind: "none" });
  });
});
