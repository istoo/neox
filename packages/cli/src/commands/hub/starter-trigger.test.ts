import { describe, expect, it } from "vitest";
import { availableStarterTriggerConnections } from "./starter-trigger.js";

describe("starter trigger connections", () => {
  it("returns only concrete connections that can back the generated trigger", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-istoo",
              accountLogin: "istoo",
              accountType: "Organization",
              repositories: ["istoo/neox"],
            },
          ],
          slack: [{ slug: "Neox", teamName: "Neox" }],
          discord: [{ slug: "neolix-discord", guildName: "Neox Discord" }],
          daemons: [],
          linear: [],
        },
        "istoo/neox",
      ),
    ).toEqual([
      {
        id: "github:istoo/neox",
        label: "GitHub — istoo/neox",
        provider: "github",
        filters: { connection: "github-istoo", repo: "istoo/neox" },
      },
      {
        id: "slack:Neox",
        label: "Slack — Neox",
        provider: "slack",
        filters: { connection: "Neox" },
      },
      {
        id: "discord:neolix-discord",
        label: "Discord — Neox Discord",
        provider: "discord",
        filters: { connection: "neolix-discord" },
      },
    ]);
  });

  it("does not offer GitHub when the current repository is not connected", () => {
    expect(
      availableStarterTriggerConnections(
        {
          github: [
            {
              slug: "github-istoo",
              accountLogin: "istoo",
              accountType: "Organization",
              repositories: ["istoo/hub"],
            },
          ],
          slack: [],
          discord: [],
          daemons: [],
          linear: [],
        },
        "istoo/neox",
      ),
    ).toEqual([]);
  });
});
