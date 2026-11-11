import { describe, expect, it } from "vitest";
import type { GatewayProviderWire } from "@neolix/protocol/gateway";
import { GATEWAY_PROVIDER_PRESETS } from "./providers-presets";
import {
  buildProvider,
  emptyModelPriceDraft,
  maskApiKey,
  modelPriceUpdates,
  parseModelPriceDraft,
  parseRateWindowsDraft,
  moveProvider,
  presetDraft,
  providerAccountName,
  providerCanMove,
  uniqueProviderId,
  nextProviderId,
  openProviderDraft,
  providerKeySummary,
  providerMatchesQuery,
  validateProviderDraft,
  withPreservedProviderFields,
} from "./providers-helpers";

const provider: GatewayProviderWire = {
  id: "zai",
  label: "Z.ai",
  protocol: "anthropic",
  baseUrl: "https://api.z.ai/api/anthropic/v1",
  apiKey: "alpha-one",
  models: [
    { id: "glm-5.3" },
    { id: "cogview-4", kind: "image" },
    { id: "cogvideo-3", kind: "video" },
  ],
  accounts: [
    { id: "main", label: "Work", apiKey: "bravo-two-3456", priority: 10, weight: 3 },
    { id: "spare", apiKey: "charlie-three-7890", enabled: false },
  ],
};

describe("maskApiKey", () => {
  it("keeps the first and last four characters", () => {
    const masked = maskApiKey("alpha-one-two-three");
    expect(masked.startsWith("alph")).toBe(true);
    expect(masked.endsWith("hree")).toBe(true);
    expect(masked).toContain("…");
    expect(masked).toHaveLength(9);
  });

  it("keeps only a prefix of a short key", () => {
    expect(maskApiKey("short")).toBe("sh…");
  });

  it("returns nothing for an empty key", () => {
    expect(maskApiKey("  ")).toBe("");
  });
});

describe("providerKeySummary", () => {
  it("shows the first enabled account's masked key", () => {
    expect(providerKeySummary(provider)).toEqual({
      text: maskApiKey("bravo-two-3456"),
      kind: "key",
      tone: "success",
    });
  });

  it("never shows a key whole, whatever the accounts switch says", () => {
    expect(providerKeySummary(provider).text).not.toBe("bravo-two-3456");
    expect(providerKeySummary(provider).text).toBe(maskApiKey("bravo-two-3456"));
  });

  it("says a local provider needs no key", () => {
    const local: GatewayProviderWire = {
      id: "ollama",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [],
    };
    expect(providerKeySummary(local)).toEqual({
      text: "",
      kind: "noKeyNeeded",
      tone: "muted",
    });
  });

  it("says a remote provider needs a key", () => {
    const remote: GatewayProviderWire = {
      id: "relay",
      protocol: "openai",
      baseUrl: "https://relay.example.com/v1",
      models: [],
    };
    expect(providerKeySummary(remote).kind).toBe("needsKey");
  });

  it("reports every account switched off", () => {
    const off: GatewayProviderWire = {
      ...provider,
      accounts: [{ id: "main", apiKey: "bravo-two-3456", enabled: false }],
    };
    expect(providerKeySummary(off).kind).toBe("noActiveAccount");
  });
});

describe("providerMatchesQuery", () => {
  it("matches on a model the row does not show", () => {
    expect(providerMatchesQuery(provider, "cogvideo")).toBe(true);
  });

  it("matches on an account label", () => {
    expect(providerMatchesQuery(provider, "work")).toBe(true);
  });

  it("requires every word to appear", () => {
    expect(providerMatchesQuery(provider, "zai glm")).toBe(true);
    expect(providerMatchesQuery(provider, "zai nope")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(providerMatchesQuery(provider, "   ")).toBe(true);
  });
});

describe("providerAccountName", () => {
  it("names the first enabled account's own label", () => {
    expect(providerAccountName(provider)).toBe("Work");
  });

  it("falls back to the account id", () => {
    const named: GatewayProviderWire = {
      ...provider,
      accounts: [{ id: "spare", apiKey: "bravo-two-3456" }],
    };
    expect(providerAccountName(named)).toBe("spare");
  });

  it("says nothing for a provider key with no account of its own", () => {
    const plain: GatewayProviderWire = {
      id: "relay",
      protocol: "openai",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "bravo-two-3456",
      models: [],
    };
    expect(providerAccountName(plain)).toBeNull();
  });
});

describe("moveProvider", () => {
  const a: GatewayProviderWire = {
    id: "a",
    protocol: "openai",
    baseUrl: "https://a.example.com",
    models: [],
  };
  const b: GatewayProviderWire = {
    id: "b",
    protocol: "openai",
    baseUrl: "https://b.example.com",
    models: [],
  };
  const off: GatewayProviderWire = {
    id: "off",
    protocol: "openai",
    baseUrl: "https://off.example.com",
    models: [],
    enabled: false,
  };

  it("moves a provider past its neighbour", () => {
    expect(moveProvider([a, b], "b", -1)?.map((item) => item.id)).toEqual(["b", "a"]);
    expect(moveProvider([a, b], "a", 1)?.map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("keeps a switched-off provider in its place", () => {
    expect(moveProvider([a, off, b], "b", -1)?.map((item) => item.id)).toEqual(["b", "off", "a"]);
  });

  it("refuses to move past either end", () => {
    expect(moveProvider([a, b], "a", -1)).toBeNull();
    expect(moveProvider([a, b], "b", 1)).toBeNull();
  });

  it("leaves a switched-off provider out of the order", () => {
    expect(moveProvider([off, a], "off", 1)).toBeNull();
  });
});

describe("uniqueProviderId", () => {
  it("keeps the preset id when it is free", () => {
    expect(uniqueProviderId("deepseek", [])).toBe("deepseek");
  });

  it("adds a number when the id is taken", () => {
    const taken: GatewayProviderWire = {
      id: "deepseek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [],
    };
    expect(uniqueProviderId("deepseek", [taken])).toBe("deepseek-2");
  });

  it("makes an id that starts with a digit accepted", () => {
    expect(uniqueProviderId("302ai", [])).toBe("p-302ai");
  });
});

describe("presetDraft", () => {
  it("starts on chat completions at the preset's URL", () => {
    const draft = presetDraft(
      {
        id: "deepseek",
        name: "DeepSeek",
        kind: "vendor",
        endpoints: {
          openai: "https://api.deepseek.com/v1",
          anthropic: "https://api.deepseek.com/anthropic",
        },
      },
      [],
    );
    expect(draft).toMatchObject({
      id: "deepseek",
      label: "DeepSeek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
    });
  });

  it("opens a decision-only preset at its decision address, with a workspace", () => {
    const draft = presetDraft(
      {
        id: "bailian-decision",
        name: "Bailian (decision)",
        kind: "vendor",
        endpoints: {},
        decide: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      },
      [],
    );
    expect(draft.decideOnly).toBe(true);
    expect(draft.decide).toContain("{WorkspaceId}");
    expect(draft.baseUrl).toContain("{WorkspaceId}");
    expect(buildProvider(draft).modelMode).toBe("none");
    expect(buildProvider(draft).exposeModels).toBe(false);
  });
});

describe("upstream search", () => {
  it("starts from the daemon's verdict, not the protocol", () => {
    expect(openProviderDraft({ ...provider, searchesUpstream: true }).searches).toBe(true);
    expect(
      openProviderDraft({ ...provider, protocol: "gemini", searchesUpstream: false }).searches,
    ).toBe(false);
    expect(
      openProviderDraft({ ...provider, protocol: "openai", searchesUpstream: true }).searches,
    ).toBe(true);
  });

  it("writes an explicit value only when it differs from the daemon's", () => {
    const derived = openProviderDraft({ ...provider, searchesUpstream: true });
    expect(buildProvider(derived).searches).toBeUndefined();
    const off = { ...derived, searches: false };
    expect(buildProvider(off).searches).toBe(false);
    const plain = openProviderDraft({ ...provider, searchesUpstream: false });
    expect(buildProvider({ ...plain, searches: true }).searches).toBe(true);
  });
});

describe("decision-only providers", () => {
  it("fills the workspace into the address and serves no model", () => {
    const draft = presetDraft(
      {
        id: "bailian-decision",
        name: "Bailian (decision)",
        kind: "vendor",
        endpoints: {},
        decide: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      },
      [],
    );
    draft.workspace = "ws-123";
    const saved = buildProvider(draft);
    expect(saved.baseUrl).toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(saved.decide).toBe("https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(saved.modelMode).toBe("none");
    expect(saved.exposeModels).toBe(false);
  });

  it("keeps the family tag and reads it back", () => {
    const draft = openProviderDraft(provider);
    draft.family = "zai";
    const saved = buildProvider(draft);
    expect(saved.family).toBe("zai");
    expect(openProviderDraft(saved).family).toBe("zai");
  });
});

describe("nextProviderId", () => {
  it("skips ids already in use", () => {
    const providers: GatewayProviderWire[] = [
      { id: "provider-1", protocol: "openai", baseUrl: "https://a.example.com", models: [] },
      { id: "provider-2", protocol: "openai", baseUrl: "https://b.example.com", models: [] },
      { id: "provider-3", protocol: "openai", baseUrl: "https://c.example.com", models: [] },
    ];
    expect(nextProviderId(providers)).toBe("provider-4");
  });
});

describe("buildProvider", () => {
  it("round-trips every field the form edits", () => {
    const draft = openProviderDraft(provider);
    draft.maxAccounts = "2";
    draft.queueWaitMs = "0";
    draft.priceRate = "1.25";
    draft.sink = true;
    draft.headers = [{ name: "x-tenant", value: "acme" }];
    draft.rateWindows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", rate: "1.5" }];
    const built = buildProvider(draft);
    expect(built).toMatchObject({
      id: "zai",
      label: "Z.ai",
      protocol: "anthropic",
      baseUrl: "https://api.z.ai/api/anthropic/v1",
      maxAccounts: 2,
      queueWaitMs: 0,
      priceRate: 1.25,
      sink: true,
      headers: { "x-tenant": "acme" },
      rateWindows: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", rate: 1.5 }],
    });
    expect(built.models.map((model) => model.id)).toEqual(["glm-5.3", "cogview-4", "cogvideo-3"]);
    expect(built.models[2]?.kind).toBe("video");
  });

  it("drops empty optional values instead of writing them", () => {
    const draft = openProviderDraft(null);
    draft.id = "relay";
    draft.baseUrl = "https://relay.example.com/v1";
    draft.apiKey = "   ";
    draft.maxAccounts = "";
    draft.headers = [{ name: "  ", value: "ignored" }];
    const built = buildProvider(draft);
    expect(built.apiKey).toBeUndefined();
    expect(built.maxAccounts).toBeUndefined();
    expect(built.headers).toBeUndefined();
    expect(built.accounts).toBeUndefined();
  });

  it("keeps a provider switched off", () => {
    const draft = openProviderDraft(provider);
    draft.enabled = false;
    expect(buildProvider(draft).enabled).toBe(false);
  });

  it("writes the certificate, extra body, exposure and icon", () => {
    const draft = openProviderDraft(provider);
    draft.insecureTls = true;
    draft.extraBody = '{ "prompt_cache_key": "abc" }';
    draft.exposeModels = false;
    draft.icon = "◆";
    const built = buildProvider(draft);
    expect(built.insecureTls).toBe(true);
    expect(built.extraBody).toEqual({ prompt_cache_key: "abc" });
    expect(built.exposeModels).toBe(false);
    expect(built.icon).toBe("◆");
  });

  it("writes the balance endpoint and reads it back", () => {
    const draft = openProviderDraft(provider);
    expect(draft.balanceUrl).toBe("");
    draft.balanceUrl = " https://relay.example.com/balance/{key} ";
    draft.balancePath = "data.balance";
    const built = buildProvider(draft);
    expect(built.balanceUrl).toBe("https://relay.example.com/balance/{key}");
    expect(built.balancePath).toBe("data.balance");
    const reopened = openProviderDraft({ ...provider, ...built });
    expect(reopened.balanceUrl).toBe(built.balanceUrl);
    expect(reopened.balancePath).toBe("data.balance");
  });

  it("refuses a balance URL that is not http", () => {
    const draft = openProviderDraft(provider);
    draft.balanceUrl = "file:///etc/passwd";
    expect(validateProviderDraft(draft, [], "zai").balanceUrl).toBe("invalid");
    draft.balanceUrl = "https://relay.example.com/balance";
    expect(validateProviderDraft(draft, [], "zai").balanceUrl).toBeUndefined();
  });

  it("writes native compaction only for a Responses API provider", () => {
    const draft = openProviderDraft(provider);
    expect(draft.nativeCompaction).toBe(false);
    draft.nativeCompaction = true;
    expect(buildProvider(draft).nativeCompaction).toBeUndefined();
    draft.protocol = "openai-responses";
    expect(buildProvider(draft).nativeCompaction).toBe(true);
    expect(openProviderDraft({ ...provider, nativeCompaction: true }).nativeCompaction).toBe(true);
  });

  it("writes the model mode and reads it back", () => {
    const draft = openProviderDraft(provider);
    expect(draft.modelMode).toBe("list");
    draft.modelMode = "best";
    expect(buildProvider(draft).modelMode).toBe("best");
    expect(openProviderDraft({ ...provider, modelMode: "none" }).modelMode).toBe("none");
    expect(buildProvider(openProviderDraft(provider)).modelMode).toBeUndefined();
  });

  it("keeps each model's picked mark", () => {
    const draft = openProviderDraft({
      ...provider,
      models: [{ id: "model-a", picked: true }, { id: "model-b" }],
      modelMode: "picked",
    });
    expect(buildProvider(draft).models).toEqual([
      { id: "model-a", picked: true },
      { id: "model-b" },
    ]);
  });

  it("reads an existing extra body back into the form", () => {
    const draft = openProviderDraft({
      ...provider,
      extraBody: { prompt_cache_key: "abc" },
      insecureTls: true,
      icon: "◆",
    });
    expect(draft.extraBody).toContain("prompt_cache_key");
    expect(draft.insecureTls).toBe(true);
    expect(draft.icon).toBe("◆");
    expect(draft.exposeModels).toBe(true);
  });
});

describe("validateProviderDraft", () => {
  it("accepts a lowercase id and an http URL", () => {
    const draft = openProviderDraft(provider);
    expect(validateProviderDraft(draft, [], "zai")).toEqual({});
  });

  it("rejects an id that starts with a digit", () => {
    const draft = openProviderDraft(provider);
    draft.id = "2zai";
    expect(validateProviderDraft(draft, [], "zai").id).toBe("invalid");
  });

  it("rejects an id another provider already uses", () => {
    const draft = openProviderDraft(provider);
    draft.id = "other";
    const other: GatewayProviderWire = {
      id: "other",
      protocol: "openai",
      baseUrl: "https://other.example.com/v1",
      models: [],
    };
    expect(validateProviderDraft(draft, [provider, other], "zai").id).toBe("taken");
  });

  it("accepts the provider's own id while editing it", () => {
    const draft = openProviderDraft(provider);
    expect(validateProviderDraft(draft, [provider], "zai").id).toBeUndefined();
  });

  it("rejects a base URL that is not http", () => {
    const draft = openProviderDraft(provider);
    draft.baseUrl = "ftp://example.com";
    expect(validateProviderDraft(draft, [], "zai").baseUrl).toBe("invalid");
  });

  it("reports a missing base URL", () => {
    const draft = openProviderDraft(provider);
    draft.baseUrl = "  ";
    expect(validateProviderDraft(draft, [], "zai").baseUrl).toBe("missing");
  });

  it("rejects an extra body that is not a JSON object", () => {
    const draft = openProviderDraft(provider);
    draft.extraBody = "{ not json";
    expect(validateProviderDraft(draft, [], "zai").extraBody).toBe("invalid");
    draft.extraBody = "[1, 2]";
    expect(validateProviderDraft(draft, [], "zai").extraBody).toBe("invalid");
    draft.extraBody = '{ "ok": true }';
    expect(validateProviderDraft(draft, [], "zai").extraBody).toBeUndefined();
  });
});

describe("rate windows", () => {
  it("saves a window with sorted days and leaves every day out when none is ticked", () => {
    expect(
      parseRateWindowsDraft([{ days: [3, 1, 3], start: "09:00", end: "18:00", rate: "1.5" }]),
    ).toEqual({
      windows: [{ days: [1, 3], start: "09:00", end: "18:00", rate: 1.5 }],
    });
    expect(parseRateWindowsDraft([{ days: [], start: "22:00", end: "06:00", rate: "2" }])).toEqual({
      windows: [{ start: "22:00", end: "06:00", rate: 2 }],
    });
  });

  it("refuses a window whose time or rate is wrong", () => {
    const bad: { start: string; end: string; rate: string }[] = [
      { start: "9:0", end: "18:00", rate: "1.5" },
      { start: "09:60", end: "18:00", rate: "1.5" },
      { start: "24:00", end: "06:00", rate: "1.5" },
      { start: "09:00", end: "24:01", rate: "1.5" },
      { start: "09:00", end: "09:00", rate: "1.5" },
      { start: "09:00", end: "18:00", rate: "0" },
      { start: "09:00", end: "18:00", rate: "-1" },
      { start: "09:00", end: "18:00", rate: "1001" },
      { start: "09:00", end: "18:00", rate: "1.0005" },
      { start: "09:00", end: "18:00", rate: "abc" },
    ];
    for (const window of bad) {
      expect(parseRateWindowsDraft([{ days: [], ...window }])).toEqual({ error: "invalid" });
    }
  });

  it("accepts 24:00 as an end, and refuses more than eight windows", () => {
    expect(
      parseRateWindowsDraft([{ days: [0], start: "00:00", end: "24:00", rate: "1.5" }]),
    ).toEqual({ windows: [{ days: [0], start: "00:00", end: "24:00", rate: 1.5 }] });
    const eight = Array.from({ length: 8 }, () => ({
      days: [],
      start: "09:00",
      end: "18:00",
      rate: "1.5",
    }));
    expect("windows" in parseRateWindowsDraft(eight)).toBe(true);
    expect(parseRateWindowsDraft([...eight, ...eight.slice(0, 1)])).toEqual({
      error: "invalid",
    });
  });

  it("blocks saving with a bad window", () => {
    const draft = openProviderDraft(null);
    draft.id = "relay";
    draft.baseUrl = "https://relay.example.com/v1";
    draft.rateWindows = [{ days: [], start: "25:00", end: "18:00", rate: "1.5" }];
    expect(validateProviderDraft(draft, [], null).rateWindows).toBe("invalid");
    draft.rateWindows = [{ days: [], start: "09:00", end: "18:00", rate: "1.5" }];
    expect(validateProviderDraft(draft, [], null).rateWindows).toBeUndefined();
  });
});

describe("model prices", () => {
  const catalog = {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  };

  it("writes nothing when every field is empty", () => {
    expect(parseModelPriceDraft(emptyModelPriceDraft(), catalog)).toEqual({ price: null });
  });

  it("does not write a price identical to the catalog's", () => {
    const draft = {
      ...emptyModelPriceDraft(),
      input: "1",
      output: "2",
      cacheRead: "0.1",
      cacheWrite: "1.25",
    };
    expect(parseModelPriceDraft(draft, catalog)).toEqual({ price: null });
  });

  it("writes a price that differs, taking empty fields from the catalog", () => {
    const draft = { ...emptyModelPriceDraft(), input: "0.5" };
    expect(parseModelPriceDraft(draft, catalog)).toEqual({
      price: {
        inputPerMTok: 0.5,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
      },
    });
  });

  it("keeps a long-context price, its size read as tokens", () => {
    const draft = {
      ...emptyModelPriceDraft(),
      input: "0.5",
      tierAbove: "272K",
      tierInput: "0.8",
      tierOutput: "3",
    };
    expect(parseModelPriceDraft(draft, catalog)).toEqual({
      price: {
        inputPerMTok: 0.5,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.1,
        cacheWritePerMTok: 1.25,
        tiers: [{ aboveTokens: 272_000, inputPerMTok: 0.8, outputPerMTok: 3 }],
      },
    });
  });

  it("refuses a negative price or a long-context size that isn't one", () => {
    expect(parseModelPriceDraft({ ...emptyModelPriceDraft(), input: "-1" }, catalog).error).toBe(
      "invalid",
    );
    expect(
      parseModelPriceDraft({ ...emptyModelPriceDraft(), input: "1", tierAbove: "lots" }, catalog)
        .error,
    ).toBe("tier");
  });

  it("needs input and output when the catalog has no price", () => {
    expect(parseModelPriceDraft({ ...emptyModelPriceDraft(), cacheRead: "0.1" }, null).error).toBe(
      "invalid",
    );
  });

  it("updates every model's price, null for the ones at the catalog's", () => {
    const draft = openProviderDraft(null);
    draft.models = [{ id: "model-a" }, { id: "model-b" }];
    draft.prices = {
      "model-a": { ...emptyModelPriceDraft(), input: "1", output: "2" },
      "model-b": { ...emptyModelPriceDraft(), input: "9", output: "9" },
    };
    const updates = modelPriceUpdates(draft, {
      "model-a": { inputPerMTok: 1, outputPerMTok: 2 },
      "model-b": { inputPerMTok: 1, outputPerMTok: 2 },
    });
    expect(updates.prices).toEqual({
      "model-a": null,
      "model-b": { inputPerMTok: 9, outputPerMTok: 9 },
    });
  });
});

describe("Google Vertex AI providers", () => {
  const preset = GATEWAY_PROVIDER_PRESETS.find((entry) => entry.id === "google-vertex");

  it("opens the preset on the Gemini protocol at Google's global host", () => {
    expect(preset).toBeDefined();
    const draft = presetDraft(preset!, []);
    expect(draft.protocol).toBe("gemini");
    expect(draft.baseUrl).toBe("https://aiplatform.googleapis.com");
    expect(draft.vertex).toEqual({
      project: "",
      location: "",
      credentials: "",
      impersonate: "",
    });
    expect(draft.models).toHaveLength(20);
    expect(draft.models.map((model) => model.id)).toContain("gemini-3.8-flash");
    expect(draft.models.map((model) => model.id)).toContain("claude-opus-5-5");
  });

  it("takes the project, location and credentials into the provider", () => {
    const draft = presetDraft(preset!, []);
    draft.vertex = {
      project: " My-Proj ",
      location: "",
      credentials: " ~/.config/gcloud/adc.json ",
      impersonate: "",
    };
    const built = buildProvider(draft);
    expect(built.vertex).toEqual({
      project: "my-proj",
      location: "global",
      credentials: "~/.config/gcloud/adc.json",
    });
    expect(openProviderDraft(built).vertex).toEqual({
      project: "my-proj",
      location: "global",
      credentials: "~/.config/gcloud/adc.json",
      impersonate: "",
    });
  });

  it("refuses a Vertex provider with no project, or a location that can't be one", () => {
    const draft = presetDraft(preset!, []);
    expect(validateProviderDraft(draft, [], null).vertexProject).toBe("missing");

    draft.vertex = { project: "Bad_Id", location: "us central", credentials: "", impersonate: "" };
    expect(validateProviderDraft(draft, [], null).vertexProject).toBe("invalid");
    expect(validateProviderDraft(draft, [], null).vertexLocation).toBe("invalid");

    draft.vertex = {
      project: "my-proj-123",
      location: "us-central1",
      credentials: "",
      impersonate: "",
    };
    expect(validateProviderDraft(draft, [], null)).toEqual({});
  });

  it("writes no vertex settings for a provider that isn't one", () => {
    expect(buildProvider(openProviderDraft(provider)).vertex).toBeUndefined();
  });
});

describe("withPreservedProviderFields", () => {
  it("keeps the CLI's fields the editor doesn't show", () => {
    const before: GatewayProviderWire = {
      ...provider,
      fallback: ["other/model"],
      autoInclude: ["gpt-*"],
      quotaRest: { seconds: 900 },
      restCapMs: 600_000,
      queueLength: 3,
      stopAtCap: true,
    };
    const after = withPreservedProviderFields({ ...provider, label: "Renamed" }, before);
    expect(after).toMatchObject({
      label: "Renamed",
      fallback: ["other/model"],
      autoInclude: ["gpt-*"],
      quotaRest: { seconds: 900 },
      restCapMs: 600_000,
      queueLength: 3,
      stopAtCap: true,
    });
  });

  it("keeps nothing when there is no provider to carry from", () => {
    expect(withPreservedProviderFields(provider, undefined)).toEqual(provider);
  });
});

describe("providerCanMove", () => {
  it("moves through the full list at its ends", () => {
    expect(providerCanMove(0, 3, false)).toEqual({ up: false, down: true });
    expect(providerCanMove(1, 3, false)).toEqual({ up: true, down: true });
    expect(providerCanMove(2, 3, false)).toEqual({ up: true, down: false });
  });

  it("turns both arrows off while a search shows a subset", () => {
    expect(providerCanMove(1, 3, true)).toEqual({ up: false, down: false });
  });
});
