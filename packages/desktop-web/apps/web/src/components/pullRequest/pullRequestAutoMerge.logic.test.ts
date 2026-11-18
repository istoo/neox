import { describe, expect, it } from "vitest";

import {
  EMPTY_AUTO_MERGE_ACTIONS,
  resolvePullRequestAutoMergeActions,
  type PullRequestAutoMergeCapability,
} from "./pullRequestAutoMerge.logic";

const base: PullRequestAutoMergeCapability = {
  state: "open",
  isDraft: false,
  mergeBlocker: null,
  allowedMethods: ["merge", "squash", "rebase"],
  autoMergeEnabled: false,
  canEnableAutoMerge: true,
  canDisableAutoMerge: false,
};

describe("resolvePullRequestAutoMergeActions", () => {
  it("offers every allowed method while auto-merge is off", () => {
    expect(resolvePullRequestAutoMergeActions(base)).toEqual({
      enableMethods: ["merge", "squash", "rebase"],
      disable: false,
    });
  });

  it("offers only disabling once auto-merge is enabled", () => {
    expect(
      resolvePullRequestAutoMergeActions({
        ...base,
        autoMergeEnabled: true,
        canEnableAutoMerge: false,
        canDisableAutoMerge: true,
      }),
    ).toEqual({ enableMethods: [], disable: true });
  });

  it.each([
    ["a draft", { isDraft: true }],
    ["a closed pull request", { state: "closed" as const }],
    ["a merged pull request", { state: "merged" as const }],
    ["a blocked merge", { mergeBlocker: "Conflicts" }],
    ["a forge that cannot enable it", { canEnableAutoMerge: false }],
    ["no allowed merge methods", { allowedMethods: [] }],
  ])("offers nothing for %s", (_label, patch) => {
    expect(resolvePullRequestAutoMergeActions({ ...base, ...patch })).toEqual(
      EMPTY_AUTO_MERGE_ACTIONS,
    );
  });
});
