import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import {
  onlyPicked,
  setHiddenModels,
  setOnlyPicked,
  setPickedModels,
  setVisibleNames,
  sortedIds,
} from "./visibility.js";

const base: GatewayConfig = {
  version: 1,
  enabled: true,
  keys: [],
  visible: {},
  hiddenModels: {},
  pickedModels: {},
  providers: [
    {
      id: "anthropic",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      family: "relay",
      models: [{ id: "claude-sonnet-5-5" }],
    },
    {
      id: "deepseek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      models: [{ id: "deepseek-v4-pro" }],
    },
  ],
  groups: [],
};

describe("visibility records", () => {
  it("keys the agent lower-cased and trims, without twins", () => {
    expect(sortedIds([" b ", "a", "", "b", "a "])).toEqual(["a", "b"]);
    const records = setVisibleNames(base, " Codex ", ["relay"]);
    expect(records.visible).toEqual({ codex: ["relay"] });
  });

  it("all takes the names, hidden models and picks out", () => {
    const narrowed: GatewayConfig = {
      ...base,
      visible: { codex: ["relay"] },
      hiddenModels: { codex: ["anthropic/claude-sonnet-5-5"] },
      pickedModels: { codex: ["anthropic/claude-sonnet-5-5"] },
    };
    expect(setVisibleNames(narrowed, "codex", null)).toEqual({
      visible: {},
      hiddenModels: {},
      pickedModels: {},
    });
  });

  it("hidden models are sorted and deduplicated; none takes the key out", () => {
    expect(setHiddenModels(base, "codex", ["b/x", "a/y", "b/x"]).hiddenModels).toEqual({
      codex: ["a/y", "b/x"],
    });
    expect(setHiddenModels(base, "codex", []).hiddenModels).toEqual({});
  });

  it("only-picked is the presence of the key: an empty picked list shows nothing", () => {
    expect(onlyPicked(base, "codex")).toBe(false);
    const empty: GatewayConfig = { ...base, pickedModels: { codex: [] } };
    expect(onlyPicked(empty, "CODEX")).toBe(true);
  });
});

describe("setOnlyPicked", () => {
  it("on: the models shown now become the picks, and hidden models are dropped", () => {
    const config: GatewayConfig = {
      ...base,
      visible: { codex: ["deepseek"] },
      hiddenModels: { codex: ["deepseek/deepseek-v4-pro"] },
    };
    expect(setOnlyPicked(config, "codex", true)).toEqual({
      visible: { codex: ["deepseek"] },
      hiddenModels: {},
      pickedModels: { codex: [] },
    });
  });

  it("on keeps the names and picks the shown entries alone", () => {
    const config: GatewayConfig = { ...base, visible: { codex: ["deepseek"] } };
    expect(setOnlyPicked(config, "codex", true).pickedModels).toEqual({
      codex: ["deepseek/deepseek-v4-pro"],
    });
  });

  it("off: the listed models not picked are hidden, and a later one shows again", () => {
    const config: GatewayConfig = {
      ...base,
      visible: { codex: ["relay", "deepseek"] },
      pickedModels: { codex: ["deepseek/deepseek-v4-pro"] },
    };
    expect(setOnlyPicked(config, "codex", false)).toEqual({
      visible: { codex: ["relay", "deepseek"] },
      hiddenModels: { codex: ["anthropic/claude-sonnet-5-5"] },
      pickedModels: {},
    });
  });

  it("off with every listed model picked leaves hidden empty", () => {
    const config: GatewayConfig = {
      ...base,
      visible: { codex: ["deepseek"] },
      pickedModels: { codex: ["deepseek/deepseek-v4-pro"] },
    };
    expect(setOnlyPicked(config, "codex", false)).toEqual({
      visible: { codex: ["deepseek"] },
      hiddenModels: {},
      pickedModels: {},
    });
  });

  it("is a no-op when the switch is already where it is asked to be", () => {
    expect(setOnlyPicked(base, "codex", false).pickedModels).toEqual({});
    const only: GatewayConfig = { ...base, pickedModels: { codex: ["deepseek/deepseek-v4-pro"] } };
    expect(setOnlyPicked(only, "codex", true).pickedModels).toEqual(only.pickedModels);
  });
});

describe("setPickedModels", () => {
  it("keeps a pick of an entry not listed now", () => {
    const config: GatewayConfig = {
      ...base,
      pickedModels: { codex: ["gone/model", "deepseek/deepseek-v4-pro"] },
    };
    expect(setPickedModels(config, "codex", []).pickedModels).toEqual({
      codex: ["gone/model"],
    });
  });

  it("refuses an agent shown every model, as myna does", () => {
    expect(() => setPickedModels(base, "codex", ["anthropic/claude-sonnet-5-5"])).toThrow(
      /not only the ones picked/,
    );
  });
});
