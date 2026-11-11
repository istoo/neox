import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type GatewayProvider } from "./config.js";
import {
  antigravityCloak,
  antigravitySystemPrompt,
  codexRequestAsSent,
  loadsAdditionalToolsInPlace,
  ownClientProvider,
  passesUserAgent,
  providerRoutingStrategy,
  providerShownTo,
  providerVisibilityNames,
  userAgentFor,
} from "./provider-shaping.js";

function provider(overrides: Record<string, unknown> = {}): GatewayProvider {
  return GatewayConfigSchema.parse({
    providers: [
      {
        id: "acme",
        protocol: "openai",
        baseUrl: "https://api.example.test/v1",
        ...overrides,
      },
    ],
  }).providers[0]!;
}

describe("passesUserAgent", () => {
  it("passes the agent's User-Agent only when asked and no account signs in", () => {
    expect(passesUserAgent(provider({ passUserAgent: true }))).toBe(true);
    expect(passesUserAgent(provider())).toBe(false);
    expect(
      passesUserAgent(
        provider({
          passUserAgent: true,
          accounts: [{ id: "one", agent: "chatgpt-api" }],
        }),
      ),
    ).toBe(false);
  });

  it("never passes the agent's to a gateway that serves its own client", () => {
    for (const preset of ["opencode-zen", "opencode-go", "clinepass", "kilo", "remote-myna"]) {
      expect(ownClientProvider(provider({ preset }))).toBe(true);
      expect(passesUserAgent(provider({ preset, passUserAgent: true }))).toBe(false);
    }
    for (const baseUrl of [
      "https://opencode.ai/zen/v1",
      "https://api.cline.bot/v1",
      "https://api.kilo.ai/api/gateway",
      "https://api.kilocode.ai/v1",
    ]) {
      expect(ownClientProvider(provider({ baseUrl }))).toBe(true);
    }
    expect(ownClientProvider(provider({ baseUrl: "https://api.example.test/v1" }))).toBe(false);
  });

  it("lets a header.User-Agent stand over both", () => {
    expect(
      userAgentFor(
        provider({ passUserAgent: true, headers: { "user-agent": "Mine/1" } }),
        "Agent/1",
        "Neox/1",
      ),
    ).toBe("Mine/1");
    expect(userAgentFor(provider({ passUserAgent: true }), "Agent/1", "Neox/1")).toBe("Agent/1");
    expect(userAgentFor(provider(), "Agent/1", "Neox/1")).toBe("Neox/1");
  });
});

describe("antigravity prompts", () => {
  const codexLine = "You are Codex, an agent based on GPT-5. You and the user share one workspace.";

  it("breaks up each line Antigravity turns away after its first letter", () => {
    expect(antigravityCloak(codexLine)).toBe(
      "Y​ou are Codex, an agent based on GPT-5. You and the user share one workspace.",
    );
    expect(antigravityCloak("You are a helpful agent.")).toBe("You are a helpful agent.");
  });

  it("leaves a line already broken up alone", () => {
    const cloaked = antigravityCloak(codexLine);
    expect(antigravityCloak(cloaked)).toBe(cloaked);
  });

  it("applies only to an Antigravity account, and not when sent as written", () => {
    const antigravity = provider({ accounts: [{ id: "one", agent: "antigravity" }] });
    expect(antigravitySystemPrompt(antigravity, codexLine)).toContain("​");
    expect(antigravitySystemPrompt(provider(), codexLine)).toBe(codexLine);
    expect(
      antigravitySystemPrompt(
        provider({ promptAsWritten: true, accounts: [{ id: "one", agent: "antigravity" }] }),
        codexLine,
      ),
    ).toBe(codexLine);
  });
});

describe("codexRequestAsSent", () => {
  it("needs the setting, a key+URL provider, and Codex as the caller", () => {
    expect(codexRequestAsSent(provider({ codexAsSent: true }), true)).toBe(true);
    expect(codexRequestAsSent(provider({ codexAsSent: true }), false)).toBe(false);
    expect(codexRequestAsSent(provider(), true)).toBe(false);
    expect(
      codexRequestAsSent(
        provider({ codexAsSent: true, accounts: [{ id: "one", agent: "chatgpt-api" }] }),
        true,
      ),
    ).toBe(false);
  });
});

describe("loadsAdditionalToolsInPlace", () => {
  it("is on by default for OpenAI's own API and a ChatGPT account", () => {
    expect(loadsAdditionalToolsInPlace(provider({ baseUrl: "https://api.openai.com/v1" }))).toBe(
      true,
    );
    expect(
      loadsAdditionalToolsInPlace(provider({ accounts: [{ id: "one", agent: "chatgpt-api" }] })),
    ).toBe(true);
    expect(loadsAdditionalToolsInPlace(provider())).toBe(false);
  });

  it("obeys additional-tools=on and off over the default", () => {
    expect(loadsAdditionalToolsInPlace(provider({ additionalTools: "on" }))).toBe(true);
    expect(
      loadsAdditionalToolsInPlace(
        provider({ additionalTools: "off", baseUrl: "https://api.openai.com/v1" }),
      ),
    ).toBe(false);
    expect(loadsAdditionalToolsInPlace(provider({ additionalTools: "default" }))).toBe(false);
  });
});

describe("visibility", () => {
  it("answers to its family and its id, in any case", () => {
    const tagged = provider({ family: "relay" });
    expect(providerVisibilityNames(tagged)).toEqual(["relay", "acme"]);
    expect(providerShownTo(tagged, ["RELAY"])).toBe(true);
    expect(providerShownTo(tagged, ["acme"])).toBe(true);
    expect(providerShownTo(tagged, ["other"])).toBe(false);
    expect(providerShownTo(tagged, undefined)).toBe(true);
  });
});

describe("providerRoutingStrategy", () => {
  it("names the group strategy myna's provider routing means", () => {
    expect(providerRoutingStrategy(provider({ routing: "smart" }))).toEqual({
      strategy: "smart",
      weighted: false,
    });
    expect(providerRoutingStrategy(provider({ routing: "usage" }))).toEqual({
      strategy: "least-used",
      weighted: false,
    });
    expect(providerRoutingStrategy(provider({ routing: "weight" }))).toEqual({
      strategy: "order",
      weighted: true,
    });
    expect(providerRoutingStrategy(provider({ routing: "drain" }))?.strategy).toBe("drain");
    expect(providerRoutingStrategy(provider())).toBeUndefined();
  });
});
