import { describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { runModeCommand } from "./mode.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111",
  availableModes: [],
};
const setAgentMode = vi.fn(async () => undefined);

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return {
    ...actual,
    connectToDaemon: vi.fn(async () => ({
      fetchAgent: vi.fn(async () => ({ agent })),
      setAgentMode,
      close: async () => undefined,
    })),
  };
});

describe("agent mode", () => {
  it("prints the whole agent id, not a prefix", async () => {
    connectToDaemon.mockClear();
    const result = await runModeCommand(
      agent.id,
      "plan",
      { daemonTarget: { kind: "endpoint", host: "example.test:1234" }, list: false },
      {} as never,
    );
    expect(setAgentMode).toHaveBeenCalledWith(agent.id, "plan");
    expect(result.data).toEqual({ agentId: agent.id, mode: "plan" });
  });
});
