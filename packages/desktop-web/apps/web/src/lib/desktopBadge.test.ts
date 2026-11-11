import { describe, expect, it } from "vitest";

import { countDesktopBadgeThreads } from "./desktopBadge";

describe("countDesktopBadgeThreads", () => {
  it("counts pending approvals, input, plans, and dead sessions", () => {
    expect(
      countDesktopBadgeThreads([
        { hasPendingApprovals: true },
        { hasPendingUserInput: true },
        { hasActionableProposedPlan: true },
        { sessionStatus: "error" },
        { sessionStatus: "running" },
      ]),
    ).toBe(4);
  });

  it("ignores archived threads and subagent runs", () => {
    expect(
      countDesktopBadgeThreads([
        { hasPendingApprovals: true, archivedAt: "2026-01-01T00:00:00.000Z" },
        { hasPendingApprovals: true, parentThreadId: "parent" },
        {},
      ]),
    ).toBe(0);
  });
});
