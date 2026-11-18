import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

/**
 * B5's question-option preview travels through the daemon untouched: the provider puts the
 * code block on the option's `preview`, the agent snapshot carries it in `pendingPermissions`,
 * and the desktop-web bridge's `toUserInputQuestions` (unit tested next to translate.ts) maps
 * it onto the question card. The browser renders whatever the bridge hands it.
 */
describe("question option preview over the daemon wire", () => {
  let ctx: DaemonTestContext;
  let cwd: string;

  beforeEach(async () => {
    ctx = await createDaemonTestContext({
      agentClients: { mock: new MockLoadTestAgentClient() },
      isDev: true,
    });
    cwd = await mkdtemp(path.join(os.tmpdir(), "neolix-question-preview-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 60_000);

  test("carries the option preview into the pending permission", async () => {
    const agent = await ctx.client.createAgent({
      provider: "mock",
      model: "ten-second-stream",
      cwd,
    });

    await ctx.client.sendMessage(agent.id, "emit synthetic questions");

    const pendingInput = async (): Promise<unknown> => {
      const snapshot = await ctx.client.fetchAgents({ subscribe: {} });
      for (const entry of snapshot.entries) {
        if (entry.agent.id !== agent.id) continue;
        const pending = entry.agent.pendingPermissions?.[0];
        return pending?.kind === "question" ? (pending.input ?? null) : null;
      }
      return null;
    };

    await expect.poll(pendingInput, { timeout: 20_000, interval: 100 }).not.toBeNull();

    const snapshot = await ctx.client.fetchAgents({ subscribe: {} });
    const pending = snapshot.entries.find((entry) => entry.agent.id === agent.id)?.agent
      .pendingPermissions?.[0];
    const questions = (pending?.input as { questions?: Array<{ options?: unknown[] }> })?.questions;
    const rolloutOptions = questions?.[1]?.options as
      | Array<{ label?: string; preview?: string }>
      | undefined;

    expect(
      rolloutOptions?.find((option) => option.label === "Behind feature flag")?.preview,
    ).toContain('if (flags.enabled("new-surface")) {');
    expect(
      rolloutOptions?.find((option) => option.label === "Behind feature flag")?.preview,
    ).toContain("LAST PREVIEW LINE");
  });
});
