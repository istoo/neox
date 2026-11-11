import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "./config.js";
import { listGatewayModels } from "./catalog.js";
import {
  disabledPattern,
  disabledRefusal,
  globMatch,
  listedModelId,
  modelEfforts,
  servedModelId,
  upstreamModelName,
  usageModelId,
} from "./model-prefs.js";

function configOf(value: unknown) {
  return GatewayConfigSchema.parse({
    providers: [
      {
        id: "relay-a",
        protocol: "openai",
        baseUrl: "https://relay-a.test/v1",
        models: [{ id: "deepseek-v4.1-flash-1017" }, { id: "claude-opus-5-5" }],
      },
    ],
    ...(value as object),
  });
}

describe("globMatch", () => {
  it("matches myna's simple glob, slashes included", () => {
    expect(globMatch("*fable*", "openrouter/anthropic/claude-fable-5")).toBe(true);
    expect(globMatch("relay-a/*", "relay-a/claude-opus-5-5")).toBe(true);
    expect(globMatch("gpt-?1", "GPT-51")).toBe(true);
    expect(globMatch("gpt-?1", "gpt-551")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
  });
});

describe("disabled models", () => {
  it("finds the pattern that turned a model off, by ref or bare id", () => {
    expect(disabledPattern(configOf({}), "relay-a", "claude-opus-5-5")).toBeNull();
    expect(
      disabledPattern(configOf({ disabledModels: ["*fable*"] }), "relay-a", "claude-fable-5"),
    ).toBe("*fable*");
    expect(
      disabledPattern(
        configOf({ disabledModels: ["relay-a/claude-opus-5-5"] }),
        "relay-a",
        "claude-opus-5-5",
      ),
    ).toBe("relay-a/claude-opus-5-5");
    expect(disabledPattern(configOf({ disabledModels: ["GPT-5.5"] }), "relay-a", "gpt-5.5")).toBe(
      "GPT-5.5",
    );
  });

  it("refuses with myna's 403 and wording", () => {
    const refusal = disabledRefusal("relay-a/claude-opus-5-5", "*fable*");
    expect(refusal.status).toBe(403);
    expect(refusal.message).toContain("is disabled in neolix");
    expect(refusal.message).toContain('matches "*fable*"');
  });

  it("leaves a disabled model out of the model list", () => {
    const ids = listGatewayModels(configOf({ disabledModels: ["*opus*"] })).map(
      (entry) => entry.id,
    );
    expect(ids).toEqual(["relay-a/deepseek-v4.1-flash-1017"]);
  });
});

describe("listed ids", () => {
  it("lists the id the user gave and maps it back to the served one", () => {
    const config = configOf({
      modelIDs: { "relay-a/deepseek-v4-flash": "deepseek-v4.1-flash-1017" },
    });
    expect(listedModelId(config, "relay-a", "deepseek-v4.1-flash-1017")).toBe("deepseek-v4-flash");
    expect(listedModelId(config, "relay-a", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(servedModelId(config, "relay-a", "deepseek-v4-flash")).toBe("deepseek-v4.1-flash-1017");
    expect(servedModelId(config, "relay-a", "claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(listGatewayModels(config).map((entry) => entry.id)).toContain(
      "relay-a/deepseek-v4-flash",
    );
  });
});

describe("wire names", () => {
  it("asks the vendor by the name given, the model filling a *", () => {
    const config = configOf({ modelWires: { "relay-a/*": "vendor-c/*" } });
    expect(upstreamModelName(config, "relay-a", "model-3")).toBe("vendor-c/model-3");
    const single = configOf({ modelWires: { "relay-a/model-3": "one-name" } });
    expect(upstreamModelName(single, "relay-a", "model-3")).toBe("one-name");
    expect(upstreamModelName(single, "relay-a", "other")).toBe("other");
  });
});

describe("levels and usage aliases", () => {
  it("keeps the levels a model offers, or none at all", () => {
    const config = configOf({
      modelEfforts: { "relay-a/claude-opus-5-5": ["low", "high"] },
      modelReasonless: { "relay-a/deepseek-v4.1-flash-1017": true },
    });
    expect(modelEfforts(config, "relay-a", "claude-opus-5-5")).toEqual(["low", "high"]);
    expect(modelEfforts(config, "relay-a", "deepseek-v4.1-flash-1017")).toEqual([]);
    expect(modelEfforts(config, "relay-a", "other")).toBeNull();
  });

  it("counts usage under the alias, and nothing else", () => {
    const config = configOf({ usageAliases: { "deepseek-v4.1-flash": "deepseek-flash" } });
    expect(usageModelId(config, "deepseek-v4.1-flash")).toBe("deepseek-flash");
    expect(usageModelId(config, "gpt-5.5")).toBe("gpt-5.5");
  });
});
