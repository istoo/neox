import { afterEach, describe, expect, it } from "vitest";
import {
  claudeModeNow,
  claudeModeWhy,
  clearClaudeRun,
  lastClaudeRun,
  noteClaudeRun,
} from "./mode.js";

const machine = { platform: "darwin", hasBinary: true, printMode: false };

afterEach(() => {
  clearClaudeRun();
});

describe("claudeModeWhy", () => {
  it("runs the interactive mode when the system, Claude Code and the setting allow it", () => {
    expect(claudeModeWhy(machine)).toBe("");
  });

  it("names the system, Claude Code's absence, and the setting", () => {
    expect(claudeModeWhy({ ...machine, platform: "aix" })).toBe("os");
    expect(claudeModeWhy({ ...machine, hasBinary: false })).toBe("missing");
    expect(claudeModeWhy({ ...machine, printMode: true })).toBe("off");
  });

  it("checks the machine before the setting, as myna does", () => {
    expect(claudeModeWhy({ platform: "aix", hasBinary: false, printMode: true })).toBe("os");
    expect(claudeModeWhy({ ...machine, hasBinary: false, printMode: true })).toBe("missing");
  });
});

describe("claudeModeNow", () => {
  it("is the interactive mode only when no why holds it back", () => {
    expect(claudeModeNow(machine, null)).toEqual({ tui: true, why: "", last: null });
    expect(claudeModeNow({ ...machine, printMode: true }, null)).toEqual({
      tui: false,
      why: "off",
      last: null,
    });
  });

  it("carries how the last run went", () => {
    noteClaudeRun("", 1_700_000_000_000);
    expect(claudeModeNow(machine)).toEqual({
      tui: true,
      why: "",
      last: { tui: true, why: "", at: 1_700_000_000_000 },
    });
    noteClaudeRun("off", 1_700_000_001_000);
    expect(lastClaudeRun()).toEqual({ tui: false, why: "off", at: 1_700_000_001_000 });
  });
});
