import { describe, expect, it, vi } from "vitest";
import { runWaitCommand } from "./wait.js";

const waitForFinish = vi.fn();

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return {
    ...actual,
    connectToDaemon: vi.fn(async () => ({
      waitForFinish,
      fetchAgentTimeline: vi.fn(async () => ({ items: [] })),
      close: async () => undefined,
    })),
  };
});

const options = {
  daemonTarget: { kind: "endpoint" as const, host: "example.test:1234" },
};

describe("agent wait", () => {
  it("fails when no agent answers to the id", async () => {
    waitForFinish.mockResolvedValueOnce({
      status: "error",
      final: null,
      error: "Agent nope not found",
      lastMessage: null,
    });
    await expect(runWaitCommand("nope", options, {} as never)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
      message: "Agent nope not found",
    });
  });

  it("still reports an agent that finished with an error", async () => {
    waitForFinish.mockResolvedValueOnce({
      status: "error",
      final: { id: "11111111-1111-4111-8111-111111111111" },
      error: "the provider failed",
      lastMessage: null,
    });
    const result = await runWaitCommand("11111111", options, {} as never);
    expect(result.data).toMatchObject({ status: "error", message: "the provider failed" });
  });
});
