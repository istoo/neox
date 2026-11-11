import { describe, expect, it } from "vitest";
import {
  busy,
  maxWaits,
  noteBusy,
  PATIENCE_LONGEST_S,
  REPLAN_LONGEST_MS,
  REPLAN_ROUNDS,
  replan,
  retryAfterMs,
  SINGLE_PATIENCE_MS,
  waitsOf,
} from "./patience.js";

describe("patience", () => {
  it("waits for a failure a member may be over, and not for the others", () => {
    expect(busy(503, "overloaded")).toBe(true);
    expect(busy(429, "rate limit, try again soon")).toBe(true);
    expect(busy(429, "insufficient balance")).toBe(false);
    expect(busy(429, '{"error":{"code":"user_model_rate_limited"}}')).toBe(false);
    expect(busy(502, "response protection is unavailable")).toBe(false);
    expect(busy(502, "the model did not stream")).toBe(false);
    expect(busy(400, "bad request")).toBe(false);
  });

  it("counts a member's patience in seconds, 0 following the group's", () => {
    expect(waitsOf(-1, SINGLE_PATIENCE_MS)).toBe(0);
    expect(waitsOf(0, SINGLE_PATIENCE_MS)).toBe(SINGLE_PATIENCE_MS);
    expect(waitsOf(120, SINGLE_PATIENCE_MS)).toBe(120_000);
    expect(waitsOf(9999, SINGLE_PATIENCE_MS)).toBe(PATIENCE_LONGEST_S * 1000);
    expect(maxWaits([{ patience: 0 }, { patience: 30 }], SINGLE_PATIENCE_MS)).toBe(60_000);
  });

  it("adds a failed member once, at its Retry-After", () => {
    const first = noteBusy([], "a", "acc/a", 0, 1000, 0);
    expect(first).toEqual([{ candidate: "a", identity: "acc/a", readyAt: 1000, patience: 0 }]);
    const same = noteBusy(first, "a", "acc/a", 5000, 2000, 0);
    expect(same).toEqual(first);
    const more = noteBusy(first, "b", "acc/b", 5000, 2000, 30);
    expect(more.length).toBe(2);
    expect(more[1]).toEqual({
      candidate: "b",
      identity: "acc/b",
      readyAt: 7000,
      patience: 30,
    });
  });

  it("backs off longer each round, never shorter than the Retry-After", () => {
    const now = 0;
    const list = [
      { candidate: "a", identity: "a", readyAt: 0, patience: 0 },
      { candidate: "b", identity: "b", readyAt: 0, patience: 0 },
    ];
    const first = replan(list, 0, now, SINGLE_PATIENCE_MS, now);
    expect(first).toEqual({ candidates: ["a", "b"], waitMs: 2000 });
    const second = replan(list, 1, now, SINGLE_PATIENCE_MS, now);
    expect(second?.waitMs).toBe(4000);
    // A Retry-After later than the pause keeps the request waiting.
    const late = [{ candidate: "a", identity: "a", readyAt: 10_000, patience: 0 }];
    expect(replan(late, 0, now, SINGLE_PATIENCE_MS, now)).toEqual({
      candidates: ["a"],
      waitMs: 10_000,
    });
    // The pause never grows past its longest.
    const long = replan(list, REPLAN_ROUNDS - 1, now, SINGLE_PATIENCE_MS, now);
    expect(long?.waitMs).toBe(REPLAN_LONGEST_MS);
    expect(replan(list, REPLAN_ROUNDS, now, SINGLE_PATIENCE_MS, now)).toBeNull();
  });

  it("leaves out a member whose budget is spent, and orders the rest", () => {
    const now = 0;
    const list = [
      { candidate: "spent", identity: "s", readyAt: 0, patience: 1 },
      { candidate: "ready", identity: "r", readyAt: 0, patience: 0 },
      { candidate: "later", identity: "l", readyAt: 9000, patience: 0 },
    ];
    // The second round's 4s pause is past the 1s budget.
    const round = replan(list, 1, now, SINGLE_PATIENCE_MS, now);
    expect(round?.candidates).toEqual(["ready", "later"]);
    const only = replan([list[0] as (typeof list)[number]], 1, now, SINGLE_PATIENCE_MS, now);
    expect(only).toBeNull();
  });

  it("reads a Retry-After in seconds or as a date", () => {
    expect(retryAfterMs("2", 0)).toBe(2000);
    expect(retryAfterMs("1.5", 0)).toBe(1500);
    expect(retryAfterMs(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(retryAfterMs(null, 0)).toBe(0);
    expect(retryAfterMs("soon", 0)).toBe(0);
  });
});
