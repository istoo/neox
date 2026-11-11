import { useCallback, useMemo, useState } from "react";
import { isWeb } from "@/constants/platform";

interface FocusLikeEvent {
  target?: unknown;
}

interface RowActionRevealHandlers {
  onFocus: (event: FocusLikeEvent) => void;
  onBlur: () => void;
}

function isKeyboardFocus(event: FocusLikeEvent): boolean {
  if (!isWeb) return true;
  const target = event.target as { matches?: (selector: string) => boolean } | null | undefined;
  if (typeof target?.matches !== "function") return true;
  return target.matches(":focus-visible");
}

/**
 * Reveals a row's hover-only actions while the row holds keyboard focus.
 *
 * Web rows show their kebab and trailing controls on hover. A keyboard user never hovers, so
 * without this the controls stay unreachable. The row's own focusable element receives focus
 * first, which reveals the controls; the next Tab can then move into them. Point-and-click
 * focus does not count, so the actions do not flash in after a mouse press.
 */
export function useRowActionReveal(): {
  focusWithin: boolean;
  focusHandlers: RowActionRevealHandlers;
} {
  const [focusWithin, setFocusWithin] = useState(false);
  const handleFocus = useCallback((event: FocusLikeEvent) => {
    if (isKeyboardFocus(event)) setFocusWithin(true);
  }, []);
  const handleBlur = useCallback(() => setFocusWithin(false), []);
  const focusHandlers = useMemo(
    () => ({ onFocus: handleFocus, onBlur: handleBlur }),
    [handleFocus, handleBlur],
  );
  return { focusWithin, focusHandlers };
}
