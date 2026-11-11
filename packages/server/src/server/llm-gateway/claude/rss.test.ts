import { describe, expect, it } from "vitest";
import {
  CLAUDE_RUN_FLOOR_BYTES,
  CLAUDE_RUN_UNKNOWN_BYTES,
  claudeRunBudget,
  isOversized,
  oversizedRun,
} from "./rss.js";

describe("claudeRunBudget", () => {
  it("is an eighth of the memory, 1 GiB at least", () => {
    expect(claudeRunBudget(64 * (1 << 30))).toBe(8 * (1 << 30));
    expect(claudeRunBudget(2 * (1 << 30))).toBe(CLAUDE_RUN_FLOOR_BYTES);
  });

  it("is 4 GiB where the memory is not known", () => {
    expect(claudeRunBudget(0)).toBe(CLAUDE_RUN_UNKNOWN_BYTES);
    expect(CLAUDE_RUN_UNKNOWN_BYTES).toBe(4 * 1024 ** 3);
  });
});

describe("isOversized", () => {
  it("lets a whole turn hold the budget and half again while parked", () => {
    const budget = 1 << 30;
    expect(isOversized(budget, budget, 2)).toBe(false);
    expect(isOversized(budget + 1, budget, 2)).toBe(true);
    expect(isOversized(budget * 1.4, budget, 3)).toBe(false);
    expect(isOversized(budget * 1.6, budget, 3)).toBe(true);
  });
});

describe("oversizedRun", () => {
  it("reads the process's memory and compares it", async () => {
    await expect(oversizedRun(42, 1 << 30, 2, async () => 2 * (1 << 30))).resolves.toBe(true);
    await expect(oversizedRun(42, 1 << 30, 2, async () => 1)).resolves.toBe(false);
  });

  it("keeps a run whose memory cannot be read", async () => {
    await expect(oversizedRun(42, 1 << 30, 2, async () => null)).resolves.toBe(false);
    await expect(oversizedRun(0, 1 << 30, 2)).resolves.toBe(false);
  });
});
