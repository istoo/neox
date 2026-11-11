import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCodexLimits,
  CODEX_OWN_LIMIT_KEY,
  codexLimitKeyOf,
  codexLimitsOf,
  noteCodexLimits,
  parseCodexLimitEvent,
  parseCodexLimitHeaders,
} from "./codex-limits.js";

describe("codex limit keys", () => {
  it("reads back what the backend said of a pool account", () => {
    const limits = parseCodexLimitHeaders(
      headers({
        "x-codex-primary-used-percent": "42",
        "x-codex-primary-window-minutes": "300",
      }),
      1_700_000_000_000,
    );
    const account = { id: "neolix:acct-1" };
    noteCodexLimits(codexLimitKeyOf(account), limits);
    expect(codexLimitsOf(account.id)).toEqual(limits);
  });

  it("keeps Codex's own sign-in under its own key", () => {
    noteCodexLimits(CODEX_OWN_LIMIT_KEY, [{ usedPercent: 5, windowMinutes: 60, resetAt: null }]);
    expect(codexLimitsOf(CODEX_OWN_LIMIT_KEY)).toEqual([
      { usedPercent: 5, windowMinutes: 60, resetAt: null },
    ]);
    expect(CODEX_OWN_LIMIT_KEY).toBe("codex-own");
  });
});

function headers(entries: Record<string, string>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(entries)) {
    out.set(name, value);
  }
  return out;
}

afterEach(() => clearCodexLimits());
// Tests never reach the network: every code path that would fetch takes an
// injected fetch, so the global one throws.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

describe("parseCodexLimitHeaders", () => {
  it("reads both windows and their reset times", () => {
    const limits = parseCodexLimitHeaders(
      headers({
        "x-codex-primary-used-percent": "42.5",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1800000000",
        "x-codex-secondary-used-percent": "90",
        "x-codex-secondary-window-minutes": "10080",
        "x-codex-secondary-reset-after-seconds": "600",
      }),
      1_700_000_000_000,
    );
    expect(limits).toEqual([
      { usedPercent: 42.5, windowMinutes: 300, resetAt: 1_800_000_000_000 },
      { usedPercent: 90, windowMinutes: 10_080, resetAt: 1_700_000_600_000 },
    ]);
  });

  it("leaves out a window that says nothing of its length", () => {
    expect(parseCodexLimitHeaders(headers({ "x-codex-primary-used-percent": "10" }))).toEqual([]);
  });

  it("says nothing for a reply with no such headers", () => {
    expect(parseCodexLimitHeaders(headers({ "content-type": "text/event-stream" }))).toEqual([]);
  });
});

describe("parseCodexLimitEvent", () => {
  it("reads the event ahead of a streamed reply", () => {
    const chunk =
      'event: codex.rate_limits\ndata: {"type":"codex.rate_limits","rate_limits":{"primary":{"used_percent":75,"window_minutes":300,"reset_at":1800000000}}}\n\n';
    expect(parseCodexLimitEvent(chunk, 0)).toEqual([
      { usedPercent: 75, windowMinutes: 300, resetAt: 1_800_000_000_000 },
    ]);
  });

  it("leaves a model's own allowance to the model", () => {
    const chunk =
      'data: {"type":"codex.rate_limits","metered_limit_name":"gpt-6.1-sol","rate_limits":{"primary":{"used_percent":75,"window_minutes":300}}}';
    expect(parseCodexLimitEvent(chunk, 0)).toBeNull();
  });

  it("says nothing for another event or a cut-off line", () => {
    expect(parseCodexLimitEvent('data: {"type":"response.created"}', 0)).toBeNull();
    expect(parseCodexLimitEvent("codex.rate_limits data: {", 0)).toBeNull();
  });
});

describe("codex limits store", () => {
  it("keeps what was heard per account", () => {
    noteCodexLimits("acct-1", [{ usedPercent: 10, windowMinutes: 300, resetAt: null }]);
    noteCodexLimits("acct-2", []);
    expect(codexLimitsOf("acct-1")).toEqual([
      { usedPercent: 10, windowMinutes: 300, resetAt: null },
    ]);
    expect(codexLimitsOf("acct-2")).toEqual([]);
    expect(codexLimitsOf("nobody")).toEqual([]);
  });
});
