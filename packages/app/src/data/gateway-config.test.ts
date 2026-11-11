import { describe, expect, it } from "vitest";
import type { GatewayConfigWire, GatewayStatusWire } from "@neolix/protocol/gateway";
import { mergeGatewayConfigPush } from "./gateway-config";

interface Vendor {
  vendor: string;
  name: string;
}

const config = { version: 1, providers: [] } as unknown as GatewayConfigWire;
const status = {
  enabled: false,
  startedAt: 0,
  monthSpendUsd: 0,
  budgetUsd: null,
  accounts: [],
  served: [],
} as unknown as GatewayStatusWire;

describe("mergeGatewayConfigPush", () => {
  it("keeps the search vendors the push does not carry", () => {
    const vendors: Vendor[] = [{ vendor: "tavily", name: "Tavily" }];
    expect(mergeGatewayConfigPush({ searchVendors: vendors }, { config, status })).toEqual({
      config,
      status,
      searchVendors: vendors,
    });
  });

  it("reads an empty cache as having no vendors", () => {
    expect(mergeGatewayConfigPush(undefined, { config, status }).searchVendors).toBeNull();
  });

  it("takes the pushed config and status", () => {
    const merged = mergeGatewayConfigPush({ searchVendors: [] as Vendor[] }, { config, status });
    expect(merged.config).toBe(config);
    expect(merged.status).toBe(status);
  });
});
