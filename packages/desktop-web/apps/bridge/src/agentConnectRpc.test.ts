import { NEOLIX_AGENT_CONNECT_WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeAgentConnectHandlers } from "./agentConnectRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

const SNAPSHOT = {
  gatewayBaseUrl: "http://127.0.0.1:6868/v1",
  models: [{ id: "gpt-5" }],
  entries: [],
  profiles: [],
  error: null,
};

function run<A>(handler: AnyHandler | undefined, payload: unknown = {}): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const answer = async () => ({ requestId: "r", snapshot: SNAPSHOT });
  const client = {
    getAgentConnect: async () => {
      calls.push(["getAgentConnect", undefined]);
      return answer();
    },
    setAgentConnect: async (input: unknown) => {
      calls.push(["setAgentConnect", input]);
      return answer();
    },
    listAgentConnectProfiles: async () => {
      calls.push(["listAgentConnectProfiles", undefined]);
      return answer();
    },
    saveAgentConnectProfile: async (name: string) => {
      calls.push(["saveAgentConnectProfile", name]);
      return answer();
    },
    applyAgentConnectProfile: async (name: string) => {
      calls.push(["applyAgentConnectProfile", name]);
      return answer();
    },
    deleteAgentConnectProfile: async (name: string) => {
      calls.push(["deleteAgentConnectProfile", name]);
      return answer();
    },
    renameAgentConnectProfile: async (name: string, to: string) => {
      calls.push(["renameAgentConnectProfile", { name, to }]);
      return answer();
    },
    setAgentConnectLayout: async (input: unknown) => {
      calls.push(["setAgentConnectLayout", input]);
      return answer();
    },
    setAgentConnectModels: async (input: unknown) => {
      calls.push(["setAgentConnectModels", input]);
      return answer();
    },
    setAgentConnectShell: async (input: unknown) => {
      calls.push(["setAgentConnectShell", input]);
      return answer();
    },
    restartAgentConnectStale: async (input: unknown) => {
      calls.push(["restartAgentConnectStale", input]);
      return answer();
    },
    ...overrides,
  };
  return {
    calls,
    handlers: makeAgentConnectHandlers({ client } as unknown as BridgeModel),
  };
}

describe("makeAgentConnectHandlers", () => {
  it("reads the snapshot", async () => {
    const { handlers, calls } = harness();
    const result = await run<{ snapshot: unknown }>(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.get]);
    expect(calls).toContainEqual(["getAgentConnect", undefined]);
    expect(result.snapshot).toEqual(SNAPSHOT);
  });

  it("connects a provider on the gateway", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.set], {
      provider: "claude",
      connected: true,
      model: "gpt-5",
    });
    expect(calls).toContainEqual([
      "setAgentConnect",
      { provider: "claude", connected: true, model: "gpt-5" },
    ]);
  });

  it("disconnects without inventing a model", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.set], {
      provider: "codex",
      connected: false,
    });
    expect(calls).toContainEqual(["setAgentConnect", { provider: "codex", connected: false }]);
  });

  it("writes one of the agent's own settings", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.set], {
      provider: "codex",
      connected: false,
      field: "review_model",
      value: "gpt-5",
    });
    expect(calls).toContainEqual([
      "setAgentConnect",
      { provider: "codex", connected: false, field: "review_model", value: "gpt-5" },
    ]);
  });

  it("forwards each profile operation", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.profileList]);
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.profileSave], { name: "work" });
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.profileApply], { name: "work" });
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.profileDelete], { name: "old" });
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.profileRename], {
      name: "work",
      to: "office",
    });
    expect(calls).toEqual([
      ["listAgentConnectProfiles", undefined],
      ["saveAgentConnectProfile", "work"],
      ["applyAgentConnectProfile", "work"],
      ["deleteAgentConnectProfile", "old"],
      ["renameAgentConnectProfile", { name: "work", to: "office" }],
    ]);
  });

  it("saves the list layout", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.layoutSet], {
      order: ["codex", "claude"],
      hidden: ["pi"],
    });
    expect(calls).toContainEqual([
      "setAgentConnectLayout",
      { order: ["codex", "claude"], hidden: ["pi"] },
    ]);
  });

  it("saves the hidden models and the shell function", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.modelsSet], {
      provider: "claude",
      hidden: ["gpt-4o"],
    });
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.shellSet], {
      provider: "claude",
      enabled: true,
    });
    expect(calls).toContainEqual([
      "setAgentConnectModels",
      { provider: "claude", hidden: ["gpt-4o"] },
    ]);
    expect(calls).toContainEqual(["setAgentConnectShell", { provider: "claude", enabled: true }]);
  });

  it("restarts a stale copy", async () => {
    const { handlers, calls } = harness();
    await run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.staleRestart], {
      provider: "codex",
      kind: "ide",
    });
    expect(calls).toContainEqual(["restartAgentConnectStale", { provider: "codex", kind: "ide" }]);
  });

  it("passes a daemon failure through with the method name logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handlers } = harness({
      getAgentConnect: async () => {
        throw new Error("update the host");
      },
    });
    await expect(run(handlers[NEOLIX_AGENT_CONNECT_WS_METHODS.get])).rejects.toMatchObject({
      message: "update the host",
      code: "neolix.error.unmapped",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${NEOLIX_AGENT_CONNECT_WS_METHODS.get} failed: update the host`),
    );
    warn.mockRestore();
  });
});
