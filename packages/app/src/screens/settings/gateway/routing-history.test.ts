import { describe, expect, it } from "vitest";
import { splitArchiveName } from "@/hooks/use-gateway-diagnostics";
import { selectedHistoryDay } from "./routing-history-day";

describe("splitArchiveName", () => {
  it("splits the <date>/<id> the archive header and history rows carry", () => {
    expect(splitArchiveName("2026-11-05/101500-abcd1234")).toEqual({
      date: "2026-11-05",
      id: "101500-abcd1234",
    });
  });

  it("answers nothing for a call without an archive or a malformed name", () => {
    expect(splitArchiveName(null)).toEqual({ date: null, id: null });
    expect(splitArchiveName("2026-11-05")).toEqual({ date: null, id: null });
    expect(splitArchiveName("/abcd")).toEqual({ date: null, id: null });
    expect(splitArchiveName("2026-11-05/")).toEqual({ date: null, id: null });
  });
});

describe("selectedHistoryDay", () => {
  it("keeps showing the day the reader picked", () => {
    expect(selectedHistoryDay("2026-11-03", ["2026-11-03", "2026-11-04"])).toBe("2026-11-03");
  });

  it("shows the newest day when nothing is picked", () => {
    expect(selectedHistoryDay("", ["2026-11-03", "2026-11-04"])).toBe("2026-11-04");
  });
});
