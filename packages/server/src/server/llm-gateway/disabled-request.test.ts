import { describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import { disabledCandidateRefusal, disabledRequestRefusal } from "./model-prefs.js";

const config: GatewayConfig = {
  ...EMPTY_GATEWAY_CONFIG,
  disabledModels: ["*fable*"],
  providers: [
    {
      id: "relay",
      protocol: "openai",
      baseUrl: "https://relay.example/v1",
      models: [{ id: "claude-fable-5" }, { id: "gpt-5.5" }],
    },
    {
      id: "off",
      protocol: "openai",
      enabled: false,
      baseUrl: "https://off.example/v1",
      models: [{ id: "claude-fable-5" }],
    },
  ],
};

describe("a disabled model's refusal", () => {
  it("refuses a ref and a bare id the first provider serves", () => {
    expect(disabledRequestRefusal(config, "relay/claude-fable-5")?.status).toBe(403);
    expect(disabledRequestRefusal(config, "claude-fable-5")?.status).toBe(403);
    expect(disabledRequestRefusal(config, "relay/gpt-5.5")).toBeNull();
    expect(disabledRequestRefusal(config, "group/daily")).toBeNull();
  });

  it("checks a planned candidate, whatever route asked for it", () => {
    expect(disabledCandidateRefusal(config, "relay", "claude-fable-5")?.message).toContain(
      "*fable*",
    );
    expect(disabledCandidateRefusal(config, "relay", "gpt-5.5")).toBeNull();
  });

  it("refuses a switched-off provider's own ref, while a bare id goes by the first one on", () => {
    expect(disabledRequestRefusal(config, "off/claude-fable-5")?.status).toBe(403);
    expect(disabledRequestRefusal(config, "claude-fable-5")?.message).toContain(
      "relay/claude-fable-5",
    );
  });
});
