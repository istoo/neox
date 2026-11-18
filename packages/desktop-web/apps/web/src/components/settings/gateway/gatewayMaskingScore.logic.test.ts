import { describe, expect, it } from "vitest";

import {
  MASKING_SCORE_DEFAULT,
  effectiveMaskingScore,
  isMaskingScore,
  maskingScoreOptions,
  maskingScoreSelectValue,
} from "./gatewayMaskingScore.logic";

describe("gatewayMaskingScore", () => {
  it("keeps the daemon's range of confidence thresholds", () => {
    expect(isMaskingScore(0.5)).toBe(true);
    expect(isMaskingScore(0.8)).toBe(true);
    expect(isMaskingScore(0.95)).toBe(true);
    expect(isMaskingScore(0.49)).toBe(false);
    expect(isMaskingScore(0.96)).toBe(false);
    expect(isMaskingScore(Number.NaN)).toBe(false);
    expect(isMaskingScore(undefined)).toBe(false);
  });

  it("shows the stored score, then the daemon's, then the publisher's default", () => {
    expect(effectiveMaskingScore(0.9, 0.8)).toBe(0.9);
    expect(effectiveMaskingScore(undefined, 0.7)).toBe(0.7);
    expect(effectiveMaskingScore(undefined, undefined)).toBe(MASKING_SCORE_DEFAULT);
    expect(effectiveMaskingScore(0.8, 0.9)).toBe(0.8);
  });

  it("offers myna's scores and keeps an unusual stored one visible", () => {
    expect(maskingScoreOptions(undefined)).toEqual([0.5, 0.6, 0.7, 0.85, 0.9, 0.95]);
    expect(maskingScoreOptions(MASKING_SCORE_DEFAULT)).toEqual([0.5, 0.6, 0.7, 0.85, 0.9, 0.95]);
    expect(maskingScoreOptions(0.9)).toEqual([0.5, 0.6, 0.7, 0.85, 0.9, 0.95]);
    expect(maskingScoreOptions(0.73)).toEqual([0.5, 0.6, 0.7, 0.73, 0.85, 0.9, 0.95]);
  });

  it("reads the publisher's default as the empty choice", () => {
    expect(maskingScoreSelectValue(MASKING_SCORE_DEFAULT)).toBe("");
    expect(maskingScoreSelectValue(0.5)).toBe("0.5");
    expect(maskingScoreSelectValue(0.73)).toBe("0.73");
  });
});
