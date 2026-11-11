import { describe, expect, it } from "vitest";
import { resolveSettingsRouteSelection } from "./settings-route-selection";

describe("settings sidebar selection follows the route", () => {
  it("selects the host section on the top route", () => {
    expect(resolveSettingsRouteSelection("/settings/hosts/host-a/agents")).toEqual({
      kind: "host",
      serverId: "host-a",
      section: "agents",
    });
  });

  it("does not keep Plugins selected when the host section changed", () => {
    // Regression: the sidebar read its highlight from a retained sibling
    // screen's view prop and stayed on Plugins after this navigation.
    const selection = resolveSettingsRouteSelection("/settings/hosts/host-a/agents");
    expect(selection).not.toMatchObject({ kind: "plugin" });
  });

  it("selects Plugins only on a plugin route", () => {
    expect(
      resolveSettingsRouteSelection("/settings/hosts/host-a/plugins/plugin-1/screen-1"),
    ).toEqual({ kind: "plugin", serverId: "host-a" });
  });

  it("selects the project section on both project routes", () => {
    expect(resolveSettingsRouteSelection("/settings/hosts/host-a/projects")).toEqual({
      kind: "project",
      serverId: "host-a",
    });
    expect(resolveSettingsRouteSelection("/settings/hosts/host-a/projects/project-1")).toEqual({
      kind: "project",
      serverId: "host-a",
    });
  });

  it("selects an app settings section", () => {
    expect(resolveSettingsRouteSelection("/settings/network")).toEqual({
      kind: "section",
      section: "network",
    });
  });

  it("selects nothing outside Settings", () => {
    expect(resolveSettingsRouteSelection("/schedules")).toEqual({ kind: "none" });
    expect(resolveSettingsRouteSelection("/settings")).toEqual({ kind: "none" });
  });
});
