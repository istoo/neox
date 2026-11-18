import type { AgentConnectEntry, AgentConnectModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  agentConnectStatus,
  agentLabel,
  buildRows,
  canReapply,
  isConnectBlocked,
  modelWhenToggling,
  moveProvider,
  orderAgentRows,
  providerLabelKey,
  reapplyModel,
  splitConnectedRows,
  splitHiddenRows,
  toggleHiddenModel,
  toggleHiddenProvider,
} from "./agentConnect.logic";

function entry(overrides: Partial<AgentConnectEntry> = {}): AgentConnectEntry {
  return {
    provider: "codex",
    configPath: null,
    connected: false,
    model: null,
    modelCount: 0,
    reason: null,
    ...overrides,
  };
}

const MODELS: AgentConnectModel[] = [{ id: "gpt-5" }, { id: "claude-sonnet" }];

const t = (key: string) => `t:${key}`;

describe("agent labels", () => {
  it("uses the agent's own name first", () => {
    expect(agentLabel({ provider: "custom", name: "My Agent" }, t)).toBe("My Agent");
  });

  it("translates known providers and humanizes unknown ids", () => {
    expect(agentLabel({ provider: "claude" }, t)).toBe("t:settings:agentConnect_provider_claude");
    expect(agentLabel({ provider: "my-agent" }, t)).toBe("My agent");
    expect(providerLabelKey("nope")).toBeNull();
  });
});

describe("ordering and folds", () => {
  const rows = buildRows([
    entry({ provider: "claude" }),
    entry({ provider: "codex" }),
    entry({ provider: "pi" }),
  ]);

  it("orders by the reader's list, then snapshot order", () => {
    expect(orderAgentRows(rows, ["pi", "claude"]).map((row) => row.provider)).toEqual([
      "pi",
      "claude",
      "codex",
    ]);
  });

  it("keeps snapshot order without a list", () => {
    expect(orderAgentRows(rows, undefined).map((row) => row.provider)).toEqual([
      "claude",
      "codex",
      "pi",
    ]);
  });

  it("splits hidden rows without changing their order", () => {
    const split = splitHiddenRows(rows, ["codex"]);
    expect(split.shown.map((row) => row.provider)).toEqual(["claude", "pi"]);
    expect(split.hidden.map((row) => row.provider)).toEqual(["codex"]);
  });

  it("puts connected agents first", () => {
    const split = splitConnectedRows(
      [entry({ provider: "claude" }), entry({ provider: "codex", connected: true })].map(
        (value) => ({ provider: value.provider, entry: value, external: false }),
      ),
    );
    expect(split.used.map((row) => row.provider)).toEqual(["codex"]);
    expect(split.rest.map((row) => row.provider)).toEqual(["claude"]);
  });
});

describe("status", () => {
  it("reports an agent that is not connected", () => {
    expect(agentConnectStatus(entry(), "Codex")).toEqual({
      tone: "off",
      key: "settings:agentConnect_statusDisconnected",
      params: { name: "Codex" },
    });
  });

  it("reports connected with its model count", () => {
    expect(agentConnectStatus(entry({ connected: true, modelCount: 3 }), "Codex")).toEqual({
      tone: "on",
      key: "settings:agentConnect_statusConnected",
      params: { count: 3 },
    });
  });

  it("names Claude's connection without a count", () => {
    expect(agentConnectStatus(entry({ provider: "claude", connected: true }), "Claude")).toEqual({
      tone: "on",
      key: "settings:agentConnect_statusConnectedClaude",
    });
  });

  it("treats drift as bad, before the connected state", () => {
    expect(agentConnectStatus(entry({ connected: true, drift: "stale" }), "Codex").key).toBe(
      "settings:agentConnect_statusDriftStale",
    );
    expect(agentConnectStatus(entry({ drift: "unwired" }), "Codex")).toEqual({
      tone: "bad",
      key: "settings:agentConnect_statusDriftUnwired",
      params: { name: "Codex" },
    });
  });

  it("maps remaining reasons", () => {
    expect(agentConnectStatus(entry({ reason: "unsupported" }), "x").key).toBe(
      "settings:agentConnect_statusUnsupported",
    );
    expect(agentConnectStatus(entry({ reason: "gateway_unavailable" }), "x").key).toBe(
      "settings:agentConnect_statusGatewayUnavailable",
    );
    expect(agentConnectStatus(entry({ reason: "no_gateway_models" }), "x").key).toBe(
      "settings:agentConnect_statusNoModels",
    );
  });
});

describe("model choice", () => {
  it("blocks the switch when there is no entry or no gateway model", () => {
    expect(isConnectBlocked(null, MODELS, false)).toBe(true);
    expect(isConnectBlocked(entry(), [], false)).toBe(true);
    expect(isConnectBlocked(entry(), MODELS, true)).toBe(true);
    expect(isConnectBlocked(entry(), MODELS, false)).toBe(false);
  });

  it("blocks a provider that cannot connect without being connected", () => {
    expect(isConnectBlocked(entry({ reason: "unsupported" }), MODELS, false)).toBe(true);
    expect(isConnectBlocked(entry({ reason: "unsupported", connected: true }), MODELS, false)).toBe(
      false,
    );
  });

  it("keeps the model when toggling off, drops it when turning on from off", () => {
    expect(modelWhenToggling(entry({ connected: true, model: "gpt-5" }))).toBe("gpt-5");
    expect(modelWhenToggling(entry({ connected: false, model: "gpt-5" }))).toBeNull();
  });

  it("reapplies with the model only while the gateway still serves it", () => {
    expect(reapplyModel(entry({ model: "gpt-5" }), MODELS)).toBe("gpt-5");
    expect(reapplyModel(entry({ model: "gone" }), MODELS)).toBeNull();
    expect(reapplyModel(null, MODELS)).toBeNull();
  });

  it("only offers reapply for drifting entries", () => {
    expect(canReapply(entry({ drift: "unwired" }))).toBe(true);
    expect(canReapply(entry({ drift: "stale" }))).toBe(true);
    expect(canReapply(entry({ drift: null }))).toBe(false);
  });

  it("toggles a model's visibility without mutating the input", () => {
    const hidden = ["a"];
    expect(toggleHiddenModel(hidden, "a", true)).toEqual([]);
    expect(toggleHiddenModel(hidden, "b", false)).toEqual(["a", "b"]);
    expect(toggleHiddenModel(hidden, "b", false)).not.toBe(hidden);
    expect(hidden).toEqual(["a"]);
  });

  it("toggles an agent's hidden flag", () => {
    expect(toggleHiddenProvider(["pi"], "codex", true)).toEqual(["pi", "codex"]);
    expect(toggleHiddenProvider(["pi"], "pi", true)).toEqual(["pi"]);
    expect(toggleHiddenProvider(["pi"], "pi", false)).toEqual([]);
  });
});

describe("moveProvider", () => {
  it("moves one step and stops at the ends", () => {
    expect(moveProvider(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveProvider(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveProvider(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveProvider(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });
});
