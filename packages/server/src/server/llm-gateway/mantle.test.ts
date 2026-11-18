import { afterEach, describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import {
  bedrockGPT,
  clearMantleUnfit,
  isBedrockMantle,
  isMantleRoute,
  mantleBase,
  mantleFits,
  mantleHost,
  mantleOpenAI,
  mantleWrongRoute,
  markMantleUnfit,
  resetMantleRoutes,
} from "./mantle.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "openai",
    baseUrl: "https://bedrock-mantle.us-east-1.api.aws/v1",
    accounts: [],
    models: [],
    replyHeaders: [],
    passHeaders: [],
    fallback: [],
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    ...overrides,
  } as GatewayProvider;
}

afterEach(() => {
  resetMantleRoutes();
});

describe("mantleHost", () => {
  it("names Bedrock Mantle's hosts alone", () => {
    expect(mantleHost("bedrock-mantle.us-east-1.api.aws")).toBe(true);
    expect(mantleHost("BEDROCK-MANTLE.EU-WEST-1.API.AWS")).toBe(true);
    expect(mantleHost("bedrock-mantle.example.com")).toBe(false);
    expect(mantleHost("bedrock-runtime.us-east-1.amazonaws.com")).toBe(false);
  });
});

describe("isBedrockMantle", () => {
  it("reads the preset", () => {
    expect(isBedrockMantle(provider({ preset: "bedrock-mantle" }))).toBe(true);
  });

  it("reads a Mantle host in any address it keeps", () => {
    expect(
      isBedrockMantle(
        provider({
          baseUrl: "https://bedrock-mantle.eu-west-1.api.aws/v1",
          preset: undefined,
        }),
      ),
    ).toBe(true);
    expect(
      isBedrockMantle(
        provider({
          baseUrl: "https://relay.example/v1",
          wires: { openai: "https://bedrock-mantle.us-west-2.api.aws/v1" },
        }),
      ),
    ).toBe(true);
    expect(
      isBedrockMantle(
        provider({
          baseUrl: "https://relay.example/v1",
          accounts: [{ id: "a", baseUrl: "https://bedrock-mantle.ap-south-1.api.aws" }],
        }),
      ),
    ).toBe(true);
  });

  it("leaves another vendor alone", () => {
    expect(isBedrockMantle(provider({ baseUrl: "https://api.openai.com/v1" }))).toBe(false);
    expect(
      isBedrockMantle(
        provider({ baseUrl: "https://relay.example/bedrock-mantle.us-east-1.api.aws/v1" }),
      ),
    ).toBe(false);
  });
});

describe("isMantleRoute", () => {
  it("places chat completions and Responses, not Messages", () => {
    expect(isMantleRoute(provider({ preset: "bedrock-mantle" }))).toBe(true);
    expect(
      isMantleRoute(provider({ preset: "bedrock-mantle", protocol: "openai-responses" })),
    ).toBe(true);
    expect(isMantleRoute(provider({ preset: "bedrock-mantle", protocol: "anthropic" }))).toBe(
      false,
    );
  });

  it("leaves a provider that isn't Mantle alone", () => {
    expect(isMantleRoute(provider({ baseUrl: "https://api.openai.com/v1" }))).toBe(false);
  });
});

describe("bedrockGPT and mantleOpenAI", () => {
  it("names OpenAI's closed GPT models and xAI's", () => {
    expect(bedrockGPT("global.openai.gpt-6-luna")).toBe(true);
    expect(bedrockGPT("openai.gpt-oss-120b")).toBe(false);
    expect(mantleOpenAI("xai.grok-4.3")).toBe(true);
    expect(mantleOpenAI("openai.gpt-oss-120b")).toBe(false);
    expect(mantleOpenAI("anthropic.claude-opus-4-7")).toBe(false);
  });
});

describe("mantleBase", () => {
  const v1 = "https://bedrock-mantle.us-east-1.api.aws/v1";
  const openai = "https://bedrock-mantle.us-east-1.api.aws/openai/v1";

  it("asks each model at the prefix its card names", () => {
    expect(mantleBase(v1, "openai.gpt-oss-120b", false)).toBe(v1);
    expect(mantleBase(v1, "openai.gpt-5.5", false)).toBe(openai);
    expect(mantleBase(v1, "xai.grok-4.3", false)).toBe(openai);
    expect(mantleBase(openai, "openai.gpt-5.5", false)).toBe(openai);
    expect(mantleBase(openai, "openai.gpt-oss-120b", false)).toBe(v1);
  });

  it("asks at the other prefix when the model was refused there", () => {
    expect(mantleBase(v1, "openai.gpt-oss-120b", true)).toBe(openai);
    expect(mantleBase(v1, "openai.gpt-5.5", true)).toBe(v1);
  });

  it("gives a base the user typed as it came", () => {
    expect(mantleBase("https://bedrock-mantle.us-east-1.api.aws/anthropic", "x", false)).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic",
    );
  });
});

describe("mantleWrongRoute", () => {
  it("reads Mantle's refusal of a model asked at the wrong prefix", () => {
    expect(mantleWrongRoute("model `openai.gpt-5.5` isn't supported on this route")).toBe(true);
    expect(mantleWrongRoute("model `x` is not supported on this route.")).toBe(true);
    expect(mantleWrongRoute("Not supported on this route")).toBe(true);
    expect(mantleWrongRoute("quota exceeded")).toBe(false);
  });
});

describe("mantle unfit memory", () => {
  it("remembers the prefix that served a model until it is cleared", () => {
    const key = ["p", "m", "openai"] as const;
    expect(mantleFits(...key)).toBe(true);
    markMantleUnfit(...key);
    expect(mantleFits(...key)).toBe(false);
    clearMantleUnfit(...key);
    expect(mantleFits(...key)).toBe(true);
  });

  it("keys by provider and protocol", () => {
    markMantleUnfit("p", "m", "openai");
    expect(mantleFits("p", "m", "openai-responses")).toBe(true);
    expect(mantleFits("q", "m", "openai")).toBe(true);
    expect(mantleFits("p", "n", "openai")).toBe(true);
  });
});
