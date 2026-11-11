import { describe, expect, it } from "vitest";
import type { GatewayMaskingRecordWire } from "@neolix/protocol/gateway";
import { maskingSummaryPending, mergeMaskingFirstPage } from "./masking-shared";

const record = (key: string): GatewayMaskingRecordWire => ({
  key,
  t: "2026-11-07T00:00:00Z",
  n: 1,
  values: [],
});

describe("mergeMaskingFirstPage", () => {
  it("keeps the older pages already loaded under a refreshed first page", () => {
    const current = [record("100"), record("90"), record("80"), record("70")];
    const first = [record("110"), record("100")];
    expect(mergeMaskingFirstPage(current, first).map((entry) => entry.key)).toEqual([
      "110",
      "100",
      "90",
      "80",
      "70",
    ]);
  });

  it("does not duplicate a record the first page still carries", () => {
    const current = [record("100"), record("90")];
    const merged = mergeMaskingFirstPage(current, [record("100")]);
    expect(merged.map((entry) => entry.key)).toEqual(["100", "90"]);
  });

  it("keeps the older pages when the first page comes back empty", () => {
    const current = [record("90")];
    expect(mergeMaskingFirstPage(current, [])).toEqual(current);
  });

  it("drops records newer than the refreshed window that the page no longer lists", () => {
    const current = [record("130"), record("120")];
    const merged = mergeMaskingFirstPage(current, [record("120")]);
    expect(merged.map((entry) => entry.key)).toEqual(["120"]);
  });
});

describe("maskingSummaryPending", () => {
  it("counts a first read with no summary as loading, not zero", () => {
    expect(maskingSummaryPending(true, null)).toBe(true);
    expect(maskingSummaryPending(false, null)).toBe(false);
    expect(maskingSummaryPending(true, { n: 0 })).toBe(false);
  });
});
