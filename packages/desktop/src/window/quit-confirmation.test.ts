import { describe, expect, it, vi } from "vitest";

import { createQuitConfirmationBroker } from "./quit-confirmation";

function makeBroker(readyTimeoutMs = 50) {
  const sent: Array<{ requestId: string; presentation: string }> = [];
  const renderer = {
    send: vi.fn((request: { requestId: string; presentation: string }) => {
      sent.push(request);
    }),
    isAlive: vi.fn(() => true),
  };
  const broker = createQuitConfirmationBroker({ renderer, readyTimeoutMs });
  return { broker, sent, renderer };
}

describe("createQuitConfirmationBroker", () => {
  it("allows the quit when the renderer reports no running chats", async () => {
    const { broker, sent } = makeBroker();
    const answer = broker.ask();
    broker.handleResponse({
      requestId: sent[0]!.requestId,
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    await expect(answer).resolves.toBe(true);
  });

  it("waits for the decision when chats are running", async () => {
    const { broker, sent } = makeBroker();
    const answer = broker.ask();
    broker.handleResponse({
      requestId: sent[0]!.requestId,
      phase: "ready",
      runningCount: 2,
      chats: [
        { id: "t1", title: "One" },
        { id: "t2", title: "Two" },
      ],
    });
    broker.handleResponse({ requestId: sent[0]!.requestId, phase: "decision", allow: false });
    await expect(answer).resolves.toBe(false);
  });

  it("allows the decision to quit after the ready list", async () => {
    const { broker, sent } = makeBroker();
    const answer = broker.ask();
    broker.handleResponse({
      requestId: sent[0]!.requestId,
      phase: "ready",
      runningCount: 1,
      chats: [{ id: "t1", title: "One" }],
    });
    broker.handleResponse({ requestId: sent[0]!.requestId, phase: "decision", allow: true });
    await expect(answer).resolves.toBe(true);
  });

  it("falls back to the native dialog when no renderer answers", async () => {
    const { broker } = makeBroker(10);
    await expect(broker.ask()).resolves.toBeNull();
  });

  it("ignores answers for another request id", async () => {
    const { broker, sent } = makeBroker();
    const answer = broker.ask();
    broker.handleResponse({
      requestId: "someone-else",
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    broker.handleResponse({
      requestId: sent[0]!.requestId,
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    await expect(answer).resolves.toBe(true);
  });

  it("cancels as stay when the renderer's window goes away", async () => {
    const { broker, renderer } = makeBroker();
    renderer.isAlive.mockReturnValue(false);
    const answer = broker.ask();
    broker.handleRendererGone();
    await expect(answer).resolves.toBe(false);
  });
});
