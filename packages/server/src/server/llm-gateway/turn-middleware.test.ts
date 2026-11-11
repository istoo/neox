import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createTurnMiddleware } from "./turn-middleware.js";
import { TurnTracker, type TurnEnd } from "./turndone.js";

function trackerWith(done: TurnEnd[]) {
  const tracker = new TurnTracker({
    thresholdSeconds: () => 10,
    quietMs: 4_000,
    now: () => Date.now(),
  });
  tracker.subscribe((end) => done.push(end));
  return tracker;
}

function fakeResponse(): Response & { emitFinish(): void } {
  const res = new EventEmitter() as unknown as Response & { emitFinish(): void };
  (res as unknown as { statusCode: number }).statusCode = 200;
  (res as unknown as { write: unknown }).write = () => true;
  // A real response emits "finish" once its body is out.
  (res as unknown as { end: unknown }).end = () => res.emit("finish");
  res.emitFinish = () => res.emit("finish");
  return res;
}

function request(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    path: "/v1/chat/completions",
    headers: { "user-agent": "claude-code/1.0" },
    body: undefined,
    ...overrides,
  } as unknown as Request;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTurnMiddleware", () => {
  it("groups a request with no session header by its first user message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const done: TurnEnd[] = [];
    const tracker = trackerWith(done);
    const req = request();
    const res = fakeResponse();
    createTurnMiddleware(tracker)(req, res, () => undefined);

    // The route's body parser runs after this middleware.
    (req as unknown as { body: unknown }).body = {
      messages: [{ role: "user", content: "fix the failing test" }],
    };
    vi.setSystemTime(15_000);
    (res.write as unknown as (chunk: string) => boolean)('{"type":"text_delta"}');
    res.emitFinish();
    vi.advanceTimersByTime(4_000);

    expect(done).toHaveLength(1);
    expect(done[0]?.session).toMatch(/^neolix-[0-9a-f]{24}$/);
    expect(done[0]?.tookMs).toBe(15_000);
    tracker.stop();
  });

  it("prefers the session header when the agent sends one", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const done: TurnEnd[] = [];
    const tracker = trackerWith(done);
    const req = request({
      headers: { "user-agent": "claude-code/1.0", "x-claude-code-session-id": "s-1" },
    });
    const res = fakeResponse();
    createTurnMiddleware(tracker)(req, res, () => undefined);

    vi.setSystemTime(12_000);
    (res.end as unknown as (chunk: string) => void)('{"type":"message_stop"}');
    vi.advanceTimersByTime(4_000);

    expect(done[0]?.session).toBe("s-1");
    tracker.stop();
  });

  it("does nothing when the request names no conversation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const done: TurnEnd[] = [];
    const tracker = trackerWith(done);
    const req = request();
    const res = fakeResponse();
    createTurnMiddleware(tracker)(req, res, () => undefined);

    vi.setSystemTime(30_000);
    (res.write as unknown as (chunk: string) => boolean)('{"type":"text_delta"}');
    res.emitFinish();
    vi.advanceTimersByTime(60_000);
    expect(done).toEqual([]);
    tracker.stop();
  });

  it("leaves other paths, other agents and Neox's own calls alone", () => {
    const done: TurnEnd[] = [];
    const tracker = trackerWith(done);
    const middleware = createTurnMiddleware(tracker);
    const res = fakeResponse();

    middleware(request({ path: "/v1/models" }), res, () => undefined);
    middleware(request({ headers: { "user-agent": "curl/8" } }), res, () => undefined);
    middleware(
      request({ headers: { "user-agent": "claude-code/1.0", "x-neolix-gateway-internal": "1" } }),
      res,
      () => undefined,
    );
    middleware(
      request({ headers: { "user-agent": "claude-code/1.0", "x-claude-code-agent-id": "sub" } }),
      res,
      () => undefined,
    );

    (res.write as unknown as (chunk: string) => boolean)('{"type":"text_delta"}');
    res.emitFinish();
    expect(done).toEqual([]);
    tracker.stop();
  });
});
