import { describe, expect, it } from "vitest";
import { resetAntigravityPool, setAntigravityPool } from "./antigravity-pool.js";
import {
  bestInFamily,
  compileGroupPattern,
  fallbackCandidates,
  listGatewayModels,
  modelFamily,
  resolveGatewayCandidates,
} from "./catalog.js";
import type { GatewayConfig, GatewayModel } from "./config.js";

const config: GatewayConfig = {
  version: 1,
  enabled: true,
  keys: [],
  providers: [
    {
      id: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", contextWindow: 200000 }],
    },
    {
      id: "deepseek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-v4-pro" }],
    },
  ],
  groups: [
    { id: "daily", members: ["anthropic/claude-sonnet-5-5", "deepseek/deepseek-v4-pro"] },
    { id: "nested", members: ["group/daily", "deepseek/deepseek-v4-pro"] },
  ],
};

describe("Antigravity's pooled models in the catalog", () => {
  it("lists and resolves a pooled model the provider's config never wrote", () => {
    const pooled: GatewayConfig = {
      ...config,
      providers: [
        {
          id: "antigravity",
          protocol: "gemini",
          baseUrl: "https://example.test",
          models: [],
          accounts: [
            {
              id: "main",
              weight: 1,
              priority: 0,
              enabled: true,
              models: [],
              agent: "antigravity",
            },
          ],
        },
      ],
      groups: [],
    };
    setAntigravityPool({
      accounts: {},
      pooled: [{ id: "gemini-3.8-flash", context: 1_000_000 }],
    });
    try {
      expect(listGatewayModels(pooled).map((entry) => entry.id)).toEqual([
        "antigravity/gemini-3.8-flash",
      ]);
      expect(
        resolveGatewayCandidates(pooled, "antigravity/gemini-3.8-flash").map(
          (entry) => entry.model.id,
        ),
      ).toEqual(["gemini-3.8-flash"]);
    } finally {
      resetAntigravityPool();
    }
  });
});

describe("fallbackCandidates", () => {
  it("takes the provider's fallbacks in order, without itself or repeats", () => {
    const withFallback: GatewayConfig = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "anthropic"
          ? { ...provider, fallback: ["deepseek/deepseek-v4-pro", "group/daily", "nope/x"] }
          : provider,
      ),
    };
    expect(fallbackCandidates(withFallback, "anthropic").map((entry) => entry.model.id)).toEqual([
      "deepseek-v4-pro",
    ]);
  });

  it("answers nothing for a provider with no fallbacks", () => {
    expect(fallbackCandidates(config, "deepseek")).toEqual([]);
  });
});

describe("group match patterns", () => {
  it("matches a pattern whole, in any case", () => {
    expect(compileGroupPattern("anthropic/*")?.test("anthropic/claude-sonnet-5-5")).toBe(true);
    expect(compileGroupPattern("ANTHROPIC/CLAUDE-*")?.test("anthropic/claude-sonnet-5-5")).toBe(
      true,
    );
    expect(compileGroupPattern("sonnet")?.test("anthropic/claude-sonnet-5-5")).toBe(false);
    expect(compileGroupPattern("re:.*sonnet.*")?.test("anthropic/claude-sonnet-5-5")).toBe(true);
    expect(compileGroupPattern("re:sonnet")?.test("anthropic/claude-sonnet-5-5")).toBe(false);
  });
});

describe("listGatewayModels", () => {
  it("lists provider models and routing groups", () => {
    const ids = listGatewayModels(config).map((entry) => entry.id);
    expect(ids).toEqual([
      "anthropic/claude-sonnet-5-5",
      "deepseek/deepseek-v4-pro",
      "group/daily",
      "group/nested",
    ]);
  });

  it("tags a provider's models with its family, and a group's with the group's", () => {
    const tagged: GatewayConfig = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "deepseek" ? Object.assign({}, provider, { family: "ds" }) : provider,
      ),
      groups: (config.groups ?? []).map((group, index) =>
        index === 0 ? Object.assign({}, group, { family: "daily-team" }) : group,
      ),
    };
    const byId = new Map(listGatewayModels(tagged).map((entry) => [entry.id, entry]));
    expect(byId.get("deepseek/deepseek-v4-pro")?.family).toBe("ds");
    expect(byId.get("anthropic/claude-sonnet-5-5")?.family).toBeUndefined();
    expect(byId.get("group/daily")?.family).toBe("daily-team");
  });

  it("leaves out a provider that was switched off", () => {
    const off: GatewayConfig = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "deepseek" ? Object.assign({}, provider, { enabled: false }) : provider,
      ),
    };
    expect(listGatewayModels(off).map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet-5-5",
      "group/daily",
      "group/nested",
    ]);
  });

  it("keeps a group's members and a pattern's models out when it lists alone", () => {
    const unlisted: GatewayConfig = {
      ...config,
      groups: [
        {
          id: "only",
          members: ["anthropic/claude-sonnet-5-5"],
          match: ["deepseek/*"],
          unlists: true,
        },
      ],
    };
    expect(listGatewayModels(unlisted).map((entry) => entry.id)).toEqual(["group/only"]);
  });

  it("carries the context window through to the catalog entry", () => {
    const entry = listGatewayModels(config).find(
      (item) => item.id === "anthropic/claude-sonnet-5-5",
    );
    expect(entry?.context_window).toBe(200000);
    expect(entry?.owned_by).toBe("anthropic");
  });
});

describe("resolveGatewayCandidates", () => {
  it("resolves a provider-qualified model", () => {
    const candidates = resolveGatewayCandidates(config, "deepseek/deepseek-v4-pro");
    expect(candidates.map((candidate) => candidate.provider.id)).toEqual(["deepseek"]);
  });

  it("tries a provider of the user's own on each address it names", () => {
    const wired: GatewayConfig = {
      ...config,
      providers: [
        ...config.providers,
        {
          id: "own",
          protocol: "openai",
          baseUrl: "https://main.example/v1",
          wires: {
            anthropic: "https://anthropic.example/v1",
            "openai-responses": "https://responses.example/v1",
          },
          models: [{ id: "m" }],
        },
      ],
    };
    const candidates = resolveGatewayCandidates(wired, "own/m");
    expect(
      candidates.map((candidate) => [candidate.provider.protocol, candidate.provider.baseUrl]),
    ).toEqual([
      ["anthropic", "https://anthropic.example/v1"],
      ["openai-responses", "https://responses.example/v1"],
    ]);
  });

  it("resolves a bare model id to the first provider that has it", () => {
    const candidates = resolveGatewayCandidates(config, "claude-sonnet-5-5");
    expect(candidates[0]?.provider.id).toBe("anthropic");
  });

  it("expands a group in member order", () => {
    const candidates = resolveGatewayCandidates(config, "group/daily");
    expect(candidates.map((candidate) => candidate.model.id)).toEqual([
      "claude-sonnet-5-5",
      "deepseek-v4-pro",
    ]);
  });

  it("expands nested groups", () => {
    const candidates = resolveGatewayCandidates(config, "group/nested");
    expect(candidates.map((candidate) => candidate.provider.id)).toEqual([
      "anthropic",
      "deepseek",
      "deepseek",
    ]);
  });

  it("rejects a group cycle instead of returning a partial list", () => {
    const cyclic: GatewayConfig = {
      ...config,
      groups: [
        { id: "a", members: ["group/b"] },
        { id: "b", members: ["group/a"] },
      ],
    };
    expect(() => resolveGatewayCandidates(cyclic, "group/a")).toThrow(/cycle/);
  });

  it("rejects an unknown model", () => {
    expect(() => resolveGatewayCandidates(config, "nope/nope")).toThrow(/Unknown model/);
  });

  it("leaves an unexposed provider's models out of the catalog", () => {
    const hidden: GatewayConfig = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "deepseek"
          ? Object.assign({}, provider, { exposeModels: false })
          : provider,
      ),
    };
    expect(listGatewayModels(hidden).map((entry) => entry.id)).toEqual([
      "anthropic/claude-sonnet-5-5",
      "group/daily",
      "group/nested",
    ]);
    expect(resolveGatewayCandidates(hidden, "deepseek/deepseek-v4-pro")).toHaveLength(1);
  });

  it("does not route to a provider that was switched off", () => {
    const off: GatewayConfig = {
      ...config,
      providers: config.providers.map((provider) =>
        provider.id === "deepseek" ? Object.assign({}, provider, { enabled: false }) : provider,
      ),
    };
    expect(() => resolveGatewayCandidates(off, "deepseek/deepseek-v4-pro")).toThrow(
      /Unknown model/,
    );
  });
});

const multiModel: GatewayConfig = {
  version: 1,
  enabled: true,
  keys: [],
  providers: [
    {
      id: "relay",
      protocol: "openai",
      baseUrl: "https://relay.example.com/v1",
      models: [
        { id: "claude-opus-4-5" },
        { id: "claude-opus-5-5" },
        { id: "claude-haiku-4-5", picked: true },
        { id: "gpt-5-1" },
        { id: "gpt-5-2" },
      ],
    },
  ],
  groups: [],
};

function withMode(mode: "list" | "picked" | "best" | "none"): GatewayConfig {
  return {
    ...multiModel,
    providers: multiModel.providers.map((provider) =>
      Object.assign({}, provider, { modelMode: mode }),
    ),
  };
}

describe("model modes", () => {
  it("serves every model in the vendor's list mode", () => {
    expect(listGatewayModels(withMode("list")).map((entry) => entry.id)).toEqual([
      "relay/claude-opus-4-5",
      "relay/claude-opus-5-5",
      "relay/claude-haiku-4-5",
      "relay/gpt-5-1",
      "relay/gpt-5-2",
    ]);
  });

  it("serves only the picked models", () => {
    expect(listGatewayModels(withMode("picked")).map((entry) => entry.id)).toEqual([
      "relay/claude-haiku-4-5",
    ]);
    expect(() => resolveGatewayCandidates(withMode("picked"), "relay/gpt-5-2")).toThrow(
      /Unknown model/,
    );
  });

  it("serves the newest model of each family", () => {
    expect(listGatewayModels(withMode("best")).map((entry) => entry.id)).toEqual([
      "relay/claude-opus-5-5",
      "relay/claude-haiku-4-5",
      "relay/gpt-5-2",
    ]);
    expect(() => resolveGatewayCandidates(withMode("best"), "relay/gpt-5-1")).toThrow(
      /Unknown model/,
    );
  });

  it("serves nothing in usage-only mode, even by its full name", () => {
    expect(listGatewayModels(withMode("none"))).toEqual([]);
    expect(() => resolveGatewayCandidates(withMode("none"), "relay/gpt-5-2")).toThrow(
      /Unknown model/,
    );
  });
});

describe("modelFamily", () => {
  // The ids are real: models.dev's, Codex's own list and Bedrock's.
  it("reads the family, its version, snapshot and preview off an id", () => {
    const cases: [string, string, number[], string, boolean][] = [
      ["claude-opus-4-8", "claude-opus", [4, 8], "", false],
      ["claude-opus-5-5", "claude-opus", [5, 5], "", false],
      ["claude-opus-5", "claude-opus", [5], "", false],
      // A dated snapshot is its alias.
      ["claude-opus-4-5-20251101", "claude-opus", [4, 5], "20251101", false],
      ["claude-haiku-4-5-20251001", "claude-haiku", [4, 5], "20251001", false],
      ["gpt-4o-2024-08-06", "gpt-o", [4], "2024-08-06", false],
      ["deepseek-r1-0528", "deepseek-r", [1], "0528", false],
      ["qwen3-235b-a22b-instruct-2507", "qwen-235b-a22b-instruct", [3], "2507", false],
      ["gemini-2.5-flash-preview-05-20", "gemini-flash", [2, 5], "05-20", true],
      ["gemini-embedding-001", "gemini-embedding", [], "001", false],
      ["command-r7b-12-2024", "command-r7b", [], "12-2024", false],
      // The version mid-name.
      ["claude-3-5-sonnet-20241022", "claude-sonnet", [3, 5], "20241022", false],
      ["meta-llama/llama-3.3-70b-instruct", "meta-llama/llama-70b-instruct", [3, 3], "", false],
      // Sizes and suffixes stay in the name.
      ["gpt-5.4-mini", "gpt-mini", [5, 4], "", false],
      ["gpt-5.5-pro", "gpt-pro", [5, 5], "", false],
      ["gpt-4.1-nano", "gpt-nano", [4, 1], "", false],
      ["gpt-5.3-codex-spark", "gpt-codex-spark", [5, 3], "", false],
      ["qwen3.6-27b", "qwen-27b", [3, 6], "", false],
      ["qwen3.6-35b-a3b", "qwen-35b-a3b", [3, 6], "", false],
      ["mistralai/mixtral-8x7b-instruct", "mistralai/mixtral-8x7b-instruct", [], "", false],
      ["gemma-3n-e4b-it", "gemma-n-e4b-it", [3], "", false],
      // Gemini: flash, flash-lite and pro are three.
      ["gemini-3.5-flash", "gemini-flash", [3, 5], "", false],
      ["gemini-3.5-flash-lite", "gemini-flash-lite", [3, 5], "", false],
      ["gemini-3.1-pro-preview", "gemini-pro", [3, 1], "", true],
      ["gemini-pro-latest", "gemini-pro", [], "", false],
      // The o-series.
      ["o3", "o", [3], "", false],
      ["o4-mini", "o-mini", [4], "", false],
      ["o1-pro", "o-pro", [1], "", false],
      // A word that ends in its version.
      ["kimi-k2.6", "kimi-k", [2, 6], "", false],
      ["glm-4.6v", "glm-v", [4, 6], "", false],
      ["deepseek-v4-flash", "deepseek-flash", [4], "", false],
      // A provider prefix stays.
      ["anthropic/claude-opus-4.5", "anthropic/claude-opus", [4, 5], "", false],
      [
        "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        "us.anthropic.claude-sonnet",
        [4, 5, 1, 0],
        "20250929",
        false,
      ],
      ["Qwen/Qwen3.8-27B", "qwen/qwen-27b", [3, 8], "", false],
      ["claude-sonnet-4-5[1m]", "claude-sonnet[1m", [4, 5], "", false],
    ];
    for (const [id, name, version, snapshot, preview] of cases) {
      expect({ id, family: modelFamily(id) }).toEqual({
        id,
        family: { name, version, snapshot, preview },
      });
    }
  });

  it("keeps different models apart", () => {
    const pairs: [string, string][] = [
      ["gpt-5.4", "gpt-5.4-mini"],
      ["gpt-5.4-mini", "gpt-5.4-nano"],
      ["gpt-5.5", "gpt-5.5-pro"],
      ["gpt-4", "gpt-4o"],
      ["o3", "o3-mini"],
      ["o3", "o3-pro"],
      ["gemini-3.5-flash", "gemini-3.1-pro-preview"],
      ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
      ["qwen3-8b", "qwen3-32b"],
      ["llama-3.1-8b-instruct", "llama-3.1-70b-instruct"],
      ["gpt-6.1-sol", "gpt-6.1-terra"],
      ["claude-opus-5-5", "claude-sonnet-5-5"],
      ["kimi-k2-thinking", "kimi-k2"],
      ["openai/gpt-5", "azure/gpt-5"],
      ["deepseek/deepseek-r1:free", "deepseek/deepseek-r1"],
    ];
    for (const [left, right] of pairs) {
      expect({ left: modelFamily(left).name, right: modelFamily(right).name }).not.toEqual({
        left: modelFamily(right).name,
        right: modelFamily(left).name,
      });
    }
  });
});

function model(id: string, released?: string): GatewayModel {
  return released === undefined ? { id } : { id, released };
}

describe("bestInFamily", () => {
  it("keeps the newest of each family in the list's order", () => {
    const cases: { name: string; input: GatewayModel[]; want: string[] }[] = [
      {
        name: "codex",
        input: [
          "gpt-6.1-sol",
          "gpt-6-astra",
          "gpt-6-sol",
          "gpt-6-luna",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
        ].map((id) => model(id)),
        want: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"],
      },
      // A newer one listed takes the old one's place by itself.
      {
        name: "opus 5.6",
        input: ["claude-opus-5-6", "claude-opus-5-5", "claude-sonnet-5-5"].map((id) => model(id)),
        want: ["claude-opus-5-6", "claude-sonnet-5-5"],
      },
      {
        name: "openai sizes",
        input: [
          "gpt-5.6",
          "gpt-5.5",
          "gpt-5.4-mini",
          "gpt-5-mini",
          "gpt-4.1-nano",
          "gpt-5.4-nano",
          "gpt-5.5-pro",
          "gpt-5-pro",
        ].map((id) => model(id)),
        want: ["gpt-5.6", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5-pro"],
      },
      {
        name: "o-series",
        input: ["o1", "o3", "o3-mini", "o4-mini", "o1-pro", "o3-pro"].map((id) => model(id)),
        want: ["o3", "o4-mini", "o3-pro"],
      },
      {
        name: "gemini",
        input: [
          "gemini-2.5-flash",
          "gemini-3.5-flash",
          "gemini-2.5-pro",
          "gemini-3.1-pro-preview",
          "gemini-3.1-flash-lite-preview",
          "gemini-3.1-flash-lite",
          "gemini-pro-latest",
        ].map((id) => model(id)),
        want: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"],
      },
      // At one version, a release over its preview.
      {
        name: "preview",
        input: ["gemini-3-pro-image-preview", "gemini-3-pro-image"].map((id) => model(id)),
        want: ["gemini-3-pro-image"],
      },
      // The alias over its dated snapshots, whatever their dates say.
      {
        name: "snapshots",
        input: [
          model("gpt-4o", "2024-05-13"),
          model("gpt-4o-2024-08-06", "2024-08-06"),
          model("gpt-4o-2024-11-20", "2024-11-20"),
        ],
        want: ["gpt-4o"],
      },
      {
        name: "snapshots alone",
        input: [
          model("mistral-medium-2505", "2025-05-07"),
          model("mistral-medium-2508", "2025-08-12"),
        ],
        want: ["mistral-medium-2508"],
      },
      {
        name: "qwen sizes",
        input: [
          "Qwen/Qwen3.5-27B",
          "Qwen/Qwen3.6-27B",
          "Qwen/Qwen3.8-27B",
          "Qwen/Qwen3.6-35B-A3B",
          "Qwen/Qwen3.5-35B-A3B",
        ].map((id) => model(id)),
        want: ["Qwen/Qwen3.8-27B", "Qwen/Qwen3.6-35B-A3B"],
      },
      {
        name: "mid-name version",
        input: ["claude-3-5-sonnet-20241022", "claude-sonnet-4-5"].map((id) => model(id)),
        want: ["claude-sonnet-4-5"],
      },
      {
        name: "bedrock",
        input: [
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          "us.anthropic.claude-sonnet-5-5",
          "us.meta.llama3-1-70b-instruct-v1:0",
          "us.meta.llama3-3-70b-instruct-v1:0",
        ].map((id) => model(id)),
        want: ["us.anthropic.claude-sonnet-5-5", "us.meta.llama3-3-70b-instruct-v1:0"],
      },
      {
        name: "provider prefix",
        input: ["openai/gpt-5.5", "openai/gpt-5.6", "azure/gpt-5.5"].map((id) => model(id)),
        want: ["openai/gpt-5.6", "azure/gpt-5.5"],
      },
      // Anthropic's list as models.dev had it: one of each family.
      {
        name: "claude families",
        input: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"].map(
          (id) => model(id),
        ),
        want: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"],
      },
      { name: "none", input: [], want: [] },
    ];
    for (const entry of cases) {
      expect({ name: entry.name, ids: bestInFamily(entry.input).map((item) => item.id) }).toEqual({
        name: entry.name,
        ids: entry.want,
      });
    }
  });

  it("keeps the first listed of two identical ids", () => {
    const models = [model("dup"), model("other"), model("dup")];
    expect(bestInFamily(models)).toEqual([models[0], models[1]]);
  });
});

describe("listed=no", () => {
  it("takes a group's models out of the lists agents see, keeping the group", () => {
    const unlisted: GatewayConfig = {
      ...config,
      groups: [
        ...config.groups!,
        {
          id: "quiet",
          members: ["anthropic/claude-sonnet-5-5"],
          strategy: "order",
          unlists: true,
        },
      ],
    };
    const ids = listGatewayModels(unlisted).map((entry) => entry.id);
    expect(ids).not.toContain("anthropic/claude-sonnet-5-5");
    expect(ids).toContain("group/quiet");
  });
});

describe("per-agent visibility", () => {
  const tagged: GatewayConfig = {
    ...config,
    providers: config.providers!.map((provider) =>
      provider.id === "anthropic" ? Object.assign({}, provider, { family: "relay" }) : provider,
    ),
  };

  it("narrows an agent's list to the families and ids it names", () => {
    const ids = listGatewayModels({ ...tagged, visible: { codex: ["relay"] } }, "codex").map(
      (entry) => entry.id,
    );
    expect(ids).toContain("anthropic/claude-sonnet-5-5");
    expect(ids).not.toContain("deepseek/deepseek-v4-pro");
    expect(ids).not.toContain("group/daily");
  });

  it("names a group by its id or group/<id>", () => {
    for (const name of ["daily", "group/daily"]) {
      const ids = listGatewayModels({ ...tagged, visible: { codex: [name] } }, "codex").map(
        (entry) => entry.id,
      );
      expect(ids).toEqual(["group/daily"]);
    }
  });

  it("takes the models an agent hides out one by one", () => {
    const ids = listGatewayModels(
      { ...tagged, hiddenModels: { codex: ["anthropic/claude-sonnet-5-5"] } },
      "codex",
    ).map((entry) => entry.id);
    expect(ids).not.toContain("anthropic/claude-sonnet-5-5");
    expect(ids).toContain("deepseek/deepseek-v4-pro");
  });

  it("shows only the models picked for an agent with an entry in pickedModels", () => {
    const ids = listGatewayModels(
      { ...tagged, pickedModels: { codex: ["deepseek/deepseek-v4-pro"] } },
      "codex",
    ).map((entry) => entry.id);
    expect(ids).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("leaves an agent it does not name seeing everything", () => {
    const all = listGatewayModels(tagged).map((entry) => entry.id);
    expect(listGatewayModels(tagged, "codex").map((entry) => entry.id)).toEqual(all);
  });
});
