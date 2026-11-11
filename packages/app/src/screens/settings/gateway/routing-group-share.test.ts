import type { GatewayGroupWire } from "@neolix/protocol/gateway";
import { describe, expect, it } from "vitest";
import { sharedGroupText } from "./routing-group-share";

function group(overrides: Partial<GatewayGroupWire> = {}): GatewayGroupWire {
  return {
    id: "steady",
    label: "Steady",
    members: ["a/one", "b/two"],
    strategy: "order",
    ...overrides,
  };
}

function shared(text: string): Record<string, unknown> {
  return (JSON.parse(text) as { group: Record<string, unknown> }).group;
}

describe("sharedGroupText", () => {
  it("marks the text as a routing group another myna can read", () => {
    const text = JSON.parse(sharedGroupText(group())) as Record<string, unknown>;
    expect(text.magpie).toBe("routing-group");
    expect(text.version).toBe(1);
  });

  it("spells the strategy and the label as myna does", () => {
    expect(shared(sharedGroupText(group({ strategy: "least-used" }))).routing).toBe("usage");
    expect(shared(sharedGroupText(group({ strategy: "smart" }))).routing).toBeUndefined();
    expect(
      shared(sharedGroupText(group({ weighted: true, weights: { "a/one": 3 } }))),
    ).toMatchObject({ routing: "weight", weights: { "a/one": 3 } });
    expect(shared(sharedGroupText(group())).name).toBe("Steady");
  });

  it("leaves behind what belongs to this machine: accounts, folder rules and derived flags", () => {
    const text = shared(
      sharedGroupText(
        group({
          accounts: ["a/key"],
          auto: true,
          disabled: true,
          rules: [
            { use: "a/one" },
            { use: "b/two", folders: ["/Users/me/src"] },
            { use: "b/two", exceptFolders: ["/Users/me/src/vendor"] },
          ],
        }),
      ),
    );
    expect(text.accounts).toBeUndefined();
    expect(text.auto).toBeUndefined();
    expect(text.disabled).toBeUndefined();
    expect(text.rules).toEqual([{ use: "a/one" }]);
  });

  it("keeps the rule's conditions", () => {
    expect(
      shared(
        sharedGroupText(
          group({
            rules: [
              {
                use: "a/one",
                useEffort: "high",
                tokens: 200_000,
                effort: "on",
                compact: true,
                time: { from: "22:00", to: "08:00", zone: "Asia/Shanghai" },
              },
            ],
          }),
        ),
      ).rules,
    ).toEqual([
      {
        use: "a/one",
        useEffort: "high",
        tokens: 200_000,
        effort: "on",
        compact: true,
        time: { from: "22:00", to: "08:00", zone: "Asia/Shanghai" },
      },
    ]);
  });
});
