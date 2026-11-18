import { describe, expect, it } from "vitest";

import { toPullRequestDetail, type NeolixPrStatus } from "./prTranslate.ts";

function status(forgeSpecific?: NeolixPrStatus["forgeSpecific"]): NeolixPrStatus {
  return {
    forge: "gitlab",
    number: 12,
    url: "https://gitlab.example.com/team/app/-/merge_requests/12",
    title: "Ship it",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "feature",
    isMerged: false,
    repoOwner: "team",
    repoName: "app",
    ...(forgeSpecific ? { forgeSpecific } : {}),
  };
}

const context = {
  projectId: "prj_1",
  projectTitle: "app",
  workspaceRoot: "/repo/app",
  repository: "team/app",
  now: "2026-11-14T00:00:00.000Z",
};

describe("toPullRequestDetail approvals", () => {
  it("carries GitLab's approval counts", () => {
    const detail = toPullRequestDetail(
      status({ approvalsRequired: 2, approvalsGiven: 1 }),
      null,
      context,
    );
    expect(detail.approvals).toEqual({ given: 1, required: 2 });
  });

  it("reads a missing or empty rule as no approvals", () => {
    expect(toPullRequestDetail(status(), null, context).approvals).toBeNull();
    expect(
      toPullRequestDetail(status({ approvalsRequired: 0, approvalsGiven: 0 }), null, context)
        .approvals,
    ).toBeNull();
  });
});
