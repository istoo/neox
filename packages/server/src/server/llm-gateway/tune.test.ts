import { describe, expect, it } from "vitest";
import type { UsageRecord } from "./usage.js";
import { tuneAdvice, tuneCalls, weightsFor } from "./tune.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    time: "2026-11-05T10:00:00.000Z",
    requested: "claude-sonnet-5-5",
    provider: "anthropic",
    account: null,
    model: "claude-sonnet-5-5",
    protocol: "anthropic",
    status: 200,
    ok: true,
    inputTokens: 20_000,
    outputTokens: 500,
    attempts: 1,
    durationMs: 1_000,
    costUsd: 0,
    key: null,
    session: "session-1",
    ...overrides,
  };
}

/** One growing conversation: each call adds `growth` tokens. */
function conversation(
  count: number,
  options: { session?: string; growth?: number; gapMs?: number; hourLong?: boolean } = {},
): UsageRecord[] {
  const growth = options.growth ?? 2_000;
  const gap = options.gapMs ?? 60_000;
  const started = Date.parse("2026-11-05T10:00:00.000Z");
  const records: UsageRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const prompt = 20_000 + index * growth;
    records.push(
      record({
        time: new Date(started + index * gap).toISOString(),
        session: options.session ?? "session-1",
        inputTokens: prompt,
        cacheWriteTokens: 2_000,
        cacheWrite1hTokens: options.hourLong === true ? 2_000 : 0,
      }),
    );
  }
  return records;
}

describe("weightsFor", () => {
  it("weighs Claude's cache by Anthropic's prices and others by OpenAI's", () => {
    expect(weightsFor("claude-sonnet-5-5")).toEqual({ read: 0.1, write: 1.25, write1h: 2, out: 5 });
    expect(weightsFor("gpt-5").write).toBe(1);
  });
});

describe("tuneCalls", () => {
  it("keeps a conversation's calls and leaves out probes, failures and sessions it cannot place", () => {
    const calls = tuneCalls([
      record(),
      record({ probe: "test" }),
      record({ ok: false }),
      record({ session: undefined }),
      record({ inputTokens: 0 }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stream: "session-1",
      model: "claude-sonnet-5-5",
      prompt: 20_000,
    });
  });
});

describe("tuneAdvice", () => {
  it("says nothing from fewer than fifty calls", () => {
    expect(tuneAdvice(tuneCalls(conversation(20)))).toEqual([]);
  });

  it("advises a compaction window for a Claude conversation, under the model's window", () => {
    const advice = tuneAdvice(tuneCalls(conversation(80)), {
      windowOf: () => 200_000,
    });
    const claude = advice.find((entry) => entry.agent === "claude");
    expect(claude?.compact).toBeDefined();
    const compact = claude?.compact;
    expect(compact?.facts.calls).toBe(80);
    expect(compact?.window).toBe(200_000);
    expect(compact?.best).toBeGreaterThanOrEqual(100_000);
    expect(compact?.best).toBeLessThanOrEqual(200_000);
    expect(compact?.curve.length).toBeGreaterThan(0);
  });

  it("keeps the current cache lifetime when an hour's writes would not save 3%", () => {
    const advice = tuneAdvice(tuneCalls(conversation(80, { gapMs: 60_000 })), {});
    const ttl = advice.find((entry) => entry.agent === "claude")?.ttl;
    expect(ttl?.current).toBe("5m");
    expect(ttl?.best).toBe("5m");
    expect(ttl?.facts.calls).toBe(80);
  });

  it("reads the current lifetime from how the calls' cache writes were kept", () => {
    const advice = tuneAdvice(tuneCalls(conversation(80, { hourLong: true })), {});
    expect(advice.find((entry) => entry.agent === "claude")?.ttl?.current).toBe("1h");
  });

  it("advises Codex's window from a Codex conversation and no cache lifetime", () => {
    const records = conversation(60).map((entry) =>
      record({
        ...entry,
        model: "gpt-5",
        requested: "gpt-5",
        provider: "openai",
        protocol: "openai",
      }),
    );
    const advice = tuneAdvice(tuneCalls(records), { windowOf: () => 400_000 });
    const codex = advice.find((entry) => entry.agent === "codex");
    expect(codex?.compact?.model).toBe("gpt-5");
    expect(codex?.ttl).toBeUndefined();
  });
});
