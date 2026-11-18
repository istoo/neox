import type { ReactNode } from "react";

import {
  SIDEBAR_PROJECT_NAME_CLASS_NAME,
  SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import { cn } from "../lib/utils";
import { SidebarLeadingIcon } from "./SidebarLeadingIcon";

/** Shared project-row layout; the caller supplies its own host-scoped icon and actions. */
export function SidebarProjectRowContent({
  icon,
  label,
  labelAccessory,
  hostName,
  hostBadge,
  iconClassName,
  reserveClassName,
  trailing,
}: {
  icon: ReactNode;
  label: string;
  labelAccessory?: ReactNode;
  hostName?: string;
  /** Host identity rendered per the host's appearance setting; wins over `hostName`. */
  hostBadge?: ReactNode;
  iconClassName?: string;
  reserveClassName?: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <SidebarLeadingIcon
        size="sm"
        tone={SIDEBAR_ROW_LABEL_TEXT_CLASS_NAME}
        className={iconClassName}
      >
        {icon}
      </SidebarLeadingIcon>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden transition-[padding] duration-150 ease-out",
          reserveClassName,
        )}
      >
        <span className={cn(SIDEBAR_PROJECT_NAME_CLASS_NAME, labelAccessory && "flex-initial")}>
          {label}
        </span>
        {labelAccessory}
        {hostBadge ??
          (hostName ? (
            <span className="max-w-[40%] shrink-0 truncate text-ui-xs text-muted-foreground">
              {hostName}
            </span>
          ) : null)}
      </div>
      {trailing}
    </>
  );
}
