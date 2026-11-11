// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRowActionReveal } from "./use-row-action-reveal";

function focusTarget(focusVisible: boolean) {
  return {
    target: { matches: (selector: string) => selector === ":focus-visible" && focusVisible },
  };
}

describe("useRowActionReveal", () => {
  it("reveals hover-only row actions when a keyboard-focused element receives focus", () => {
    const { result } = renderHook(() => useRowActionReveal());

    act(() => result.current.focusHandlers.onFocus(focusTarget(true)));
    expect(result.current.focusWithin).toBe(true);

    act(() => result.current.focusHandlers.onBlur());
    expect(result.current.focusWithin).toBe(false);
  });

  it("does not reveal actions after a pointer press focuses the row", () => {
    const { result } = renderHook(() => useRowActionReveal());

    act(() => result.current.focusHandlers.onFocus(focusTarget(false)));

    expect(result.current.focusWithin).toBe(false);
  });
});
