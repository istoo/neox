import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyScan, TurnTracker, turnKey, type TurnEnd } from "./turndone.js";

afterEach(() => {
  vi.useRealTimers();
});

function trackerWith(thresholdSeconds: number) {
  const done: TurnEnd[] = [];
  const tracker = new TurnTracker({
    thresholdSeconds: () => thresholdSeconds,
    quietMs: 4_000,
    now: () => Date.now(),
  });
  tracker.subscribe((end) => done.push(end));
  return { tracker, done };
}

const info = { agent: "claude-code", session: "session-a" };

describe("TurnTracker", () => {
  it("reports a turn that ran long enough once its last reply is quiet", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker, done } = trackerWith(10);
    tracker.begin(turnKey(info.agent, info.session), info);
    vi.setSystemTime(12_000);
    tracker.end(turnKey(info.agent, info.session), true);
    vi.advanceTimersByTime(3_999);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ...info, tookMs: 12_000 });
    tracker.stop();
  });

  it("says nothing when the turn ended on a tool call or unfinished reply", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker, done } = trackerWith(10);
    const key = turnKey(info.agent, info.session);
    tracker.begin(key, info);
    vi.setSystemTime(12_000);
    tracker.end(key, false);
    vi.advanceTimersByTime(60_000);
    expect(done).toEqual([]);
    tracker.stop();
  });

  it("waits for the other requests of the same turn to end", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker, done } = trackerWith(10);
    const key = turnKey(info.agent, info.session);
    tracker.begin(key, info);
    tracker.begin(key, info);
    vi.setSystemTime(6_000);
    tracker.end(key, true);
    vi.advanceTimersByTime(10_000);
    expect(done).toEqual([]);
    vi.setSystemTime(12_000);
    tracker.end(key, true);
    vi.advanceTimersByTime(4_000);
    expect(done).toHaveLength(1);
    tracker.stop();
  });

  it("is off while the setting is off", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker, done } = trackerWith(0);
    const key = turnKey(info.agent, info.session);
    tracker.begin(key, info);
    vi.setSystemTime(60_000);
    tracker.end(key, true);
    vi.advanceTimersByTime(60_000);
    expect(done).toEqual([]);
    tracker.stop();
  });

  it("does not hold the process open", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { tracker } = trackerWith(10);
    const key = turnKey(info.agent, info.session);
    tracker.begin(key, info);
    tracker.end(key, true);
    const timers = vi.getTimerCount();
    expect(timers).toBeGreaterThan(0);
    tracker.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ReplyScan", () => {
  it("sees a tool call in each wire format", () => {
    for (const chunk of [
      '{"type":"tool_use"}',
      '{"stop_reason":"tool_use"}',
      '{"finish_reason":"tool_calls"}',
      '{"functionCall":{"name":"x"}}',
      '{"type":"mcp_approval_request"}',
    ]) {
      const scan = new ReplyScan();
      scan.add(chunk);
      expect(scan.final, chunk).toBe(false);
    }
  });

  it("matches a mark split across chunks", () => {
    const scan = new ReplyScan();
    scan.add('{"type":"tool');
    scan.add('_use"}');
    expect(scan.sawTool).toBe(true);
  });

  it("treats a plain text reply as the turn's end", () => {
    const scan = new ReplyScan();
    scan.add('{"type":"text_delta","text":"all done"}');
    scan.add('{"type":"message_stop"}');
    expect(scan.final).toBe(true);
  });

  it("treats a cut or failed reply as unfinished", () => {
    for (const chunk of [
      '{"stop_reason":"max_tokens"}',
      '{"finish_reason":"length"}',
      '{"type":"error"}',
      '{"type":"response.incomplete"}',
    ]) {
      const scan = new ReplyScan();
      scan.add(chunk);
      expect(scan.final, chunk).toBe(false);
    }
  });
});
