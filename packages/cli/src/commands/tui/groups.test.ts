import { describe, expect, it } from "vitest";
import type { TuiGatewayConfig, TuiGroup } from "./data.js";
import { groupMemberOptions, movedGroupEntry } from "./groups.js";

const config: TuiGatewayConfig = {
  version: 1,
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      protocol: "openai",
      baseUrl: "https://api.openai.test",
      models: [{ id: "gpt-5" }, { id: "mini" }],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.test",
      models: [{ id: "claude" }],
    },
  ],
  groups: [
    { id: "work", label: "Work", members: ["openai/gpt-5"] },
    { id: "other", label: "Other", members: ["openai/mini"] },
  ],
};

function group(overrides: Partial<TuiGroup> = {}): TuiGroup {
  return {
    id: "work",
    members: ["openai/gpt-5", "openai/mini"],
    rules: [{ use: "openai/gpt-5" }, { use: "openai/mini" }],
    ...overrides,
  };
}

describe("routing group entries", () => {
  it("swaps two members and keeps the rules", () => {
    expect(movedGroupEntry(group(), 0, 1)).toEqual({
      cursor: 1,
      members: ["openai/mini", "openai/gpt-5"],
    });
  });

  it("swaps two rules and keeps the members", () => {
    expect(movedGroupEntry(group(), 2, 1)).toEqual({
      cursor: 3,
      rules: [{ use: "openai/mini" }, { use: "openai/gpt-5" }],
    });
  });

  it("never moves a member into the rules or a rule into the members", () => {
    expect(movedGroupEntry(group(), 1, 1)).toBeNull();
    expect(movedGroupEntry(group(), 2, -1)).toBeNull();
    expect(movedGroupEntry(group(), 0, -1)).toBeNull();
    expect(movedGroupEntry(group(), 3, 1)).toBeNull();
  });

  it("offers models only for a classifier", () => {
    const values = groupMemberOptions(config, group(), true).map((item) => item.value);
    expect(values).toEqual(["anthropic/claude"]);
  });

  it("offers other groups when adding a member", () => {
    const values = groupMemberOptions(config, group()).map((item) => item.value);
    expect(values).toEqual(["anthropic/claude", "group/other"]);
  });
});
