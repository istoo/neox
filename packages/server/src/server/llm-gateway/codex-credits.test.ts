import { describe, expect, it } from "vitest";
import { codexCreditsMode, codexCreditsPlan, codexSpendsCredits } from "./codex-credits.js";

describe("codex credits", () => {
  it("reads an absent mode as on", () => {
    expect(codexCreditsMode({})).toBe("on");
    expect(codexSpendsCredits({})).toBe(true);
  });

  it("leaves the ordinary place alone until a window is used up", () => {
    for (const creditsMode of ["on", "first", "last", "off"] as const) {
      expect(codexCreditsPlan({ creditsMode }, false)).toEqual({
        hold: false,
        first: false,
        last: false,
      });
    }
  });

  it("holds a used-up account set not to spend its credits", () => {
    expect(codexCreditsPlan({ creditsMode: "off" }, true)).toEqual({
      hold: true,
      first: false,
      last: false,
    });
    expect(codexSpendsCredits({ creditsMode: "off" })).toBe(false);
  });

  it("keeps a first account's place and sends a last one after everything else", () => {
    expect(codexCreditsPlan({ creditsMode: "first" }, true)).toEqual({
      hold: false,
      first: true,
      last: false,
    });
    expect(codexCreditsPlan({ creditsMode: "last" }, true)).toEqual({
      hold: false,
      first: false,
      last: true,
    });
    expect(codexCreditsPlan({ creditsMode: "on" }, true)).toEqual({
      hold: false,
      first: false,
      last: false,
    });
  });
});
