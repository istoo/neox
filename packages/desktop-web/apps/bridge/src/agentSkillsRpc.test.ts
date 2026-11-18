import { NEOLIX_AGENT_SKILLS_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeAgentSkillsHandlers } from "./agentSkillsRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

const STATUS = {
  state: "up-to-date",
  ops: [],
  available: ["neox-orchestration"],
  installed: ["neox-orchestration"],
  selection: { mode: "all" },
};

const SAVE_RESULT = { ...STATUS, confirmationRequired: null };

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    getAgentSkillsStatus: async () => {
      calls.push(["getAgentSkillsStatus", undefined]);
      return STATUS;
    },
    reconcileAgentSkills: async () => {
      calls.push(["reconcileAgentSkills", undefined]);
      return STATUS;
    },
    uninstallAgentSkills: async () => {
      calls.push(["uninstallAgentSkills", undefined]);
      return { ...STATUS, state: "not-installed", installed: [] };
    },
    saveAgentSkillsSelection: async (selection: unknown, confirmedRemovals?: readonly string[]) => {
      calls.push(["saveAgentSkillsSelection", { selection, confirmedRemovals }]);
      return SAVE_RESULT;
    },
    ...overrides,
  };
  return {
    calls,
    handlers: makeAgentSkillsHandlers({ client } as unknown as BridgeModel),
  };
}

describe("makeAgentSkillsHandlers", () => {
  it("reads the status", async () => {
    const { handlers, calls } = harness();
    const status = await run(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.get]);
    expect(calls).toEqual([["getAgentSkillsStatus", undefined]]);
    expect(status).toEqual(STATUS);
  });

  it("installs or updates through reconcile", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.reconcile]);
    expect(calls).toEqual([["reconcileAgentSkills", undefined]]);
  });

  it("uninstalls", async () => {
    const { handlers, calls } = harness();
    const status = await run<{ state: string }>(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.uninstall]);
    expect(calls).toEqual([["uninstallAgentSkills", undefined]]);
    expect(status.state).toBe("not-installed");
  });

  it("saves a selection without inventing confirmations", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.saveSelection], {
      selection: { mode: "custom", skills: ["neox-orchestration"] },
    });
    expect(calls).toEqual([
      [
        "saveAgentSkillsSelection",
        {
          selection: { mode: "custom", skills: ["neox-orchestration"] },
          confirmedRemovals: undefined,
        },
      ],
    ]);
  });

  it("passes confirmed removals through", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.saveSelection], {
      selection: { mode: "all" },
      confirmedRemovals: ["old-skill"],
    });
    expect(calls).toEqual([
      [
        "saveAgentSkillsSelection",
        { selection: { mode: "all" }, confirmedRemovals: ["old-skill"] },
      ],
    ]);
  });

  it("passes a daemon failure through with the method name logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = harness({
      getAgentSkillsStatus: async () => {
        throw new Error("update the host");
      },
    });
    await expect(run(handlers[NEOLIX_AGENT_SKILLS_WS_METHODS.get])).rejects.toMatchObject({
      message: "update the host",
      code: "neolix.error.unmapped",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${NEOLIX_AGENT_SKILLS_WS_METHODS.get} failed: update the host`),
    );
    warn.mockRestore();
  });
});
