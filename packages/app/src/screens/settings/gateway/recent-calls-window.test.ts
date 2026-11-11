import { describe, expect, it } from "vitest";
import { recentCallsWindow } from "./recent-calls-window";

describe("recentCallsWindow", () => {
  it("shows the first page and offers the same size again", () => {
    expect(recentCallsWindow(50, 10, 10)).toEqual({ visible: 10, more: 10 });
  });

  it("stops at the end, offering only what is left", () => {
    expect(recentCallsWindow(14, 10, 10)).toEqual({ visible: 10, more: 4 });
    expect(recentCallsWindow(14, 14, 10)).toEqual({ visible: 14, more: 0 });
  });

  it("hides the button when the first page already holds everything", () => {
    expect(recentCallsWindow(7, 10, 10)).toEqual({ visible: 7, more: 0 });
  });
});
