/** The day the history is showing: the picked one, else the newest it carries. */
export function selectedHistoryDay(day: string, days: readonly string[]): string {
  return day.length > 0 ? day : (days.at(-1) ?? "");
}
