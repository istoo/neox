import {
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListSkillsResult,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { DaemonClient } from "./neolix.ts";
import {
  composerCapabilities,
  defaultModelId,
  listCommands,
  listModels,
  listSkills,
} from "./providerRpc.ts";
import { ProviderDirectory } from "./providers.ts";

const client = {
  listProviderModels: async () => ({
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M context)" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "ghcp/claude-haiku-5-5[1m]", label: "Haiku 5.5 [1M]" },
      { id: "hidden", label: "Hidden", isSelectable: false },
    ],
  }),
} as unknown as DaemonClient;

describe("providerRpc", () => {
  it("lists models under their bare id, folding context-window variants", async () => {
    const directory = new ProviderDirectory();
    directory.update(["claude"]);
    const result = await listModels(client, directory, {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
    });
    expect(result.models.map((m) => [m.slug, m.name])).toEqual([
      ["claude-opus-5-5", "Opus 5.5"],
      ["claude-opus-4-8", "Opus 4.8"],
      ["ghcp/claude-haiku-5-5", "Haiku 5.5"],
    ]);
    expect(() => Schema.encodeUnknownSync(ProviderListModelsResult as never)(result)).not.toThrow();
  });

  it("reads the daemon's default model", async () => {
    expect(await defaultModelId(client, "claude")).toBe("claude-opus-5-5");
  });
});

function commandClient(
  calls: unknown[][],
  commands: Array<{ name: string; description: string; kind?: "command" | "skill" }>,
  models: Array<{ id: string; label: string; isDefault?: boolean }> = [
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true },
  ],
): DaemonClient {
  return {
    listProviderModels: async () => ({ models }),
    listCommands: async (...args: unknown[]) => {
      calls.push(args);
      return { agentId: "agent", commands, error: null, requestId: "r" };
    },
  } as unknown as DaemonClient;
}

describe("provider discovery", () => {
  it("advertises the composer discovery the bridge now serves", () => {
    expect(composerCapabilities("claudeAgent")).toMatchObject({
      supportsNativeSlashCommandDiscovery: true,
      supportsSkillDiscovery: true,
    });
  });

  it("lists native commands and skills from the daemon's command list", async () => {
    const calls: unknown[][] = [];
    const directory = new ProviderDirectory();
    directory.update(["claude"]);
    const discoveryClient = commandClient(calls, [
      { name: "review", description: "Review the diff", kind: "command" },
      { name: "skill:pdf", description: "Work with PDFs", kind: "skill" },
      { name: " ", description: "" },
    ]);
    const input = { provider: "claudeAgent", instanceId: "claudeAgent", cwd: "/repo" };
    const commands = await listCommands(discoveryClient, directory, input);
    const skills = await listSkills(discoveryClient, directory, input);
    expect(commands.commands).toEqual([
      { name: "review", description: "Review the diff" },
      { name: "skill:pdf", description: "Work with PDFs" },
    ]);
    expect(skills.skills).toEqual([
      {
        name: "skill:pdf",
        path: "skill:pdf",
        enabled: true,
        scope: "claude",
        description: "Work with PDFs",
      },
    ]);
    expect(() =>
      Schema.encodeUnknownSync(ProviderListCommandsResult as never)(commands),
    ).not.toThrow();
    expect(() => Schema.encodeUnknownSync(ProviderListSkillsResult as never)(skills)).not.toThrow();
    // No thread, so discovery runs against a draft config for the agent id it will get, with the
    // provider's default model (the daemon lists nothing for a model-less draft).
    expect(calls[0]?.[0]).toMatchObject({
      agentId: "draft:claude",
      draftConfig: { provider: "claude", cwd: "/repo", model: "claude-opus-5-5" },
    });
  });

  it("keeps a model-less draft model-less when the provider lists no models", async () => {
    const calls: unknown[][] = [];
    const directory = new ProviderDirectory();
    directory.update(["claude"]);
    const discoveryClient = commandClient(calls, [], []);
    await listSkills(discoveryClient, directory, {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      cwd: "/repo",
    });
    expect(calls[0]?.[0]).toEqual({
      agentId: "draft:claude",
      draftConfig: { provider: "claude", cwd: "/repo" },
    });
  });

  it("lists commands for a live agent and forwards its draft model", async () => {
    const calls: unknown[][] = [];
    const directory = new ProviderDirectory();
    directory.update(["claude"]);
    const discoveryClient = commandClient(calls, []);
    await listCommands(discoveryClient, directory, {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      cwd: "/repo",
      threadId: "thread-1",
      threadIsAgent: true,
    });
    expect(calls[0]).toEqual(["thread-1"]);
    await listCommands(discoveryClient, directory, {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      cwd: "/repo",
      threadId: "draft-1",
      threadIsAgent: false,
      selection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: { thinking: true, effort: "high" },
      },
    });
    expect(calls[1]?.[0]).toMatchObject({
      agentId: "draft-1",
      draftConfig: {
        provider: "claude",
        cwd: "/repo",
        model: "claude-opus-5-5",
        thinkingOptionId: "high",
      },
    });
  });
});
