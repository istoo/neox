import type { AgentSkillOperation, AgentSkillsStatus } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  areSkillsInstalled,
  formatUpdateMessage,
  hasSelectedSkills,
  isSkillSelected,
  maintenanceOperations,
  needsSkillUpdate,
  toggleAllSelection,
  toggleSkillSelection,
} from "./agentSkills.logic";

const t = (key: string) => `t:${key}`;

function status(overrides: Partial<AgentSkillsStatus> = {}): AgentSkillsStatus {
  return {
    state: "up-to-date",
    ops: [],
    available: ["orchestration", "review"],
    installed: ["orchestration", "review"],
    selection: { mode: "all" },
    ...overrides,
  };
}

function op(kind: AgentSkillOperation["kind"], name: string): AgentSkillOperation {
  return { kind, name };
}

describe("installed state", () => {
  it("counts anything but not-installed as installed", () => {
    expect(areSkillsInstalled(null)).toBe(false);
    expect(areSkillsInstalled(status({ state: "not-installed" }))).toBe(false);
    expect(areSkillsInstalled(status({ state: "drift" }))).toBe(true);
    expect(areSkillsInstalled(status())).toBe(true);
  });
});

describe("saved selection", () => {
  it("treats `all` as selected only when the host bundles something", () => {
    expect(hasSelectedSkills(null)).toBe(false);
    expect(hasSelectedSkills(status({ available: [] }))).toBe(false);
    expect(hasSelectedSkills(status())).toBe(true);
  });

  it("ignores custom names the host does not bundle", () => {
    expect(hasSelectedSkills(status({ selection: { mode: "custom", skills: ["gone"] } }))).toBe(
      false,
    );
    expect(
      hasSelectedSkills(status({ selection: { mode: "custom", skills: ["gone", "review"] } })),
    ).toBe(true);
  });
});

describe("update offer", () => {
  it("offers only add/update work, never deletions", () => {
    const ops = [op("delete", "old"), op("add", "new"), op("update", "review")];
    expect(maintenanceOperations(status({ ops }))).toEqual([
      op("add", "new"),
      op("update", "review"),
    ]);
    expect(maintenanceOperations(null)).toEqual([]);
  });

  it("needs update only when drift leaves work Update can do", () => {
    expect(needsSkillUpdate(status({ state: "drift", ops: [op("delete", "old")] }))).toBe(false);
    expect(needsSkillUpdate(status({ state: "drift", ops: [op("add", "new")] }))).toBe(true);
    expect(needsSkillUpdate(status({ state: "up-to-date", ops: [op("add", "new")] }))).toBe(false);
  });

  it("formats operations in kind order and then by name", () => {
    const ops = [op("delete", "b"), op("update", "z"), op("add", "b"), op("update", "a")];
    expect(formatUpdateMessage(ops, t)).toBe(
      [
        "t:settings:agentSkills_operations_add b",
        "t:settings:agentSkills_operations_update a",
        "t:settings:agentSkills_operations_update z",
        "t:settings:agentSkills_operations_delete b",
      ].join("\n"),
    );
  });
});

describe("picker drafts", () => {
  it("reads membership from either mode", () => {
    expect(isSkillSelected({ mode: "all" }, "review")).toBe(true);
    expect(isSkillSelected({ mode: "custom", skills: ["review"] }, "review")).toBe(true);
    expect(isSkillSelected({ mode: "custom", skills: [] }, "review")).toBe(false);
  });

  it("turning all off keeps every bundled skill checked", () => {
    expect(toggleAllSelection(true, ["b", "a"])).toEqual({ mode: "all" });
    expect(toggleAllSelection(false, ["b", "a"])).toEqual({
      mode: "custom",
      skills: ["b", "a"],
    });
  });

  it("toggles one skill and keeps the list sorted", () => {
    expect(toggleSkillSelection({ mode: "custom", skills: ["b"] }, "a")).toEqual({
      mode: "custom",
      skills: ["a", "b"],
    });
    expect(toggleSkillSelection({ mode: "custom", skills: ["a", "b"] }, "a")).toEqual({
      mode: "custom",
      skills: ["b"],
    });
    expect(toggleSkillSelection({ mode: "all" }, "a")).toEqual({ mode: "all" });
  });
});
