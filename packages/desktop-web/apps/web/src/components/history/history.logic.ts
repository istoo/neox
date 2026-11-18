// FILE: history.logic.ts
// Purpose: Pure aggregation for the History page: local and connected-host
//   sessions in one list, the host filter, and title/project/content matching.
// Layer: History screen logic

import type { OrchestrationShellSnapshot, ProviderKind } from "@synara/contracts";

import type { Project, Thread } from "~/types";
import type { WorkspaceSession } from "~/lib/hosts/workspaceSessions";

/** One session row, whichever computer it came from. */
export interface HistorySession {
  readonly id: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly isLocal: boolean;
  readonly title: string;
  readonly projectName: string;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  /** Message-body hit from this host's search; null for title/project matches. */
  readonly snippet: string | null;
  readonly messageMatchCount: number;
}

export interface HistoryHostOption {
  readonly id: string;
  readonly name: string;
}

export const ALL_HISTORY_HOSTS_ID = "*";

/** The host picker's rows, local first, then connected hosts in connection order. */
export function buildHistoryHosts(input: {
  local: HistoryHostOption;
  sessions: readonly WorkspaceSession[];
}): HistoryHostOption[] {
  const seen = new Set([input.local.id]);
  const hosts: HistoryHostOption[] = [input.local];
  for (const session of input.sessions) {
    const id = session.host.executionScope.environmentId;
    if (seen.has(id)) continue;
    seen.add(id);
    hosts.push({ id, name: session.host.hostName });
  }
  return hosts;
}

function timestamp(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
}

/** Local sessions carry project details; nested subagent threads are not standalone sessions. */
export function localHistorySessions(input: {
  threads: readonly Thread[];
  projects: readonly Project[];
  host: HistoryHostOption;
}): HistorySession[] {
  const projectById = new Map(input.projects.map((project) => [project.id, project] as const));
  return input.threads.flatMap((thread) => {
    if (thread.parentThreadId) return [];
    const project = projectById.get(thread.projectId);
    return [
      {
        id: thread.id,
        hostId: input.host.id,
        hostName: input.host.name,
        isLocal: true,
        title: thread.title,
        projectName: project?.localName ?? project?.name ?? thread.projectId,
        provider: thread.modelSelection.provider,
        createdAt: timestamp(thread.createdAt),
        updatedAt: timestamp(thread.updatedAt ?? thread.createdAt),
        archived: thread.archivedAt != null,
        snippet: null,
        messageMatchCount: 0,
      },
    ];
  });
}

/** Connected hosts publish session metadata, so their rows match on title and names only. */
export function remoteHistorySessions(sessions: readonly WorkspaceSession[]): HistorySession[] {
  return sessions.flatMap((session) => {
    const hostId = session.host.executionScope.environmentId;
    const projectById = new Map(
      (session.summary?.projects ?? []).map((project) => [project.id, project] as const),
    );
    return (session.summary?.threads ?? []).flatMap((thread) => {
      if (thread.parentThreadId) return [];
      const project = projectById.get(thread.projectId);
      return [
        {
          id: thread.id,
          hostId,
          hostName: session.host.hostName,
          isLocal: false,
          title: thread.title,
          projectName: project?.name ?? thread.projectId,
          provider: thread.modelSelection.provider,
          createdAt: timestamp(thread.createdAt),
          updatedAt: timestamp(thread.updatedAt ?? thread.createdAt),
          archived: thread.archivedAt != null,
          snippet: null,
          messageMatchCount: 0,
        },
      ];
    });
  });
}

/**
 * Connected hosts answer with a shell snapshot instead of a frame summary, so
 * archived sessions and hosts whose frame was never opened are both visible.
 */
export function remoteHistorySessionsFromShells(input: {
  readonly hosts: readonly {
    readonly environmentId: string;
    readonly hostName: string;
    readonly snapshot: OrchestrationShellSnapshot;
  }[];
}): HistorySession[] {
  return input.hosts.flatMap(({ environmentId, hostName, snapshot }) => {
    const projectById = new Map(snapshot.projects.map((project) => [project.id, project] as const));
    return snapshot.threads.flatMap((thread) => {
      if (thread.parentThreadId) return [];
      const project = projectById.get(thread.projectId);
      return [
        {
          id: thread.id,
          hostId: environmentId,
          hostName,
          isLocal: false,
          title: thread.title,
          projectName: project?.title ?? thread.projectId,
          provider: thread.modelSelection.provider,
          createdAt: timestamp(thread.createdAt),
          updatedAt: timestamp(thread.updatedAt ?? thread.createdAt),
          archived: thread.archivedAt != null,
          snippet: null,
          messageMatchCount: 0,
        },
      ];
    });
  });
}

/** Message hits from every host, keyed like the session rows they decorate. */
export function messageMatchesAcrossHosts(
  results: readonly {
    readonly environmentId: string;
    readonly matches: readonly { threadId: string; excerpt: string; matchCount: number }[];
  }[],
): HistoryMessageMatches {
  const byKey = new Map<string, HistoryMessageMatch>();
  for (const result of results) {
    for (const match of result.matches) {
      byKey.set(historyKey({ hostId: result.environmentId, id: match.threadId }), {
        snippet: match.excerpt,
        matchCount: Math.max(1, match.matchCount),
      });
    }
  }
  return byKey;
}

/**
 * Snapshots carry every archived thread, so the screen pages the merged list
 * client-side instead of asking each host for a page number.
 */
export function paginateHistorySessions(
  sessions: readonly HistorySession[],
  visibleCount: number,
): {
  readonly visible: readonly HistorySession[];
  readonly hasMore: boolean;
} {
  const limit = Math.max(0, Math.trunc(visibleCount));
  return {
    visible: sessions.slice(0, limit),
    hasMore: sessions.length > limit,
  };
}

function historyKey(session: Pick<HistorySession, "hostId" | "id">): string {
  return `${session.hostId}:${session.id}`;
}

/** Newest activity first; ids break ties so a refetch cannot reshuffle equals. */
export function sortHistorySessions(sessions: readonly HistorySession[]): HistorySession[] {
  return [...sessions].toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.hostName.localeCompare(right.hostName) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
}

export interface HistoryMessageMatch {
  readonly snippet: string;
  readonly matchCount: number;
}

export type HistoryMessageMatches = ReadonlyMap<string, HistoryMessageMatch>;

/** Message hits keyed the same way as sessions, from this host's search result. */
export function localMessageMatches(input: {
  matches: readonly { threadId: string; excerpt: string; matchCount: number }[];
  hostId: string;
}): HistoryMessageMatches {
  const byKey = new Map<string, HistoryMessageMatch>();
  for (const match of input.matches) {
    byKey.set(historyKey({ hostId: input.hostId, id: match.threadId }), {
      snippet: match.excerpt,
      matchCount: Math.max(1, match.matchCount),
    });
  }
  return byKey;
}

function normalize(value: string): string {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase();
}

/**
 * Host filter first, then one query over every field a row shows. A message hit
 * keeps the row even when the query itself never appears in the metadata.
 */
export function filterHistorySessions(input: {
  sessions: readonly HistorySession[];
  hostId: string;
  query: string;
  messageMatches?: HistoryMessageMatches | undefined;
}): HistorySession[] {
  const query = normalize(input.query);
  const tokens = query.split(" ").filter(Boolean);
  return input.sessions.flatMap((session) => {
    if (input.hostId !== ALL_HISTORY_HOSTS_ID && session.hostId !== input.hostId) return [];
    const message = input.messageMatches?.get(historyKey(session));
    if (tokens.length === 0) {
      return [session];
    }
    const fields = normalize(
      [session.title, session.projectName, session.hostName, session.provider].join(" "),
    );
    const messageText = message ? normalize(message.snippet) : "";
    const matches = tokens.every((token) => fields.includes(token) || messageText.includes(token));
    if (!matches) return [];
    return [
      {
        ...session,
        snippet: message?.snippet ?? null,
        messageMatchCount: message?.matchCount ?? 0,
      },
    ];
  });
}
