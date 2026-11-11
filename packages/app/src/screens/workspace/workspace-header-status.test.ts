import { describe, expect, it } from "vitest";
import { resolveWorkspaceHeaderStatus } from "./workspace-header-status";

describe("resolveWorkspaceHeaderStatus", () => {
  it("maps a running agent to the working label", () => {
    expect(resolveWorkspaceHeaderStatus("running")).toEqual({
      tone: "running",
      labelKey: "sidebar.statusBucket.working",
    });
  });

  it("keeps error distinct from idle", () => {
    expect(resolveWorkspaceHeaderStatus("error")).toEqual({
      tone: "error",
      labelKey: "agentList.status.error",
    });
    expect(resolveWorkspaceHeaderStatus("idle")).toEqual({
      tone: "idle",
      labelKey: "agentList.status.idle",
    });
  });

  it("returns nothing without a known lifecycle status", () => {
    expect(resolveWorkspaceHeaderStatus(null)).toBeNull();
    expect(resolveWorkspaceHeaderStatus(undefined)).toBeNull();
    expect(resolveWorkspaceHeaderStatus("unknown")).toBeNull();
  });
});
