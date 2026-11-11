import { describe, expect, it } from "vitest";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { disabledHits, disabledModelChoices, globMatch } from "./disabled-models";

const config = {
  version: 1,
  providers: [
    {
      id: "relay",
      protocol: "openai",
      baseUrl: "https://relay.example/v1",
      models: [{ id: "claude-fable-5" }, { id: "gpt-5.5", label: "GPT 5.5" }],
    },
    {
      id: "off",
      protocol: "openai",
      enabled: false,
      baseUrl: "https://off.example/v1",
      models: [{ id: "claude-fable-5" }],
    },
  ],
} as unknown as GatewayConfigWire;

describe("Disabled models", () => {
  it("matches a pattern against the ref and the bare id, case-insensitively", () => {
    expect(globMatch("*fable*", "relay/claude-fable-5")).toBe(true);
    expect(globMatch("*FABLE*", "claude-fable-5")).toBe(true);
    expect(globMatch("gpt-5.5", "relay/gpt-5.5")).toBe(false);
    expect(globMatch("gpt-5.5", "gpt-5.5")).toBe(true);
    expect(globMatch("gpt-5.?", "gpt-5.5")).toBe(true);
  });

  it("lists models of providers that are on, and says what a pattern hits", () => {
    const choices = disabledModelChoices(config);
    expect(choices.map((choice) => choice.id)).toEqual(["relay/claude-fable-5", "relay/gpt-5.5"]);
    expect(disabledHits("*fable*", choices).map((choice) => choice.id)).toEqual([
      "relay/claude-fable-5",
    ]);
    expect(disabledHits("nothing-*", choices)).toEqual([]);
    expect(disabledHits("  ", choices)).toEqual([]);
  });
});
