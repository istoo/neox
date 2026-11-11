import type { PullRequestDetail, PullRequestStack, PullRequestStackEntry } from "@synara/contracts";

import { t } from "~/i18n";

export type PullRequestStackAssessment = {
  readonly label: string;
  readonly tone: "ready" | "blocked" | "pending" | "warning" | "complete";
  readonly mergeTargetCount: number;
  readonly canAttemptMerge: boolean;
  readonly blocker: string | null;
};

/** Entries affected by merging the selected PR, ordered from the base branch upwards. */
export function pullRequestStackTargetEntries(
  stack: PullRequestStack,
): ReadonlyArray<PullRequestStackEntry> {
  return stack.entries.filter(
    (entry) => entry.position <= stack.position && entry.state !== "merged",
  );
}

export function assessPullRequestStack(stack: PullRequestStack): PullRequestStackAssessment {
  const targets = pullRequestStackTargetEntries(stack);
  if (targets.length === 0) {
    return {
      label: t("git:stackMerged"),
      tone: "complete",
      mergeTargetCount: 0,
      canAttemptMerge: false,
      blocker: null,
    };
  }

  const closed = targets.find((entry) => entry.state === "closed");
  if (closed) {
    return {
      label: t("git:stackNeedsAttention"),
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: t("git:stackEntryClosed", { value0: closed.number }),
    };
  }

  const draft = targets.find((entry) => entry.isDraft);
  if (draft) {
    return {
      label: t("git:stackNeedsAttention"),
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: t("git:stackEntryDraft", { value0: draft.number }),
    };
  }

  const conflicting = targets.find(
    (entry) =>
      entry.mergeability === "conflicting" ||
      ["BLOCKED", "DIRTY", "DRAFT"].includes(entry.mergeStateStatus ?? ""),
  );
  if (conflicting) {
    return {
      label: t("git:stackNeedsAttention"),
      tone: "blocked",
      mergeTargetCount: targets.length,
      canAttemptMerge: false,
      blocker: t("git:stackEntryNotReady", { value0: conflicting.number }),
    };
  }

  if (targets.some((entry) => entry.mergeStateStatus === "UNSTABLE")) {
    return {
      label: t("git:mergeableWithFailingChecks"),
      tone: "warning",
      mergeTargetCount: targets.length,
      canAttemptMerge: true,
      blocker: null,
    };
  }

  const pending = targets.some(
    (entry) =>
      entry.mergeability === "unknown" ||
      entry.mergeStateStatus === null ||
      ["BEHIND", "UNKNOWN"].includes(entry.mergeStateStatus),
  );
  if (pending) {
    return {
      label: t("git:mergeStatusPending"),
      tone: "pending",
      mergeTargetCount: targets.length,
      canAttemptMerge: true,
      blocker: null,
    };
  }

  return {
    label: t("git:readyToMerge"),
    tone: "ready",
    mergeTargetCount: targets.length,
    canAttemptMerge: true,
    blocker: null,
  };
}

export function pullRequestMergeBlocker(
  detail: Pick<PullRequestDetail, "mergeability" | "stackMetadataIncomplete">,
  stackAssessment: PullRequestStackAssessment | null,
): string | null {
  if (detail.stackMetadataIncomplete === true) {
    return t("git:stackDetailsUnavailable");
  }
  if (stackAssessment?.canAttemptMerge === false) {
    return stackAssessment.blocker ?? t("git:stackNotReadyToMerge");
  }
  return detail.mergeability === "conflicting" ? t("git:mergeBlockedConflicts") : null;
}
