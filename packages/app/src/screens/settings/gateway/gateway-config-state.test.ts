import { describe, expect, it } from "vitest";
import { gatewayConfigUnavailable } from "./gateway-config-state";

describe("gatewayConfigUnavailable", () => {
  it("shows the retry state when a failed read left no config", () => {
    expect(
      gatewayConfigUnavailable({ isLoading: false, hasConfig: false, error: new Error("boom") }),
    ).toBe(true);
  });

  it("keeps loading while the read is still out and no error exists", () => {
    expect(gatewayConfigUnavailable({ isLoading: true, hasConfig: false, error: null })).toBe(
      false,
    );
  });

  it("keeps the page when a config is present, even if a refresh failed", () => {
    expect(
      gatewayConfigUnavailable({ isLoading: false, hasConfig: true, error: new Error("boom") }),
    ).toBe(false);
  });
});
