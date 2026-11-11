import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, GatewayConfigStore } from "./config.js";
import {
  autoGroupId,
  foundGroups,
  groupByRequest,
  groupsOf,
  sameModel,
  slug,
} from "./groups-auto.js";

const logger = pino({ level: "silent" });

describe("sameModel", () => {
  it("reads a model as vendors agree on it", () => {
    // myna's group_test.go: TestAutoGroupsSameModel.
    expect(sameModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(sameModel("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(sameModel("Claude-Opus-5.5")).toBe("claude-opus-5-5");
    expect(sameModel("claude-opus-5-5-20260801")).toBe("claude-opus-5-5");
    expect(sameModel("anthropic/claude-opus-5.5:batch")).toBe("claude-opus-5-5:batch");
    expect(sameModel("gpt-5.1-codex")).toBe("gpt-5-1-codex");
    expect(sameModel("v1.beta")).toBe("v1.beta");
    expect(sameModel("deepseek-v4p1")).toBe("deepseek-v4-1");
    expect(sameModel("kimi-k2-0905")).toBe("kimi-k2-0905");
  });

  it("names a found group's id with dashes", () => {
    // myna's groupid_test.go: AutoGroupID keeps Slug's dashes.
    expect(autoGroupId("gpt-6.1-sol")).toBe("auto-gpt-6-1-sol");
    expect(slug("GPT 6.1 Sol")).toBe("gpt-6-1-sol");
    expect(slug("anthropic/claude-opus-5.5")).toBe("anthropic-claude-opus-5-5");
  });
});

function configOf(value: unknown) {
  return GatewayConfigSchema.parse(value);
}

describe("foundGroups", () => {
  it("joins one model three providers spell three ways", () => {
    const config = configOf({
      providers: [
        {
          id: "openrouter",
          protocol: "openai",
          baseUrl: "https://openrouter.test/v1",
          models: [{ id: "anthropic/claude-opus-5.5" }],
        },
        {
          id: "copilot",
          protocol: "openai",
          baseUrl: "https://copilot.test/v1",
          models: [{ id: "claude-opus-5.5" }],
        },
        {
          id: "claude",
          protocol: "anthropic",
          baseUrl: "https://claude.test/v1",
          models: [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }],
        },
      ],
    });

    const groups = foundGroups(config);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "auto-claude-opus-5-5",
      label: "Claude Opus 5.5",
      auto: true,
      members: [
        "openrouter/anthropic/claude-opus-5.5",
        "copilot/claude-opus-5.5",
        "claude/claude-opus-5-5",
      ],
    });
  });

  it("leaves one provider's model alone, and joins two by Same as", () => {
    const providers = [
      {
        id: "a",
        protocol: "openai",
        baseUrl: "https://a.test/v1",
        models: [{ id: "kimi-k3" }],
      },
      {
        id: "b",
        protocol: "openai",
        baseUrl: "https://b.test/v1",
        models: [{ id: "kimi-k3" }, { id: "moonshot-v1" }],
      },
      {
        id: "c",
        protocol: "openai",
        baseUrl: "https://c.test/v1",
        models: [{ id: "glm-5", label: "GLM 5" }],
      },
    ];
    expect(foundGroups(configOf({ providers })).map((group) => group.id)).toEqual(["auto-kimi-k3"]);

    const joined = foundGroups(configOf({ providers, modelSameAs: { "c/glm-5": "moonshot-v1" } }));
    expect(joined.map((group) => [group.id, group.members.length, group.label])).toEqual([
      ["auto-kimi-k3", 2, "kimi-k3"],
      ["auto-moonshot-v1", 2, "GLM 5"],
    ]);
  });

  it("lets the user's group with the same id win, and lists theirs first", () => {
    const config = configOf({
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: "https://a.test/v1",
          models: [{ id: "kimi-k3" }],
        },
        {
          id: "b",
          protocol: "openai",
          baseUrl: "https://b.test/v1",
          models: [{ id: "kimi-k3" }],
        },
      ],
      groups: [
        { id: "mine", members: ["a/kimi-k3"] },
        { id: "auto-kimi-k3", members: ["a/kimi-k3"], label: "Mine now" },
      ],
    });

    const groups = groupsOf(config);
    expect(groups.map((group) => group.id)).toEqual(["mine", "auto-kimi-k3"]);
    expect(groups[1]?.label).toBe("Mine now");
    expect(groups[1]?.auto).toBeUndefined();
  });

  it("serves a found group by group/<id> and by auto/<model>", () => {
    const config = configOf({
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: "https://a.test/v1",
          models: [{ id: "kimi-k3" }],
        },
        {
          id: "b",
          protocol: "openai",
          baseUrl: "https://b.test/v1",
          models: [{ id: "Kimi-K3" }],
        },
      ],
    });

    expect(groupByRequest(config, "group/auto-kimi-k3")?.members).toEqual([
      "a/kimi-k3",
      "b/Kimi-K3",
    ]);
    expect(groupByRequest(config, "auto/Kimi-K3[1m]")?.id).toBe("auto-kimi-k3");
    expect(groupByRequest(config, "auto/nope")).toBeNull();
    expect(groupByRequest(config, "gpt-5")).toBeNull();
  });

  it("honours the auto-group settings: off, skip, hidden and order", () => {
    const base = {
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: "https://a.test/v1",
          models: [{ id: "kimi-k3" }],
        },
        {
          id: "b",
          protocol: "openai",
          baseUrl: "https://b.test/v1",
          models: [{ id: "kimi-k3" }],
        },
      ],
      groups: [{ id: "mine", members: ["a/kimi-k3"] }],
    };
    expect(groupsOf(configOf(base)).map((group) => group.id)).toEqual(["mine", "auto-kimi-k3"]);
    // Off: the found groups are gone, the user's stay.
    expect(groupsOf(configOf({ ...base, autoGroups: false })).map((group) => group.id)).toEqual([
      "mine",
    ]);
    // A skipped provider leaves nothing to pair with.
    expect(groupsOf(configOf({ ...base, autoGroupSkip: ["b"] })).map((group) => group.id)).toEqual([
      "mine",
    ]);
    // Hidden: the id is kept so it doesn't come back unasked.
    expect(
      groupsOf(configOf({ ...base, hiddenGroups: ["auto-kimi-k3"] })).map((group) => group.id),
    ).toEqual(["mine"]);
    // Order: named ids first, the rest after in their own order.
    expect(
      groupsOf(configOf({ ...base, groupOrder: ["auto-kimi-k3"] })).map((group) => group.id),
    ).toEqual(["auto-kimi-k3", "mine"]);
  });

  it("never writes a group the gateway found", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-auto-groups-"));
    const store = new GatewayConfigStore({ neolixHome: home, logger });
    await store.start();
    await store.write({
      providers: [
        {
          id: "a",
          protocol: "openai",
          baseUrl: "https://a.test/v1",
          models: [{ id: "kimi-k3" }],
        },
        {
          id: "b",
          protocol: "openai",
          baseUrl: "https://b.test/v1",
          models: [{ id: "kimi-k3" }],
        },
      ],
      groups: [
        { id: "mine", members: ["a/kimi-k3"] },
        { id: "auto-kimi-k3", members: ["a/kimi-k3", "b/kimi-k3"], auto: true },
      ],
    });

    expect(store.get().groups.map((group) => group.id)).toEqual(["mine"]);
    expect(groupsOf(store.get()).map((group) => group.id)).toEqual(["mine", "auto-kimi-k3"]);
    store.dispose();
  });
});
