// FILE: SidebarHostBadge.tsx
// Purpose: Renders the per-host sidebar badge (name, icon, or nothing) exactly as the
//          user configured it in Connections › Other computers.
// Layer: Sidebar UI primitive
// Exports: SidebarHostBadge

import { useAppSettings } from "~/appSettings";
import {
  hostColorValue,
  readHostAppearance,
  resolveHostBadgeDisplay,
} from "~/lib/hosts/appearance";
import { GlobeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

/**
 * One host identity for sidebar thread rows and workspace titles.
 *
 * The appearance setting is client-side, so a local row falls back to `hidden`
 * and a remote row to its name; an explicit name/icon/hidden choice wins.
 */
export function SidebarHostBadge({
  hostId,
  hostName,
  isLocal = false,
  leadingIcon = false,
  iconClassName,
  toneClassName,
  className,
}: {
  hostId: string;
  hostName: string;
  isLocal?: boolean;
  /** Keep the globe beside a named badge, matching the old remote-row marker. */
  leadingIcon?: boolean;
  iconClassName?: string;
  /** Resting tone when the host has no configured colour. */
  toneClassName?: string;
  className?: string;
}) {
  const { settings } = useAppSettings();
  const appearance = readHostAppearance(settings.hostAppearance, hostId);
  const display = resolveHostBadgeDisplay({ appearance, isLocalHost: isLocal });
  if (display === "hidden") return null;

  const color = hostColorValue(appearance.color);
  const style = color ? { color } : undefined;
  const iconClass = iconClassName ?? "size-3";
  const tone = toneClassName ?? "text-muted-foreground";

  if (display === "icon" || leadingIcon) {
    return (
      <span
        data-slot="sidebar-host-badge"
        data-host-id={hostId}
        role={display === "icon" ? "img" : undefined}
        aria-label={hostName}
        title={hostName}
        className={cn(
          "inline-flex min-w-0 shrink items-center gap-1.5 overflow-hidden",
          display === "icon" && "justify-center",
          tone,
          className,
        )}
        style={style}
      >
        <GlobeIcon className={cn(iconClass, "shrink-0")} aria-hidden />
        {display === "name" ? (
          <span className="min-w-0 truncate text-ui-xs">{hostName}</span>
        ) : null}
      </span>
    );
  }

  return (
    <span
      data-slot="sidebar-host-badge"
      data-host-id={hostId}
      title={hostName}
      className={cn("max-w-[50%] shrink-0 truncate text-ui-xs", tone, className)}
      style={style}
    >
      {hostName}
    </span>
  );
}
