import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@neolix/protocol/agent-lifecycle";

/**
 * Header status is the active agent's own lifecycle state. It deliberately does not
 * roll several agents together — the header names the session the user is reading.
 */
export type WorkspaceHeaderStatusTone = "running" | "idle" | "error";

export interface WorkspaceHeaderStatus {
  tone: WorkspaceHeaderStatusTone;
  labelKey: string;
}

const STATUS_PRESENTATION: Record<AgentLifecycleStatus, WorkspaceHeaderStatus> = {
  initializing: { tone: "running", labelKey: "agentList.status.initializing" },
  idle: { tone: "idle", labelKey: "agentList.status.idle" },
  running: { tone: "running", labelKey: "sidebar.statusBucket.working" },
  error: { tone: "error", labelKey: "agentList.status.error" },
  closed: { tone: "idle", labelKey: "agentList.status.closed" },
};

export function resolveWorkspaceHeaderStatus(
  status: string | null | undefined,
): WorkspaceHeaderStatus | null {
  if (!status || !isAgentLifecycleStatus(status)) {
    return null;
  }
  return STATUS_PRESENTATION[status];
}

function isAgentLifecycleStatus(value: string): value is AgentLifecycleStatus {
  return AGENT_LIFECYCLE_STATUSES.some((status) => status === value);
}
