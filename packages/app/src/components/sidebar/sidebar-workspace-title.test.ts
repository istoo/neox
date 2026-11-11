import { i18n } from "@/i18n/i18next";
import { describe, expect, it } from "vitest";
import {
  resolveSidebarWorkspaceAccessibilityLabel,
  resolveSidebarWorkspaceDisambiguator,
  resolveSidebarWorkspacePrimaryLabel,
} from "@/components/sidebar/sidebar-workspace-title";

describe("resolveSidebarWorkspacePrimaryLabel", () => {
  it("uses the workspace name in title mode", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search" },
      workspaceTitleSource: "title",
    });

    expect(label).toBe("Investigate search");
  });

  it("uses the branch name in branch mode", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search" },
      workspaceTitleSource: "branch",
    });

    expect(label).toBe("fix/search");
  });

  it("falls back to the workspace name in branch mode without a branch", () => {
    const label = resolveSidebarWorkspacePrimaryLabel({
      workspace: { name: "Local folder", currentBranch: null },
      workspaceTitleSource: "branch",
    });

    expect(label).toBe("Local folder");
  });
});

describe("resolveSidebarWorkspaceDisambiguator", () => {
  it("uses the name's suffix while titles show names", () => {
    expect(
      resolveSidebarWorkspaceDisambiguator({
        workspace: {
          currentBranch: "main",
          nameDisambiguator: "~/alpha",
          branchDisambiguator: "main",
        },
        workspaceTitleSource: "title",
      }),
    ).toBe("~/alpha");
  });

  it("uses the branch's suffix while titles show branches", () => {
    expect(
      resolveSidebarWorkspaceDisambiguator({
        workspace: {
          currentBranch: "feature",
          nameDisambiguator: "~/alpha",
          branchDisambiguator: "alpha",
        },
        workspaceTitleSource: "branch",
      }),
    ).toBe("alpha");
  });

  it("falls back to the name's suffix for a branch-titled row with no branch", () => {
    expect(
      resolveSidebarWorkspaceDisambiguator({
        workspace: {
          currentBranch: null,
          nameDisambiguator: "~/alpha",
          branchDisambiguator: null,
        },
        workspaceTitleSource: "branch",
      }),
    ).toBe("~/alpha");
  });
});

describe("resolveSidebarWorkspaceAccessibilityLabel", () => {
  it("includes the visible host badge with the workspace title", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search", statusBucket: "done" },
      workspaceTitleSource: "title",
      hostBadgeLabel: "Build host",
      t: i18n.t,
    });

    expect(label).toBe("Investigate search, Build host");
  });

  it("owns every visual row contributor in one accessible label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: {
        name: "Investigate search",
        currentBranch: "fix/search",
        statusBucket: "running",
      },
      workspaceTitleSource: "branch",
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
      pullRequestLabel: "Pull request 42",
      serviceLabel: "Service web running",
      t: i18n.t,
    });

    expect(label).toBe(
      "Search project, fix/search, Build host, Pull request 42, Service web running, Working",
    );
  });

  it("omits the idle status from the workspace label", () => {
    const label = resolveSidebarWorkspaceAccessibilityLabel({
      workspace: { name: "Investigate search", currentBranch: "fix/search", statusBucket: "done" },
      workspaceTitleSource: "title",
      leadingProjectName: "Search project",
      hostBadgeLabel: "Build host",
      t: i18n.t,
    });

    expect(label).toBe("Search project, Investigate search, Build host");
  });
});
