// FILE: kanbanLabels.ts
// Purpose: Column and attention-pill copy for the board in the UI language. The shared
//          `KANBAN_*_LABELS` constants stay English for logic and tests.
// Layer: Web kanban presentation

import type { KanbanAttentionFlag, KanbanColumnV2Key } from "@synara/shared/kanban";

import { t } from "~/i18n";

const COLUMN_KEYS: Readonly<Record<KanbanColumnV2Key, string>> = {
  draft: "common:kanbanColumn_draft",
  inProgress: "common:kanbanColumn_inProgress",
  awaitingYou: "common:kanbanColumn_awaitingYou",
  done: "common:kanbanColumn_done",
};

const ATTENTION_KEYS: Readonly<Record<KanbanAttentionFlag, string>> = {
  failed: "common:kanbanAttention_failed",
  stuck: "common:kanbanAttention_stuck",
  "awaiting-approval": "common:kanbanAttention_awaitingApproval",
  "awaiting-input": "common:kanbanAttention_awaitingInput",
  "needs-review": "common:kanbanAttention_needsReview",
};

export function kanbanColumnLabel(column: KanbanColumnV2Key, translate: typeof t = t): string {
  return translate(COLUMN_KEYS[column]);
}

export function kanbanAttentionLabel(flag: KanbanAttentionFlag, translate: typeof t = t): string {
  return translate(ATTENTION_KEYS[flag]);
}
