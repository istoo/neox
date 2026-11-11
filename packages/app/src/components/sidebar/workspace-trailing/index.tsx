import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusRing } from "@/components/status-ring";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { resolveWorkspaceTrailingStatus } from "@/components/sidebar/sidebar-workspace-status-trailing";

export type { SidebarWorkspaceTrailing };

/**
 * The slot to the right of a workspace title. Three renderers behind one preference, so
 * every row renderer asks the same question and the kebab overlay geometry stays identical
 * no matter which one is showing.
 *
 * "none" exists because the slot is the only thing competing with the title for width, and
 * a user who never reads the diff would rather have the characters.
 */
export function useSidebarWorkspaceTrailing(): SidebarWorkspaceTrailing {
  const {
    settings: { sidebarWorkspaceTrailing },
  } = useAppSettings();
  return sidebarWorkspaceTrailing;
}

/** Whether the slot has anything to draw for this workspace under the current preference. */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  // The row's state owns the slot whenever it has one to report; the user's diff/timestamp
  // preference fills it only for idle rows.
  if (resolveWorkspaceTrailingStatus(workspace.statusBucket).kind !== "none") return true;
  if (trailing === "diff") return workspace.diffStat !== null;
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return false;
}

export function SidebarWorkspaceTrailingContent({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}) {
  const { t } = useTranslation();
  const status = resolveWorkspaceTrailingStatus(workspace.statusBucket);
  if (status.kind === "badge") {
    return (
      <View testID={`workspace-status-indicator-${workspace.statusBucket}`}>
        <StatusBadge
          size="xs"
          variant={status.variant}
          label={getStatusBucketLabel(workspace.statusBucket, t)}
        />
      </View>
    );
  }
  if (status.kind === "running") {
    return (
      <View
        style={styles.runningStatus}
        testID={`workspace-status-indicator-${workspace.statusBucket}`}
      >
        <StatusRing />
        <Text style={styles.runningStatusText} numberOfLines={1}>
          {getStatusBucketLabel(workspace.statusBucket, t)}
        </Text>
      </View>
    );
  }
  if (trailing === "diff" && workspace.diffStat) {
    return (
      <DiffStat additions={workspace.diffStat.additions} deletions={workspace.diffStat.deletions} />
    );
  }
  if (trailing === "timestamp" && workspace.statusEnteredAt) {
    return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />;
  }
  return null;
}

/**
 * Its own component so the clock stops here. `useCompactTimeAgo` holds state, and state
 * re-renders the component that owns it — keeping that component down to a single `<Text>` is
 * what stops a minute tick from reaching the row, the list, or the diff stat next door.
 */
function WorkspaceTimestamp({ enteredAt }: { enteredAt: Date }) {
  const label = useCompactTimeAgo(enteredAt);
  return (
    <Text style={styles.timestamp} numberOfLines={1} testID="sidebar-workspace-timestamp">
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Running is the one state that reports itself in words as well as a mark. The ring and its
  // label take the running band's blue so the pair reads as one signal.
  runningStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  runningStatusText: {
    color: getStatusDotColor({ theme, bucket: "running" }) ?? undefined,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
  // A step below the project title it shares the row with. The timestamp is the one thing here
  // you never came looking for, so it sits at the bottom of the muted ramp rather than tying
  // with the label naming the group.
  timestamp: {
    height: 20,
    lineHeight: 20,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
}));
