import { describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import {
  providerCanSearch,
  searchPlanOf,
  searcherRefs,
  searchSteps,
  searchesForAll,
} from "./search-plan.js";

type Search = NonNullable<GatewayConfig["search"]>;

function searchOf(extra: Partial<Search> = {}): Search {
  return {
    enabled: true,
    url: "https://api.tavily.com/search",
    apis: [],
    ...extra,
  };
}

function configOf(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...EMPTY_GATEWAY_CONFIG,
    providers: [
      {
        id: "anthropic",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        searches: true,
        models: [{ id: "claude-haiku-5" }],
      },
      {
        id: "codex",
        protocol: "openai-responses",
        baseUrl: "https://chatgpt.example/v1",
        searches: true,
        models: [{ id: "gpt-5.6-sol" }],
      },
      {
        id: "relay",
        protocol: "openai",
        baseUrl: "https://relay.example/v1",
        models: [{ id: "gpt-5.6-sol" }],
      },
    ],
    ...extra,
  };
}

const tavily = { vendor: "tavily", key: "k" };

describe("who searches for other models", () => {
  it("picks a provider that can search when nothing is named", () => {
    const config = configOf({ search: searchOf() });
    expect(searchPlanOf(config)).toMatchObject({ searcher: "", apisFirst: false, all: false });
    expect(searcherRefs(config)).toEqual(["anthropic"]);
  });

  it("offers a provider whose host searches when the switch is unset", () => {
    const config: GatewayConfig = {
      ...EMPTY_GATEWAY_CONFIG,
      search: searchOf(),
      providers: [
        {
          id: "relay",
          protocol: "anthropic",
          baseUrl: "https://relay.example/v1",
          models: [{ id: "claude-haiku-5" }],
        },
        {
          id: "router",
          protocol: "openai",
          baseUrl: "https://openrouter.ai/api/v1",
          models: [{ id: "gpt-5.6-sol" }],
        },
      ],
    };
    // Without a named searcher the gateway takes the first that can.
    expect(searcherRefs(config)).toEqual(["router"]);
    expect(
      searcherRefs({
        ...config,
        providers: [
          {
            id: "anthropic",
            protocol: "anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            models: [{ id: "claude-haiku-5" }],
          },
          ...config.providers,
        ],
      }),
    ).toEqual(["anthropic"]);
  });

  it("keeps a host off the whitelist for the protocol it speaks", () => {
    const config: GatewayConfig = {
      ...EMPTY_GATEWAY_CONFIG,
      search: searchOf(),
      providers: [
        {
          id: "relay",
          protocol: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          models: [{ id: "deepseek-v4-pro" }],
        },
        {
          id: "deepseek",
          protocol: "openai-responses",
          baseUrl: "https://api.deepseek.com/v1",
          models: [{ id: "deepseek-v4-pro" }],
        },
      ],
    };
    expect(searcherRefs(config)).toEqual(["deepseek"]);
  });

  it("reads a signed-in account alone, never the host", () => {
    const anthropicHost = {
      id: "claude",
      protocol: "anthropic" as const,
      baseUrl: "https://api.anthropic.com/v1",
      models: [{ id: "claude-haiku-5" }],
    };
    const claude = { id: "main", agent: "claude-code", enabled: true } as never;
    expect(providerCanSearch(anthropicHost, { account: claude })).toBe(false);
    // Without an account the same address is Anthropic's own host.
    expect(providerCanSearch(anthropicHost)).toBe(true);
  });

  it("counts codex and copilot accounts, and Grok, on Responses", () => {
    const responses = {
      id: "codex",
      protocol: "openai-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [{ id: "gpt-5.6-sol" }],
    };
    const signIn = (agent: string) => ({ id: "main", agent, enabled: true }) as never;
    expect(providerCanSearch(responses, { account: signIn("chatgpt-api") })).toBe(true);
    expect(providerCanSearch(responses, { account: signIn("copilot") })).toBe(true);
    expect(
      providerCanSearch(responses, {
        account: { id: "main", codexAccountId: "neolix:one" } as never,
      }),
    ).toBe(true);
    expect(
      providerCanSearch({ ...responses, id: "grok" }, { account: signIn("claude-code") }),
    ).toBe(true);

    // The same account on another protocol is a plain relay, not a search.
    expect(
      providerCanSearch(
        { ...responses, protocol: "anthropic", baseUrl: "https://relay.example/v1" },
        { account: signIn("chatgpt-api") },
      ),
    ).toBe(false);
    // Neolix's explicit off wins where myna has only an on switch.
    expect(
      providerCanSearch({ ...responses, searches: false }, { account: signIn("chatgpt-api") }),
    ).toBe(false);
  });

  it("reads the switch and then the host when an API key serves the request", () => {
    expect(
      providerCanSearch({
        id: "openai",
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [{ id: "gpt-5.6-sol" }],
      } as never),
    ).toBe(true);
    expect(
      providerCanSearch({
        id: "relay",
        protocol: "anthropic",
        baseUrl: "https://relay.example/v1",
        searches: true,
        models: [{ id: "claude-haiku-5" }],
      } as never),
    ).toBe(true);
    // myna reads Searches only on Anthropic's and Responses' APIs.
    expect(
      providerCanSearch({
        id: "chat",
        protocol: "openai",
        baseUrl: "https://relay.example/v1",
        searches: true,
        models: [{ id: "gpt-5.6-sol" }],
      } as never),
    ).toBe(false);
    expect(
      providerCanSearch({
        id: "relay",
        protocol: "anthropic",
        baseUrl: "",
        searches: true,
        models: [{ id: "claude-haiku-5" }],
      } as never),
    ).toBe(false);
  });

  it("lets a plugin's own said-so through even with an account", () => {
    const relay = {
      id: "custom",
      protocol: "anthropic" as const,
      baseUrl: "https://relay.example/v1",
      searches: true,
      models: [{ id: "claude-haiku-5" }],
    };
    const claude = { id: "main", agent: "claude-code", enabled: true } as never;
    const grokResponses = {
      id: "custom",
      protocol: "openai-responses" as const,
      baseUrl: "https://relay.example/v1",
      models: [{ id: "gpt-5.6-sol" }],
    };
    const codex = { id: "main", agent: "chatgpt-api", enabled: true } as never;

    expect(providerCanSearch(relay, { plugin: "custom", account: claude })).toBe(true);
    expect(providerCanSearch(relay, { plugin: "custom" })).toBe(true);
    expect(providerCanSearch(grokResponses, { plugin: "grok", account: codex })).toBe(true);
    expect(providerCanSearch(grokResponses, { plugin: "other", account: claude })).toBe(false);
  });

  it("lets the explicit switch beat the host", () => {
    const config: GatewayConfig = {
      ...EMPTY_GATEWAY_CONFIG,
      search: searchOf(),
      providers: [
        {
          id: "host",
          protocol: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          searches: false,
          models: [{ id: "claude-haiku-5" }],
        },
        {
          id: "relay",
          protocol: "anthropic",
          baseUrl: "https://relay.example/v1",
          searches: true,
          models: [{ id: "gpt-5.6-sol" }],
        },
      ],
    };
    expect(searcherRefs(config)).toEqual(["relay"]);
  });

  it("asks only the configured search APIs when off", () => {
    expect(searcherRefs(configOf({ search: searchOf({ searcher: "off" }) }))).toEqual([]);
    expect(searchSteps(configOf({ search: searchOf({ searcher: "off" }) }))).toEqual([]);
    expect(
      searchSteps(configOf({ search: searchOf({ searcher: "off", apis: [tavily] }) })),
    ).toEqual([{ kind: "apis" }]);
  });

  it("keeps a named searcher and the ones after it, in order", () => {
    const config = configOf({
      search: searchOf({
        searcher: "codex/gpt-5.6-sol",
        searcherThen: ["anthropic", "codex", "relay/missing"],
      }),
    });
    expect(searcherRefs(config)).toEqual(["codex/gpt-5.6-sol", "anthropic", "codex"]);
  });

  it("leaves out a searcher whose provider is switched off", () => {
    const config = configOf({ search: searchOf({ searcher: "anthropic" }) });
    config.providers = config.providers.map((provider) =>
      provider.id === "anthropic" ? { ...provider, enabled: false } : provider,
    );
    expect(searcherRefs(config)).toEqual([]);
  });

  it("does not ask a searcher model that is disabled", () => {
    const config = configOf({
      search: searchOf({ searcher: "anthropic/claude-haiku-5" }),
      disabledModels: ["*haiku*"],
    });
    expect(searcherRefs(config)).toEqual([]);
  });

  it("asks the search APIs first or last as SearchFirst says", () => {
    const providerFirst = configOf({
      search: searchOf({ searcher: "anthropic", apis: [tavily] }),
    });
    expect(searchSteps(providerFirst).map((step) => step.kind)).toEqual(["provider", "apis"]);
    const apiFirst = configOf({
      search: searchOf({ searcher: "anthropic", searchFirst: "api", apis: [tavily] }),
    });
    expect(searchSteps(apiFirst).map((step) => step.kind)).toEqual(["apis", "provider"]);
  });

  it("searches for every model only while something can search", () => {
    expect(searchesForAll(configOf({ search: searchOf({ searchAll: true }) }))).toBe(true);
    expect(
      searchesForAll(
        configOf({ search: searchOf({ searchAll: true, searcher: "off" }), providers: [] }),
      ),
    ).toBe(false);
  });
});
