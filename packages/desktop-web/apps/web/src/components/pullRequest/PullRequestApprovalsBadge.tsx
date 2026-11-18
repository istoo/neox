// FILE: PullRequestApprovalsBadge.tsx
// Purpose: GitLab's "given of required" approvals, shown in the pull request heading. Green
//          once the rule is met; the counts come from the daemon's forge facts.
// Layer: Pull request presentation
// Exports: PullRequestApprovalsBadge

import type { PullRequestApprovals } from "@synara/contracts";

import { CircleCheckIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

import { PR_META_TEXT_CLASS_NAME } from "./pullRequestText";

export function PullRequestApprovalsBadge({ approvals }: { approvals: PullRequestApprovals }) {
  const { t } = useTranslation();
  const met = approvals.given >= approvals.required;
  return (
    <span
      className={cn(
        PR_META_TEXT_CLASS_NAME,
        "inline-flex items-center gap-1",
        met ? "text-[var(--color-success)]" : "text-muted-foreground",
      )}
      data-testid="pr-approvals-badge"
    >
      <CircleCheckIcon className="size-3.5 shrink-0" aria-hidden />
      {t("git:prApprovals", { given: approvals.given, required: approvals.required })}
    </span>
  );
}
