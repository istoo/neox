// FILE: SidebarThreadRowContent.tsx
// Purpose: Owns the shared identity and status content rendered by every Sidebar thread row.
// Exports: SidebarThreadRowContent and its terminal-status presentation type.

import type { ReactNode } from "react";
import type { NeolixWorkspaceLabelDefinition } from "@synara/contracts";

import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { workspaceLabelColorClass } from "~/lib/workspaceLabels";

import { useThreadHasPendingDraft } from "../composerDraftStore";
import { resolveThreadHandoffBadgeLabel } from "../lib/threadHandoff";
import { SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME } from "../sidebarRowStyles";
import type { SidebarThreadSummary } from "../types";
import { TerminalIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { ProviderIcon } from "./ProviderIcon";
import { SidebarGlyph } from "./sidebarGlyphs";
import { SidebarDraftGlyph } from "./SidebarStatusTrailingGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { t, useTranslation } from "~/i18n";

export interface SidebarThreadTerminalStatus {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

const TERMINAL_STATUS_LABEL_KEYS: Record<SidebarThreadTerminalStatus["label"], string> = {
  "Terminal input needed": "workspace:terminalInputNeeded",
  "Terminal task completed": "workspace:terminal_taskCompleted",
  "Terminal process running": "workspace:terminal_processRunning",
};

function ProviderAvatarWithTerminal({
  thread,
  terminalStatus,
  terminalCount,
}: {
  thread: SidebarThreadSummary;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
}) {
  const { t } = useTranslation();

  const provider = thread.session?.provider ?? thread.modelSelection.provider;
  const handoffSourceProvider = thread.handoff?.sourceProvider ?? null;
  const handoffTooltip = resolveThreadHandoffBadgeLabel(thread);
  const showBadge = terminalCount > 1 || terminalStatus !== null;
  const badgeTooltip =
    terminalCount > 1
      ? t("workspace:open3", { count: terminalCount })
      : terminalStatus
        ? t(TERMINAL_STATUS_LABEL_KEYS[terminalStatus.label])
        : t("workspace:status_terminalOpen");
  const badgeColorClass = terminalStatus?.colorClass ?? "text-muted-foreground/55";

  const hasHandoff = Boolean(handoffSourceProvider);
  const containerClass = hasHandoff
    ? "relative inline-flex h-3 w-4.5 shrink-0 items-center"
    : "relative inline-flex size-3 shrink-0 items-center justify-center";

  const avatarNode = hasHandoff ? (
    <span className={containerClass}>
      <span className="sidebar-icon-chip absolute left-0 top-1/2 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={handoffSourceProvider!} className="size-2" />
      </span>
      <span className="sidebar-icon-chip absolute right-0 top-1/2 z-10 inline-flex size-3 -translate-y-1/2 items-center justify-center rounded-full">
        <ProviderIcon provider={provider} className="size-2" />
      </span>
    </span>
  ) : (
    <span className={containerClass}>
      <ProviderIcon provider={provider} className="size-3" />
    </span>
  );

  const wrappedAvatar =
    hasHandoff && handoffTooltip ? (
      <Tooltip>
        <TooltipTrigger render={avatarNode} />
        <TooltipPopup side="top">{handoffTooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      avatarNode
    );

  return (
    <span className="relative inline-flex shrink-0 items-center">
      {wrappedAvatar}
      {showBadge ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={badgeTooltip}
                className="sidebar-icon-chip absolute -top-1.5 -right-1.5 inline-flex size-3 min-w-3 items-center justify-center rounded-full px-px"
              >
                {terminalCount > 1 ? (
                  <span
                    className={cn(
                      "text-[8px] font-semibold leading-none tabular-nums",
                      badgeColorClass,
                    )}
                  >
                    {terminalCount}
                  </span>
                ) : (
                  <TerminalIcon className={cn("size-2.5", badgeColorClass)} />
                )}
              </span>
            }
          />
          <TooltipPopup side="top">{badgeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}

export function SidebarThreadRowContent({
  thread,
  terminalEntryPoint,
  terminalStatus,
  terminalCount,
  isActive,
  variant,
  pendingStatusColorClass,
  workspaceLabels,
  suffix,
  title,
  meta,
}: {
  thread: SidebarThreadSummary;
  terminalEntryPoint: boolean;
  terminalStatus: SidebarThreadTerminalStatus | null;
  terminalCount: number;
  isActive: boolean;
  variant: "pinned" | "standard";
  pendingStatusColorClass?: string | null | undefined;
  /** Neox workspace labels shown as quiet colored dots after the title. */
  workspaceLabels?: readonly NeolixWorkspaceLabelDefinition[] | undefined;
  suffix?: ReactNode;
  /** Row label override (workspace name or branch); falls back to the agent title. */
  title?: string | undefined;
  /** Optional second line with configured row fields (branch/project/host/checks/services). */
  meta?: ReactNode;
}) {
  const showThreadProviderAvatar = !isGenericChatThreadTitle(thread.title);
  const hasPendingDraft = useThreadHasPendingDraft(thread.id);
  const displayTitle = title ?? thread.title;

  return (
    <>
      {terminalEntryPoint ? (
        <SidebarGlyph icon={TerminalIcon} variant="chrome" />
      ) : showThreadProviderAvatar ? (
        <ProviderAvatarWithTerminal
          thread={thread}
          terminalStatus={terminalStatus}
          terminalCount={terminalCount}
        />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col text-left">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              // Pinned rows size the title from its text so the suffix yields width first.
              "min-w-0 truncate-fade text-ui leading-5",
              variant === "pinned" ? "flex-auto" : "flex-1",
              isActive ? "text-foreground" : SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
            )}
            data-testid={variant === "pinned" ? `thread-title-${thread.id}` : undefined}
          >
            {displayTitle}
          </span>
          {workspaceLabels && workspaceLabels.length > 0 ? (
            <span
              className="flex shrink-0 items-center gap-0.5"
              title={workspaceLabels.map((label) => label.name).join(", ")}
              aria-label={workspaceLabels.map((label) => label.name).join(", ")}
            >
              {workspaceLabels.slice(0, 3).map((label) => (
                <span
                  key={label.name}
                  className={cn("size-1.5 rounded-full", workspaceLabelColorClass(label.color))}
                />
              ))}
            </span>
          ) : null}
          {hasPendingDraft ? <SidebarDraftGlyph /> : null}
          {pendingStatusColorClass ? (
            <span
              aria-label={t("workspace:pendingApproval")}
              className={cn("shrink-0 text-ui-xs font-medium", pendingStatusColorClass)}
            >
              {t("workspace:pending")}
            </span>
          ) : null}
          {variant === "pinned" ? suffix : null}
        </div>
        {meta ? (
          <div
            data-slot="sidebar-thread-row-meta"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ui-xs leading-4 text-muted-foreground/55"
          >
            {meta}
          </div>
        ) : null}
      </div>
      {variant === "pinned" ? null : suffix}
    </>
  );
}
