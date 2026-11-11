import { describe, expect, it } from "vitest";
import { isExhausted, quotaFromHeaders, QuotaTracker } from "./quota.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("QuotaTracker", () => {
  it("sums only the tokens inside each window", () => {
    const tracker = new QuotaTracker();
    tracker.record("a", 0, 10);
    tracker.record("a", 6 * HOUR, 5);
    expect(tracker.usage("a", 6 * HOUR)).toEqual({ tokens5h: 5, tokens7d: 15 });
  });

  it("rests an account until the oldest overflow leaves the five hour window", () => {
    const tracker = new QuotaTracker();
    tracker.record("a", 0, 80);
    tracker.record("a", HOUR, 30);
    const until = tracker.restedUntil("a", HOUR, { tokens5h: 100 });
    expect(until).toBe(5 * HOUR);
  });

  it("reports no wait while the account is under its caps", () => {
    const tracker = new QuotaTracker();
    tracker.record("a", 0, 10);
    expect(tracker.restedUntil("a", HOUR, { tokens5h: 100 })).toBeNull();
  });

  it("takes the later of the five hour and seven day waits", () => {
    const tracker = new QuotaTracker();
    tracker.record("a", 0, 50);
    tracker.record("a", 6 * HOUR, 60);
    const until = tracker.restedUntil("a", 6 * HOUR, { tokens5h: 50, tokens7d: 100 });
    expect(until).toBe(7 * 24 * HOUR);
  });
});

describe("quotaFromHeaders", () => {
  it("reads Anthropic remaining tokens and an ISO reset", () => {
    const now = Date.parse("2026-11-05T00:00:00.000Z");
    const resetAt = now + 60 * 60_000;
    const headers = new Headers({
      "anthropic-ratelimit-tokens-remaining": "0",
      "anthropic-ratelimit-tokens-reset": new Date(resetAt).toISOString(),
    });
    const snapshot = quotaFromHeaders(headers, now);
    expect(snapshot).toMatchObject({ remainingTokens: 0, resetAt });
    expect(snapshot === null ? false : isExhausted(snapshot)).toBe(true);
  });

  it("reads OpenAI durations such as 6m0s", () => {
    const now = 0;
    const headers = new Headers({
      "x-ratelimit-remaining-tokens": "120",
      "x-ratelimit-reset-tokens": "6m0s",
    });
    const snapshot = quotaFromHeaders(headers, now);
    expect(snapshot).toMatchObject({ remainingTokens: 120, resetAt: 6 * MINUTE });
    expect(snapshot === null ? true : isExhausted(snapshot)).toBe(false);
  });

  it("returns null when the upstream reports no quota headers", () => {
    expect(quotaFromHeaders(new Headers(), 0)).toBeNull();
  });
});
