import { describe, expect, it } from "vitest";

import type { GatewayRouteHistoryRow } from "~/lib/gatewayTypes";
import { groupGatewayHistory, TITLE_KINDS } from "./gatewayHistoryGroups.logic";

function row(overrides: Partial<GatewayRouteHistoryRow>): GatewayRouteHistoryRow {
  return {
    id: "call",
    time: "2026-11-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("gatewayHistoryGroups", () => {
  it("groups title turns under the conversation the daemon resolved", () => {
    const groups = groupGatewayHistory([
      row({ id: "a", session: "s1" }),
      row({
        id: "title",
        kind: "thread_title",
        parentSession: "s1",
        parentMatched: true,
      }),
      row({ id: "b", session: "s2" }),
      row({ id: "orphan" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(["s1", "s2", "orphan"]);
    expect(groups[0]).toMatchObject({
      label: "s1",
      matched: true,
      routes: [{ id: "a" }, { id: "title" }],
    });
    expect(groups[1]).toMatchObject({ label: "s2", matched: false });
    expect(groups[2]).toMatchObject({ label: null });
  });

  it("knows which kinds are title turns", () => {
    expect(TITLE_KINDS.has("thread_title")).toBe(true);
    expect(TITLE_KINDS.has("message")).toBe(false);
  });
});
