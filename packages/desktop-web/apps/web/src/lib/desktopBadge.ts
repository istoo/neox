// FILE: desktopBadge.ts
// Purpose: The macOS Dock badge count, derived from the threads the user must act on.
// Layer: Web model

export interface DesktopBadgeThread {
  readonly archivedAt?: string | null | undefined;
  readonly parentThreadId?: string | null | undefined;
  readonly sessionStatus?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly hasActionableProposedPlan?: boolean | undefined;
}

/** Matches the sidebar's needs-input/failed/attention buckets, one per top-level thread. */
export function isThreadActionableForDesktopBadge(thread: DesktopBadgeThread): boolean {
  if (thread.archivedAt) return false;
  if (thread.parentThreadId) return false;
  return (
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true ||
    thread.hasActionableProposedPlan === true ||
    thread.sessionStatus === "error"
  );
}

export function countDesktopBadgeThreads(threads: ReadonlyArray<DesktopBadgeThread>): number {
  let count = 0;
  for (const thread of threads) {
    if (isThreadActionableForDesktopBadge(thread)) count += 1;
  }
  return count;
}
