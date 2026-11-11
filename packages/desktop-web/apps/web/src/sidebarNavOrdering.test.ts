// FILE: sidebarNavOrdering.test.ts
// Purpose: Covers the shared Kanban/Tasks slot resolution.
// Layer: Web settings tests

import { describe, expect, it } from "vitest";

import { normalizeSidebarFooterOrder, resolveTasksSurfaceSlot } from "./sidebarNavOrdering";

describe("resolveTasksSurfaceSlot", () => {
  it("shows Tasks where the server offers it and Kanban elsewhere, in the first of their slots", () => {
    const order = ["newThread", "pullRequests", "kanban", "automations", "tasks"] as const;
    expect(resolveTasksSurfaceSlot(order, true)).toEqual([
      "newThread",
      "pullRequests",
      "tasks",
      "automations",
    ]);
    expect(resolveTasksSurfaceSlot(order, false)).toEqual([
      "newThread",
      "pullRequests",
      "kanban",
      "automations",
    ]);
  });

  it("leaves an order without either item alone", () => {
    expect(resolveTasksSurfaceSlot(["newThread", "automations"], true)).toEqual([
      "newThread",
      "automations",
    ]);
  });
});

describe("normalizeSidebarFooterOrder", () => {
  it("keeps a saved order and appends items it predates", () => {
    expect(normalizeSidebarFooterOrder(["help"])).toEqual(["help", "usage"]);
    expect(normalizeSidebarFooterOrder(["usage", "help"])).toEqual(["usage", "help"]);
  });

  it("drops unknown and duplicate ids", () => {
    expect(normalizeSidebarFooterOrder(["help", "settings", "help", "usage"])).toEqual([
      "help",
      "usage",
    ]);
  });
});
