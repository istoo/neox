import { describe, expect, it } from "vitest";
import { guideStateOf } from "./agent-guide";

function stateOf(extra: Partial<Parameters<typeof guideStateOf>[0]> = {}) {
  return guideStateOf({
    gatewayMode: false,
    hidden: false,
    models: 3,
    anyConnected: true,
    ownGroups: 0,
    ...extra,
  });
}

describe("the Get started card", () => {
  it("steps aside once a source and an agent are both there", () => {
    expect(stateOf().show).toBe(false);
  });

  it("shows while either step is missing", () => {
    expect(stateOf({ models: 0 }).show).toBe(true);
    expect(stateOf({ anyConnected: false }).show).toBe(true);
  });

  it("is put away by guideHidden, and never shows in gateway mode", () => {
    expect(stateOf({ models: 0, hidden: true }).show).toBe(false);
    expect(stateOf({ models: 0, gatewayMode: true }).show).toBe(false);
  });

  it("does not count the routing step as done until the user has a group", () => {
    expect(stateOf({ ownGroups: 0 }).routing).toBe(false);
    expect(stateOf({ ownGroups: 2 }).routing).toBe(true);
    expect(stateOf({ ownGroups: 2, models: 0 }).show).toBe(true);
  });
});
