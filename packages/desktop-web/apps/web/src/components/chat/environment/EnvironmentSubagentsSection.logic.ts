// FILE: EnvironmentSubagentsSection.logic.ts
// Purpose: Derives the Environment panel's subagent roster: every subagent the thread
//          (or, from a subagent thread, its parent) has spawned, not only the live-turn
//          set the composer strip shows. Live rows lead in spawn order; settled rows follow,
//          most recently settled first. Rows reuse the strip's identity/status and add the
//          Claude task usage (tokens, tool uses, duration, last tool, result summary) that
//          task.* activities carry, joined by the Task tool_use_id.
// Layer: Environment panel logic
// Exports: deriveEnvironmentSubagentRoster, environmentSubagentElapsedMs,
//          formatEnvironmentSubagentMeta, and the roster types

import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ThreadId,
} from "@synara/contracts";

import { t } from "~/i18n";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  formatSubagentModelLabel,
  resolveSubagentPresentationForThread,
  resolveSubagentThreadStatusKind,
  type SubagentStatusKind,
} from "~/lib/subagentPresentation";

import type { WorkLogEntry } from "../../../session-logic";
import type { ThreadSession, ThreadShell } from "../../../types";
import {
  collectSubagentStripItems,
  type ComposerSubagentStripItem,
} from "../ComposerSubagentStrip.logic";
import {
  collectTaskSnapshots,
  type TaskSnapshot,
  workflowElapsedMs,
} from "../WorkflowRunCard.logic";

export interface EnvironmentSubagentRosterItem extends ComposerSubagentStripItem {
  startedAt: string | null;
  settledAt: string | null;
  totalTokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  lastToolName: string | null;
  summary: string | null;
}

export interface EnvironmentSubagentRoster {
  active: EnvironmentSubagentRosterItem[];
  previous: EnvironmentSubagentRosterItem[];
}

export const EMPTY_ENVIRONMENT_SUBAGENT_ROSTER: EnvironmentSubagentRoster = {
  active: [],
  previous: [],
};

const NO_BACKGROUNDED_THREAD_IDS: ReadonlySet<string> = new Set();

function isLiveRosterItem(item: Pick<ComposerSubagentStripItem, "statusKind">): boolean {
  return item.statusKind === "running" || item.statusKind === "queued";
}

function compareIsoAscending(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

/**
 * A managed child agent as the dock needs it. Managed children (`create_agent`) exist as
 * first-class threads linked by `parentThreadId`; their launch tool call is an MCP call,
 * not a collab activity, so the activity-derived roster never sees them. Reading the
 * thread link is the same source the old app's agent list used.
 */
export interface ManagedChildThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly parentThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly error: string | null;
  readonly subagentAgentId: string | null;
  readonly subagentNickname: string | null;
  readonly subagentRole: string | null;
  readonly modelSelection: ThreadShell["modelSelection"];
  readonly session: Pick<ThreadSession, "status"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state" | "completedAt"> | null;
}

const MANAGED_STATUS_LABEL_KEYS: Record<SubagentStatusKind, string> = {
  running: "chat:runStatus_running",
  completed: "workspace:triageOutcome_completed",
  failed: "chat:runStatus_failed",
  stopped: "chat:stopped",
  queued: "workspace:runStatus_queued",
  idle: "chat:idle",
};

function managedStatusLabel(statusKind: SubagentStatusKind | null): string | undefined {
  return statusKind ? t(MANAGED_STATUS_LABEL_KEYS[statusKind]) : undefined;
}

/**
 * Rows for the managed child agents of `parentThreadId`. Status and identity come from
 * the child thread itself (its own session and latest turn), which is what makes a
 * running child visible before its parent's work log mentions it.
 */
export function deriveManagedChildRosterItems(input: {
  threads: ReadonlyArray<ManagedChildThread>;
  parentThreadId: ThreadId;
  viewedThreadId?: ThreadId | null;
}): EnvironmentSubagentRosterItem[] {
  const viewedThreadId = input.viewedThreadId ?? null;
  return input.threads
    .filter(
      (thread) => thread.parentThreadId === input.parentThreadId && thread.archivedAt === null,
    )
    .map((thread): EnvironmentSubagentRosterItem => {
      const presentation = resolveSubagentPresentationForThread({
        thread,
        threads: input.threads,
      });
      const statusKind = resolveSubagentThreadStatusKind(thread);
      const isActive = isLiveRosterItem({ statusKind });
      return {
        kind: "subagent",
        // `managed:` keeps the key distinct from work-log rows keyed by provider thread id.
        key: `managed:${thread.id}`,
        threadId: thread.id,
        providerThreadId: thread.id,
        primaryLabel: presentation.primaryLabel,
        fullLabel: presentation.fullLabel,
        role: presentation.role,
        modelLabel: formatSubagentModelLabel(thread.modelSelection?.model),
        statusLabel: managedStatusLabel(statusKind),
        statusKind,
        isActive,
        isViewed: viewedThreadId === thread.id,
        isBackground: false,
        accentColor: presentation.accentColor,
        startedAt: thread.createdAt,
        settledAt: isActive ? null : (thread.settledAt ?? thread.latestTurn?.completedAt ?? null),
        totalTokens: null,
        toolUses: null,
        durationMs: null,
        lastToolName: null,
        summary: null,
      };
    });
}

/**
 * Adds managed-child rows to an activity-derived roster. A child that already produced a
 * collab row (provider-native children imported as agents) is keyed by the same thread id
 * there, so the work-log row wins and carries its task usage.
 */
export function mergeEnvironmentSubagentRosters(
  base: EnvironmentSubagentRoster,
  managed: ReadonlyArray<EnvironmentSubagentRosterItem>,
): EnvironmentSubagentRoster {
  if (managed.length === 0) {
    return base;
  }
  const seenThreadIds = new Set([...base.active, ...base.previous].map((item) => item.threadId));
  const additions = managed.filter((item) => !seenThreadIds.has(item.threadId));
  if (additions.length === 0) {
    return base;
  }
  const active = [...base.active, ...additions.filter(isLiveRosterItem)].toSorted((left, right) =>
    compareIsoAscending(left.startedAt, right.startedAt),
  );
  const previous = [
    ...base.previous,
    ...additions.filter((item) => !isLiveRosterItem(item)),
  ].toSorted((left, right) =>
    compareIsoAscending(right.settledAt ?? right.startedAt, left.settledAt ?? left.startedAt),
  );
  return { active, previous };
}

export function deriveEnvironmentSubagentRoster(input: {
  workEntries: ReadonlyArray<WorkLogEntry>;
  // Activities of the thread that owns the Task tool calls (the strip source thread).
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  backgroundedProviderThreadIds?: ReadonlySet<string>;
  viewedThreadId?: ThreadId | null;
}): EnvironmentSubagentRoster {
  // Row keys are the subagent's provider thread id (see collectSubagentStripItems);
  // the first entry that names one is the best spawn time when no task.started exists.
  const firstSeenAtByKey = new Map<string, string>();
  for (const entry of input.workEntries) {
    for (const subagent of entry.subagents ?? []) {
      if (!firstSeenAtByKey.has(subagent.threadId)) {
        firstSeenAtByKey.set(subagent.threadId, entry.createdAt);
      }
    }
  }
  if (firstSeenAtByKey.size === 0) {
    return EMPTY_ENVIRONMENT_SUBAGENT_ROSTER;
  }

  const taskByToolUseId = new Map<string, TaskSnapshot>();
  for (const snapshot of collectTaskSnapshots(input.activities).values()) {
    if (snapshot.toolUseId) {
      taskByToolUseId.set(snapshot.toolUseId, snapshot);
    }
  }

  const items = collectSubagentStripItems(
    input.workEntries,
    input.backgroundedProviderThreadIds ?? NO_BACKGROUNDED_THREAD_IDS,
    input.viewedThreadId ?? null,
  ).map((item): EnvironmentSubagentRosterItem => {
    const task = taskByToolUseId.get(item.providerThreadId);
    // Items are freshly built per call, so extend them in place.
    return Object.assign(item, {
      startedAt: task?.startedAt ?? firstSeenAtByKey.get(item.key) ?? null,
      // The strip status (child thread session) is authoritative; a reopened task can
      // still carry an earlier settle time, so only settled rows report one.
      settledAt: isLiveRosterItem(item) ? null : (task?.settledAt ?? null),
      totalTokens: task?.totalTokens ?? null,
      toolUses: task?.toolUses ?? null,
      durationMs: task?.durationMs ?? null,
      lastToolName: task?.lastToolName ?? null,
      summary: task?.summary ?? null,
    });
  });

  const active = items
    .filter(isLiveRosterItem)
    .toSorted((left, right) => compareIsoAscending(left.startedAt, right.startedAt));
  const previous = items
    .filter((item) => !isLiveRosterItem(item))
    .toSorted((left, right) =>
      compareIsoAscending(right.settledAt ?? right.startedAt, left.settledAt ?? left.startedAt),
    );
  return { active, previous };
}

// Live rows tick from their spawn time; settled rows prefer the provider-reported
// duration and fall back to the spawn→settle wall clock.
export function environmentSubagentElapsedMs(
  item: Pick<
    EnvironmentSubagentRosterItem,
    "durationMs" | "settledAt" | "startedAt" | "statusKind"
  >,
  nowMs: number,
): number | null {
  if (item.statusKind === "queued") {
    return null;
  }
  if (!item.startedAt) {
    return item.durationMs;
  }
  const elapsedMs = workflowElapsedMs(
    {
      durationMs: item.durationMs,
      statusKind: item.statusKind ?? "completed",
      startedAt: item.startedAt,
    },
    nowMs,
  );
  if (elapsedMs !== null) {
    return elapsedMs;
  }
  const startedAtMs = Date.parse(item.startedAt);
  const settledAtMs = item.settledAt ? Date.parse(item.settledAt) : Number.NaN;
  return Number.isNaN(startedAtMs) || Number.isNaN(settledAtMs)
    ? null
    : Math.max(0, settledAtMs - startedAtMs);
}

// Secondary line after the status word. A failure shows its reason; a live row shows
// what it is doing now (last tool, tokens so far); a settled row shows its totals.
export function formatEnvironmentSubagentMeta(
  item: Pick<
    EnvironmentSubagentRosterItem,
    | "isActive"
    | "isBackground"
    | "lastToolName"
    | "statusKind"
    | "summary"
    | "toolUses"
    | "totalTokens"
  >,
  includeFailureSummary = true,
): string | null {
  if (includeFailureSummary && item.statusKind === "failed" && item.summary) {
    return item.summary;
  }
  const parts = [
    item.isActive && item.isBackground ? "background" : null,
    item.isActive ? item.lastToolName : null,
    item.totalTokens !== null ? `${formatContextWindowTokens(item.totalTokens)} tokens` : null,
    !item.isActive && item.toolUses !== null
      ? t("chat:toolCallCount", { count: item.toolUses })
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}
