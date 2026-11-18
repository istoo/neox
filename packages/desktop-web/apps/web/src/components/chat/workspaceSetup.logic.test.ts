import type { WorkspaceSetupSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  formatSetupDuration,
  processSetupCarriageReturns,
  setupAutoExpandIndex,
  setupCommandIsExpandable,
  setupHasNoCommands,
  setupStatusLabel,
} from "./workspaceSetup.logic";

function snapshot(
  status: WorkspaceSetupSnapshot["status"],
  commands: WorkspaceSetupSnapshot["detail"]["commands"],
): WorkspaceSetupSnapshot {
  return {
    status,
    error: null,
    detail: {
      type: "worktree_setup",
      worktreePath: "/repo/wt",
      branchName: "feature",
      log: "",
      commands,
    },
  };
}

const running = {
  index: 1,
  command: "bun install",
  status: "running" as const,
  log: "installing",
};
const completed = {
  index: 2,
  command: "bun run build",
  status: "completed" as const,
  log: "done",
};

describe("workspaceSetup.logic", () => {
  it("keeps only the final carriage-return frame per line", () => {
    expect(processSetupCarriageReturns("download 10%\rdownload 55%\rdownload 100%\nnext")).toBe(
      "download 100%\nnext",
    );
    expect(processSetupCarriageReturns("plain text")).toBe("plain text");
  });

  it("formats setup durations", () => {
    expect(formatSetupDuration(250)).toBe("250ms");
    expect(formatSetupDuration(12_000)).toBe("12s");
    expect(formatSetupDuration(125_000)).toBe("2m 5s");
  });

  it("labels an absent snapshot as waiting and otherwise mirrors the daemon status", () => {
    expect(setupStatusLabel(null)).toBe("waiting");
    expect(setupStatusLabel(snapshot("running", []))).toBe("running");
    expect(setupStatusLabel(snapshot("failed", []))).toBe("failed");
  });

  it("auto-expands the running command, else the last command", () => {
    expect(setupAutoExpandIndex(snapshot("running", [running, completed]))).toBe(1);
    expect(setupAutoExpandIndex(snapshot("completed", [completed]))).toBe(2);
    expect(setupAutoExpandIndex(null)).toBeNull();
  });

  it("recognizes a completed workspace with no setup commands", () => {
    expect(setupHasNoCommands(snapshot("completed", []))).toBe(true);
    expect(setupHasNoCommands(snapshot("completed", [completed]))).toBe(false);
    expect(setupHasNoCommands(null)).toBe(false);
  });

  it("only makes a running command expandable once it has output", () => {
    expect(setupCommandIsExpandable(running)).toBe(true);
    expect(setupCommandIsExpandable({ ...running, log: "" })).toBe(false);
    expect(setupCommandIsExpandable(completed)).toBe(true);
  });
});
