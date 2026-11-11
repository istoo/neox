import { describe, expect, it } from "vitest";
import {
  AgentConnectChangedSchema,
  AgentConnectGetResponseSchema,
  AgentConnectLayoutSetRequestSchema,
  AgentConnectSetRequestSchema,
  AgentConnectShellRequestSchema,
  AgentConnectShellResponseSchema,
  AgentConnectSnapshotSchema,
} from "./agent-connect.js";

const snapshot = {
  gatewayBaseUrl: "http://127.0.0.1:6768",
  models: [{ id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" }],
  entries: [
    {
      provider: "claude",
      configPath: "/home/user/.claude/settings.json",
      connected: true,
      model: "deepseek/deepseek-v4-pro",
      modelCount: 1,
      reason: null,
    },
    {
      provider: "copilot",
      configPath: null,
      connected: false,
      model: null,
      modelCount: 0,
      reason: "unsupported",
    },
  ],
  profiles: [
    {
      name: "Work",
      savedAt: 1,
      agents: { claude: { connected: true, model: "deepseek/deepseek-v4-pro" } },
    },
  ],
  error: null,
};

describe("agent connect protocol", () => {
  it("parses a snapshot written by a newer host, extra fields included", () => {
    const parsed = AgentConnectSnapshotSchema.parse({
      ...snapshot,
      future: true,
      entries: [{ ...snapshot.entries[0], note: "ignored" }],
    });
    expect(parsed.entries[0]?.provider).toBe("claude");
    expect(parsed.models[0]?.label).toBe("DeepSeek V4 Pro");
    expect(parsed.profiles[0]?.agents.claude?.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("keeps the model optional on a set request", () => {
    const parsed = AgentConnectSetRequestSchema.parse({
      type: "agent.connect.set.request",
      requestId: "req_1",
      provider: "pi",
      connected: true,
    });
    expect(parsed.model).toBeUndefined();
  });

  it("parses a get response payload", () => {
    const parsed = AgentConnectGetResponseSchema.parse({
      type: "agent.connect.get.response",
      payload: { requestId: "req_2", snapshot },
    });
    expect(parsed.payload.snapshot.entries).toHaveLength(2);
  });

  it("parses the shell-function RPC and its answer", () => {
    const request = AgentConnectShellRequestSchema.parse({
      type: "agent.connect.shell.request",
      requestId: "req_shell",
      provider: "agy",
      enabled: true,
    });
    expect(request.enabled).toBe(true);

    const response = AgentConnectShellResponseSchema.parse({
      type: "agent.connect.shell.response",
      payload: {
        requestId: "req_shell",
        snapshot: {
          ...snapshot,
          entries: [
            {
              provider: "agy",
              configPath: "/home/user/.gemini/antigravity-cli/settings.json",
              connected: true,
              model: "deepseek/deepseek-v4-pro",
              modelCount: 1,
              reason: null,
              kind: "external",
              name: "Antigravity CLI",
              icon: "antigravity-color",
              shellInstalled: true,
            },
          ],
        },
      },
    });
    expect(response.payload.snapshot.entries[0]?.shellInstalled).toBe(true);
    expect(response.payload.snapshot.entries[0]?.kind).toBe("external");
  });

  it("parses the layout RPC and the changed push", () => {
    const request = AgentConnectLayoutSetRequestSchema.parse({
      type: "agent.connect.layout.set.request",
      requestId: "req_3",
      order: ["pi", "claude"],
      hidden: ["codex"],
    });
    expect(request.hidden).toEqual(["codex"]);

    const changed = AgentConnectChangedSchema.parse({
      type: "agent.connect.changed",
      payload: { snapshot: { ...snapshot, order: ["pi"], hidden: [] } },
    });
    expect(changed.payload.snapshot.order).toEqual(["pi"]);
  });

  it("parses drift and launch fields when a newer host sends them", () => {
    const parsed = AgentConnectSnapshotSchema.parse({
      ...snapshot,
      entries: [
        {
          ...snapshot.entries[0],
          drift: "stale",
          launchCommand: "GEMINI_API_KEY=k agy",
        },
      ],
    });
    expect(parsed.entries[0]?.drift).toBe("stale");
    expect(parsed.entries[0]?.launchCommand).toContain("agy");
  });

  it("rejects an unknown reason code", () => {
    const result = AgentConnectSnapshotSchema.safeParse({
      ...snapshot,
      entries: [{ ...snapshot.entries[0], reason: "made-up" }],
    });
    expect(result.success).toBe(false);
  });
});
