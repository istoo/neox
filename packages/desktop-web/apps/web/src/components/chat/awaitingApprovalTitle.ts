// The browser tab says so while any mounted chat pane is blocked on approval, so the user
// notices a request that arrived while they were in another tab.
import { APP_DISPLAY_NAME } from "~/branding";
import { t } from "~/i18n";

const awaitingApprovalThreadIds = new Set<string>();

interface DocumentTitleTarget {
  title: string;
}

type Translate = (key: string) => string;

export function syncAwaitingApprovalTitle(
  target: DocumentTitleTarget,
  translate: Translate = t,
): void {
  target.title =
    awaitingApprovalThreadIds.size > 0
      ? translate("chat:timeline_awaitingApproval")
      : APP_DISPLAY_NAME;
}

export function setThreadAwaitingApproval(
  threadId: string,
  awaiting: boolean,
  target: DocumentTitleTarget = document,
  translate: Translate = t,
): void {
  if (awaiting) {
    awaitingApprovalThreadIds.add(threadId);
  } else {
    awaitingApprovalThreadIds.delete(threadId);
  }
  syncAwaitingApprovalTitle(target, translate);
}

/** Test seam: the registry is process-wide so panes cannot disagree about the title. */
export function resetAwaitingApprovalTitleForTests(): void {
  awaitingApprovalThreadIds.clear();
}
