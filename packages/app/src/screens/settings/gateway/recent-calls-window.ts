/** What the recent-calls card shows: myna's callsPage first, then the same again per "Show more". */
export interface RecentCallsWindow {
  /** How many calls to draw now. */
  visible: number;
  /** How many the next "Show more" adds; 0 hides the button. */
  more: number;
}

export function recentCallsWindow(
  total: number,
  shown: number,
  callsPage: number,
): RecentCallsWindow {
  const visible = Math.max(0, Math.min(total, shown));
  const remaining = total - visible;
  return { visible, more: remaining > 0 ? Math.min(callsPage, remaining) : 0 };
}
