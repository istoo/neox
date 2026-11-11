import { describe, expect, it } from "vitest";
import { listGatewayModels } from "./catalog.js";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";

function configOf(extra: Partial<GatewayConfig>): GatewayConfig {
  return {
    ...EMPTY_GATEWAY_CONFIG,
    providers: [
      {
        id: "codex",
        protocol: "openai-responses",
        baseUrl: "https://chatgpt.example/v1",
        models: [{ id: "gpt-5.6-sol", contextWindow: 400000 }],
      },
      {
        id: "relay",
        protocol: "openai",
        baseUrl: "https://relay.example/v1",
        models: [{ id: "gpt-5.6-sol" }, { id: "relay-only" }],
      },
    ],
    ...extra,
  };
}

describe("Model ids without the provider", () => {
  it("adds no bare id unless the setting is on", () => {
    const ids = listGatewayModels(configOf({})).map((entry) => entry.id);
    expect(ids).not.toContain("gpt-5.6-sol");
  });

  it("lists each bare id once, pointing at the found group when there is one", () => {
    const models = listGatewayModels(configOf({ bareModelIDs: true }));
    const bare = models.filter((entry) => entry.id === "gpt-5.6-sol");
    expect(bare).toHaveLength(1);
    expect(bare[0]?.owned_by).toBe("group");
    expect(bare[0]?.context_window).toBe(400000);
    expect(models.map((entry) => entry.id)).toContain("relay-only");
  });

  it("points at the first provider when found groups are off", () => {
    const bare = listGatewayModels(configOf({ bareModelIDs: true, autoGroups: false })).find(
      (entry) => entry.id === "gpt-5.6-sol",
    );
    expect(bare?.owned_by).toBe("codex");
  });

  it("does not add an id the list already names", () => {
    const config = configOf({ bareModelIDs: true });
    const models = listGatewayModels({
      ...config,
      providers: [
        {
          id: "plain",
          protocol: "openai",
          baseUrl: "https://plain.example/v1",
          models: [{ id: "gpt-5.6-sol" }],
        },
      ],
      groups: [],
    });
    expect(models.filter((entry) => entry.id === "gpt-5.6-sol")).toHaveLength(1);
  });
});
