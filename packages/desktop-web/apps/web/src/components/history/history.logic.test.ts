import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { Project, Thread } from "~/types";
import type { WorkspaceSession } from "~/lib/hosts/workspaceSessions";

import {
  ALL_HISTORY_HOSTS_ID,
  buildHistoryHosts,
  filterHistorySessions,
  localHistorySessions,
  localMessageMatches,
  messageMatchesAcrossHosts,
  paginateHistorySessions,
  remoteHistorySessions,
  remoteHistorySessionsFromShells,
  sortHistorySessions,
  type HistorySession,
} from "./history.logic";

const LOCAL_HOST = { id: "local", name: "This Mac" };

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login flow",
    modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "opus" },
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    archivedAt: null,
    messages: [],
    ...overrides,
  } as Thread;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Storefront",
    localName: null,
    ...overrides,
  } as Project;
}

function remoteSession(
  overrides: { hostName?: string; threads?: unknown[] } = {},
): WorkspaceSession {
  return {
    host: {
      hostId: "host-2",
      hostName: overrides.hostName ?? "Studio Mac",
      executionScope: { environmentId: "remote-1" },
    },
    summary: {
      projects: [{ id: "remote-project", name: "Docs", section: "projects" }],
      threads: overrides.threads ?? [
        {
          id: "remote-thread",
          projectId: "remote-project",
          title: "Write the guide",
          modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
      ],
    },
  } as unknown as WorkspaceSession;
}

describe("buildHistoryHosts", () => {
  it("puts the local computer first and dedupes connected hosts", () => {
    const hosts = buildHistoryHosts({
      local: LOCAL_HOST,
      sessions: [
        remoteSession(),
        remoteSession(),
        remoteSession({ hostName: "Other", threads: [] }),
      ],
    });
    expect(hosts).toEqual([LOCAL_HOST, { id: "remote-1", name: "Studio Mac" }]);
  });
});

describe("history aggregation", () => {
  it("skips nested subagent threads and includes archived sessions", () => {
    const local = localHistorySessions({
      threads: [
        thread(),
        thread({
          id: ThreadId.makeUnsafe("child"),
          parentThreadId: ThreadId.makeUnsafe("thread-1"),
        }),
        thread({ id: ThreadId.makeUnsafe("old"), archivedAt: "2026-11-02T00:00:00.000Z" }),
      ],
      projects: [project()],
      host: LOCAL_HOST,
    });
    expect(local.map((session) => session.id)).toEqual(["thread-1", "old"]);
    expect(local[0]?.projectName).toBe("Storefront");
    expect(local[1]?.archived).toBe(true);
  });

  it("uses a project's local name when it has one", () => {
    const [session] = localHistorySessions({
      threads: [thread()],
      projects: [project({ localName: "Shop" })],
      host: LOCAL_HOST,
    });
    expect(session?.projectName).toBe("Shop");
  });

  it("reads connected-host metadata", () => {
    const remote = remoteHistorySessions([remoteSession()]);
    expect(remote[0]).toMatchObject({
      id: "remote-thread",
      hostId: "remote-1",
      hostName: "Studio Mac",
      projectName: "Docs",
      provider: "codex",
      isLocal: false,
    });
  });

  it("sorts newest activity first", () => {
    const sessions: HistorySession[] = [
      {
        id: "old",
        hostId: "local",
        hostName: "This Mac",
        isLocal: true,
        title: "Old",
        projectName: "P",
        provider: "codex",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        archived: false,
        snippet: null,
        messageMatchCount: 0,
      },
      {
        ...sessionsPlaceholder(),
        id: "new",
        updatedAt: "2026-11-04T00:00:00.000Z",
      },
    ];
    expect(sortHistorySessions(sessions).map((session) => session.id)).toEqual(["new", "old"]);
  });
});

function sessionsPlaceholder(): HistorySession {
  return {
    id: "placeholder",
    hostId: "local",
    hostName: "This Mac",
    isLocal: true,
    title: "New",
    projectName: "P",
    provider: "codex",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    archived: false,
    snippet: null,
    messageMatchCount: 0,
  };
}

describe("remote shells", () => {
  const snapshot = {
    snapshotSequence: 3,
    spaces: [],
    projects: [{ id: "remote-project", title: "Docs" }],
    threads: [
      {
        id: "remote-thread",
        projectId: "remote-project",
        title: "Write the guide",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-03T00:00:00.000Z",
        archivedAt: null,
      },
      {
        id: "remote-archived",
        projectId: "remote-project",
        title: "Old notes",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
        archivedAt: "2026-10-03T00:00:00.000Z",
      },
      {
        id: "remote-subagent",
        projectId: "remote-project",
        parentThreadId: "remote-thread",
        title: "Subagent",
        modelSelection: { provider: "codex", instanceId: "codex", model: "gpt" },
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        archivedAt: null,
      },
    ],
    updatedAt: "2026-11-03T00:00:00.000Z",
  } as unknown as Parameters<
    typeof remoteHistorySessionsFromShells
  >[0]["hosts"][number]["snapshot"];

  it("keeps archived sessions and drops nested subagents", () => {
    const sessions = remoteHistorySessionsFromShells({
      hosts: [{ environmentId: "remote-1", hostName: "Studio Mac", snapshot }],
    });
    expect(sessions.map((session) => session.id)).toEqual(["remote-thread", "remote-archived"]);
    expect(sessions[1]).toMatchObject({
      hostId: "remote-1",
      archived: true,
      projectName: "Docs",
    });
  });

  it("merges message hits from every host under host-qualified keys", () => {
    const matches = messageMatchesAcrossHosts([
      {
        environmentId: "remote-1",
        matches: [{ threadId: "remote-thread", excerpt: "needle here", matchCount: 2 }],
      },
      {
        environmentId: "local",
        matches: [{ threadId: "thread-1", excerpt: "local needle", matchCount: 1 }],
      },
    ]);
    expect(matches.get("remote-1:remote-thread")?.snippet).toBe("needle here");
    expect(matches.get("local:thread-1")?.matchCount).toBe(1);
  });

  it("pages the merged list on the client", () => {
    const sessions = remoteHistorySessionsFromShells({
      hosts: [{ environmentId: "remote-1", hostName: "Studio Mac", snapshot }],
    });
    expect(paginateHistorySessions(sessions, 1)).toMatchObject({
      visible: [expect.objectContaining({ id: "remote-thread" })],
      hasMore: true,
    });
    expect(paginateHistorySessions(sessions, 2)).toMatchObject({ hasMore: false });
  });
});

describe("filterHistorySessions", () => {
  const local = localHistorySessions({
    threads: [thread()],
    projects: [project()],
    host: LOCAL_HOST,
  });
  const remote = remoteHistorySessions([remoteSession()]);
  const all = sortHistorySessions([...local, ...remote]);

  it("keeps every computer under the all-hosts filter", () => {
    expect(
      filterHistorySessions({ sessions: all, hostId: ALL_HISTORY_HOSTS_ID, query: "" }),
    ).toHaveLength(2);
  });

  it("narrows to one host", () => {
    expect(filterHistorySessions({ sessions: all, hostId: "remote-1", query: "" })).toHaveLength(1);
  });

  it("matches title, project, host, and provider text", () => {
    expect(
      filterHistorySessions({ sessions: all, hostId: ALL_HISTORY_HOSTS_ID, query: "docs" }),
    ).toHaveLength(1);
    expect(
      filterHistorySessions({ sessions: all, hostId: ALL_HISTORY_HOSTS_ID, query: "studio" }),
    ).toHaveLength(1);
    expect(
      filterHistorySessions({ sessions: all, hostId: ALL_HISTORY_HOSTS_ID, query: "login" }),
    ).toHaveLength(1);
  });

  it("keeps a row whose message body matched and carries the excerpt", () => {
    const matches = localMessageMatches({
      matches: [{ threadId: "thread-1", excerpt: "the login redirect loops", matchCount: 3 }],
      hostId: "local",
    });
    const [session] = filterHistorySessions({
      sessions: all,
      hostId: ALL_HISTORY_HOSTS_ID,
      query: "redirect",
      messageMatches: matches,
    });
    expect(session?.id).toBe("thread-1");
    expect(session?.snippet).toBe("the login redirect loops");
    expect(session?.messageMatchCount).toBe(3);
  });
});
