import { describe, expect, it, vi } from "vitest";
import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { createAgentsCommand } from "./list.js";
import { GatewayConfigSchema } from "@neolix/server/gateway-config";
import {
  AGENT_ALIASES,
  AGENT_COMMAND_IDS,
  agentHelpText,
  canonicalAgentId,
  flagArgument,
  staticAgentLabel,
} from "./shared.js";
import { familiesOf, modelsNamed, modelsShown, servedModelIds, visibleNameMap } from "./visible.js";
import { changedCount, profileSummary } from "./profiles.js";

const CONFIG = GatewayConfigSchema.parse({
  providers: [
    {
      id: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.example/v1",
      apiKey: "sk-openai",
      family: "relay",
      models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
    },
    {
      id: "claude-go",
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.example",
      apiKey: "sk-claude",
      family: "relay",
      modelMode: "picked",
      models: [{ id: "sonnet", picked: true }, { id: "opus" }],
    },
    {
      id: "off",
      protocol: "openai",
      baseUrl: "https://off.example/v1",
      apiKey: "sk-off",
      enabled: false,
      models: [{ id: "hidden" }],
    },
  ],
  groups: [
    {
      id: "gpt-plus",
      members: ["openai/gpt-5:high", "claude-go/sonnet"],
      family: "relay",
    },
  ],
});

describe("agent commands", () => {
  it("takes myna's agent names and their short forms", () => {
    for (const id of ["claude", "codex", "gemini", "opencode", "pi", "copilot", "aside"]) {
      expect(AGENT_COMMAND_IDS).toContain(id);
    }
    expect(canonicalAgentId("cc")).toBe("claude");
    expect(canonicalAgentId("oc")).toBe("opencode");
    expect(Object.keys(AGENT_ALIASES).sort()).toEqual(["cc", "oc"]);
    expect(staticAgentLabel("claude")).toBe("Claude");
  });

  it("prints myna's agent forms and every field the agent writes", () => {
    const help = agentHelpText("codex", "Codex");
    expect(help).toContain("neox codex <model>");
    expect(help).toContain("neox codex default");
    expect(help).toContain("neox codex <field> default");
    expect(help).toContain("fields: model, effort, subagent, subagent_model");
    expect(help).toContain("memories, login");
    expect(agentHelpText("pi", "Pi")).toContain("fields: model");
  });

  it("reads -h, --help and help as help, not an agent name", async () => {
    for (const word of ["-h", "--help", "help"]) {
      const printed: string[] = [];
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          printed.push(String(chunk));
          return true;
        });
      try {
        await createAgentsCommand().parseAsync([word], { from: "user" });
      } finally {
        write.mockRestore();
      }
      expect(printed.join("")).toContain("Usage: agents");
      expect(printed.join("")).not.toContain('no agent "--help"');
    }
  });

  it("refuses a flag as a model or a field's value, but not a negative number", () => {
    expect(flagArgument(["--verbose"])).toBe("--verbose");
    expect(flagArgument(["deepseek/deepseek-v4-pro"])).toBeNull();
    expect(flagArgument(["-1"])).toBeNull();
  });
});

describe("visible", () => {
  it("serves the models each provider's mode exposes", () => {
    expect(servedModelIds(CONFIG)).toEqual([
      "openai/gpt-5",
      "openai/gpt-5-mini",
      "claude-go/sonnet",
    ]);
  });

  it("names providers, families and groups, the hints' spelling included", () => {
    expect(modelsNamed(CONFIG, ["openai"])).toEqual({
      ids: ["openai/gpt-5", "openai/gpt-5-mini"],
    });
    expect(modelsNamed(CONFIG, ["relay"])).toEqual({
      ids: ["openai/gpt-5", "openai/gpt-5-mini", "claude-go/sonnet"],
    });
    expect(modelsNamed(CONFIG, ["group/gpt-plus"])).toEqual({
      ids: ["openai/gpt-5", "claude-go/sonnet"],
    });
    expect(modelsNamed(CONFIG, ["nope"])).toEqual({ unknown: "nope" });
    expect(visibleNameMap(CONFIG).has("off")).toBe(true);
  });

  it("lists each family once", () => {
    expect(familiesOf(CONFIG)).toEqual(["relay"]);
  });

  it("reads the root records: narrowed, hidden, and only picked", () => {
    const all = modelsShown(CONFIG, "codex");
    expect(all.shown).toBe(4);
    expect(all.hidden).toEqual([]);

    const narrowed = modelsShown({ ...CONFIG, visible: { codex: ["openai"] } }, "codex");
    expect(narrowed.shown).toBe(2);
    expect(narrowed.hidden).toEqual(["claude-go/sonnet", "group/gpt-plus"]);

    const hidden = modelsShown({ ...CONFIG, hiddenModels: { codex: ["openai/gpt-5"] } }, "codex");
    expect(hidden.shown).toBe(3);
    expect(hidden.hidden).toEqual(["openai/gpt-5"]);

    const picked = modelsShown(
      { ...CONFIG, pickedModels: { codex: ["openai/gpt-5-mini"] } },
      "codex",
    );
    expect(picked.shown).toBe(1);
    expect(picked.hidden).toEqual(["openai/gpt-5", "claude-go/sonnet", "group/gpt-plus"]);
  });
});

function snapshotOf(
  entries: Array<{ provider: string; connected: boolean; model: string | null }>,
): AgentConnectSnapshot {
  return {
    gatewayBaseUrl: "http://127.0.0.1:6768",
    models: [],
    entries: entries.map((entry) => ({
      ...entry,
      configPath: null,
      modelCount: entry.connected ? 2 : 0,
      reason: null,
    })),
    profiles: [],
    error: null,
  };
}

describe("profiles", () => {
  it("sums a profile as myna does: each set agent's model, then the library", () => {
    const summary = profileSummary({
      name: "work",
      savedAt: 1,
      agents: {
        codex: { connected: true, model: "deepseek/deepseek-v4-pro" },
        claude: { connected: false, model: null },
      },
      library: { mcpHub: true },
    });
    expect(summary).toBe("Codex deepseek/deepseek-v4-pro · + the library's setup");
    const withAgents = profileSummary({
      name: "work",
      savedAt: 1,
      agents: {
        codex: { connected: true, model: "deepseek/deepseek-v4-pro" },
        claude: { connected: true, model: "group/fast" },
      },
    });
    expect(withAgents).toBe("Claude group/fast · Codex deepseek/deepseek-v4-pro");
  });

  it("counts the agents a profile moved", () => {
    const before = snapshotOf([
      { provider: "claude", connected: false, model: null },
      { provider: "codex", connected: true, model: "a" },
    ]);
    const after = snapshotOf([
      { provider: "claude", connected: true, model: "b" },
      { provider: "codex", connected: true, model: "a" },
    ]);
    expect(changedCount(before, after)).toBe(1);
    expect(changedCount(before, before)).toBe(0);
  });
});
