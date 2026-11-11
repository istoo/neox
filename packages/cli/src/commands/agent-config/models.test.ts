import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@neolix/server/gateway-config";
import { catalogRows, notServed } from "./catalog-rows.js";

const CONFIG = GatewayConfigSchema.parse({
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.example/v1",
      apiKey: "sk-openai",
      models: [
        { id: "gpt-5", label: "Sol" },
        { id: "gpt-5-mini" },
        { id: "gpt-image", kind: "image" },
      ],
    },
    {
      id: "claude-go",
      label: "Claude",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.example",
      apiKey: "sk-claude",
      modelMode: "picked",
      models: [{ id: "sonnet", picked: true }, { id: "opus" }],
    },
    {
      id: "off",
      label: "Off",
      protocol: "openai",
      baseUrl: "https://off.example/v1",
      apiKey: "sk-off",
      enabled: false,
      models: [{ id: "hidden" }],
    },
  ],
  groups: [{ id: "daily", label: "Daily", members: ["openai/gpt-5", "claude-go/sonnet"] }],
  modelEfforts: { "openai/gpt-5": ["low", "medium", "high"] },
  disabledModels: ["openai/*-mini"],
});

describe("catalogRows", () => {
  it("lists every served model under its provider, then the groups", () => {
    expect(catalogRows(CONFIG).map((row) => row.id)).toEqual([
      "openai/gpt-5",
      "openai/gpt-image",
      "claude-go/sonnet",
      "group/daily",
    ]);
  });

  it("keeps the provider's name, the model's label and its efforts", () => {
    const rows = catalogRows(CONFIG);
    expect(rows[0]).toMatchObject({
      groupKey: "openai",
      heading: "OpenAI",
      name: "Sol",
      efforts: ["low", "medium", "high"],
    });
    expect(rows[1]?.name).toBeUndefined();
    expect(rows[3]).toMatchObject({ groupKey: "group/", heading: "Routing groups", name: "Daily" });
  });

  it("leaves out what is switched off, unpicked or disabled", () => {
    const ids = catalogRows(CONFIG).map((row) => row.id);
    expect(ids).not.toContain("off/hidden");
    expect(ids).not.toContain("claude-go/opus");
    expect(ids).not.toContain("openai/gpt-5-mini");
  });
});

describe("notServed", () => {
  it("says why a provider's models are not served", () => {
    expect(notServed(CONFIG)).toEqual([
      { why: "disabled", ids: ["openai/gpt-5-mini"] },
      { why: "Claude serves only the models picked for it", ids: ["claude-go/opus"] },
      { why: "Off is switched off", ids: ["off/hidden"] },
    ]);
  });
});
