import { describe, expect, it } from "vitest";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { syncGroupOrder } from "./routing-group-identity";

describe("syncGroupOrder", () => {
  it("renames the group's place in groupOrder", () => {
    const config = {
      version: 1,
      groupOrder: ["main", "backup"],
      groups: [],
    } as unknown as GatewayConfigWire;
    syncGroupOrder(config, "main", "primary");
    expect(config.groupOrder).toEqual(["primary", "backup"]);
  });

  it("leaves an empty or absent order alone", () => {
    const config = { version: 1, groups: [] } as unknown as GatewayConfigWire;
    syncGroupOrder(config, "main", "primary");
    expect(config.groupOrder).toEqual([]);
  });
});
