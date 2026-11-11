import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import { hostFeatureAvailability } from "./host-features";

function info(features: Record<string, boolean>): DaemonServerInfo {
  return { features } as unknown as DaemonServerInfo;
}

describe("hostFeatureAvailability", () => {
  it("is unknown, not false, before server_info arrives", () => {
    expect(hostFeatureAvailability(null, "llmGateway")).toBeNull();
    expect(hostFeatureAvailability(undefined, "llmGateway")).toBeNull();
  });

  it("is false only once the host has said it does not have the feature", () => {
    expect(hostFeatureAvailability(info({}), "llmGateway")).toBe(false);
    expect(hostFeatureAvailability(info({ llmGateway: false }), "llmGateway")).toBe(false);
  });

  it("is true when the host advertises the feature", () => {
    expect(hostFeatureAvailability(info({ llmGateway: true }), "llmGateway")).toBe(true);
  });
});
