import { describe, expect, it } from "vitest";

import { parseHistoryBodyTab, resolveSseView } from "./gatewayViewPreferences.logic";

describe("gatewayViewPreferences", () => {
  it("keeps only a known request-detail tab", () => {
    expect(parseHistoryBodyTab("prompt")).toBe("prompt");
    expect(parseHistoryBodyTab("reply")).toBe("reply");
    expect(parseHistoryBodyTab("unknown")).toBe("request");
    expect(parseHistoryBodyTab(null)).toBe("request");
  });

  it("drops Reply for a stream that spells none", () => {
    expect(resolveSseView("reply", true)).toBe("reply");
    expect(resolveSseView("reply", false)).toBe("events");
    expect(resolveSseView("raw", false)).toBe("raw");
    expect(resolveSseView(null, true)).toBe("events");
  });
});
