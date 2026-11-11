import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

/**
 * What a sidebar workspace row shows in its trailing slot for a status bucket.
 *
 * The bucket itself still comes from `statusBucket`; this only decides how it surfaces. The
 * mapping is exhaustive so a new bucket cannot silently render nothing.
 */
export type WorkspaceTrailingStatus =
  | { kind: "badge"; variant: Extract<StatusBadgeVariant, "warning" | "error" | "success"> }
  | { kind: "running" }
  | { kind: "none" };

export function resolveWorkspaceTrailingStatus(
  bucket: SidebarStateBucket,
): WorkspaceTrailingStatus {
  switch (bucket) {
    case "needs_input":
      return { kind: "badge", variant: "warning" };
    case "failed":
      return { kind: "badge", variant: "error" };
    case "attention":
      return { kind: "badge", variant: "success" };
    case "running":
      return { kind: "running" };
    case "done":
      return { kind: "none" };
  }
}
