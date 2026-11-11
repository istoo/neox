import { useState, type CSSProperties } from "react";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "../../proposedPlan";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { ProposedPlanActions } from "./ProposedPlanActions";
import { useTranslation } from "~/i18n";

/** Approve / keep-planning choices owned by the pending plan permission. */
export interface PlanCardApprovalActions {
  readonly isResponding: boolean;
  readonly onImplement: () => void;
  readonly onKeepPlanning: () => void;
  /** Provider actions the standard choices miss (e.g. "Implement with Auto"). */
  readonly providerActions?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly onProviderAction?: (actionId: string) => void;
}

export const ProposedPlanCard = function ProposedPlanCard({
  planMarkdown,
  cwd,
  workspaceRoot,
  chatTypographyStyle,
  approvalActions,
}: {
  planMarkdown: string;
  cwd: string | undefined;
  workspaceRoot: string | undefined;
  chatTypographyStyle?: CSSProperties;
  approvalActions?: PlanCardApprovalActions;
}) {
  const { t } = useTranslation();

  const [expanded, setExpanded] = useState(false);
  const title = proposedPlanTitle(planMarkdown) ?? t("chat:proposedPlan");
  const lineCount = planMarkdown.split("\n").length;
  const canCollapse = planMarkdown.length > 900 || lineCount > 20;
  const displayedPlanMarkdown = stripDisplayedPlanMarkdown(planMarkdown);
  const collapsedPreview = canCollapse
    ? buildCollapsedProposedPlanPreviewMarkdown(planMarkdown, { maxLines: 10 })
    : null;
  return (
    <div className="rounded-[24px] border border-border/80 bg-card/70 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">{t("workspace:plan_badge")}</Badge>
          <p className="truncate text-ui-lg font-medium text-foreground">{title}</p>
        </div>
        <ProposedPlanActions planMarkdown={planMarkdown} workspaceRoot={workspaceRoot} />
      </div>
      <div className="mt-4">
        <div className={cn("relative", canCollapse && !expanded && "max-h-104 overflow-hidden")}>
          {canCollapse && !expanded ? (
            <ChatMarkdown
              text={collapsedPreview ?? ""}
              cwd={cwd}
              isStreaming={false}
              style={chatTypographyStyle}
            />
          ) : (
            <ChatMarkdown
              text={displayedPlanMarkdown}
              cwd={cwd}
              isStreaming={false}
              style={chatTypographyStyle}
            />
          )}
          {canCollapse && !expanded ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-card/95 via-card/80 to-transparent" />
          ) : null}
        </div>
        {canCollapse ? (
          <div className="mt-4 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t("chat:collapsePlan") : t("chat:expandPlan")}
            </Button>
          </div>
        ) : null}
      </div>
      {approvalActions ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Button
            size="sm"
            disabled={approvalActions.isResponding}
            onClick={approvalActions.onImplement}
          >
            {t("chat:composer_implement")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={approvalActions.isResponding}
            onClick={approvalActions.onKeepPlanning}
          >
            {t("chat:planApproval_keepPlanning")}
          </Button>
          {approvalActions.providerActions?.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant="outline"
              disabled={approvalActions.isResponding}
              onClick={() => approvalActions.onProviderAction?.(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
