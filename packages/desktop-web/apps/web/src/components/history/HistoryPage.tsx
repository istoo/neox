// FILE: HistoryPage.tsx
// Purpose: One place to find every session on this computer and every connected
//   computer, search it, and import older Codex/Claude work. Connected hosts are
//   read through their own acquired channel, so their archived sessions and
//   message bodies are visible even when their workspace frame was never opened.
// Layer: History screen

import {
  ORCHESTRATION_SEARCH_THREADS_MIN_QUERY_LENGTH,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type OrchestrationSearchThreadsResult,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { RouteSurfaceHeader } from "~/components/RouteSurface";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";
import { requestImportThreadDialog } from "~/lib/historyActions";
import { readAvailableWorkspaceNavigation } from "~/lib/hosts/workspaceSessions";
import { openWorkspacePath } from "~/lib/hosts/workspaceCommands";
import { useWorkspaceSessions } from "~/lib/hosts/workspaceSessions";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";
import { getConnectionClients } from "~/lib/hosts/connectionClients";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { useProjectImportDialogStore } from "~/projectImport/projectImportDialogStore";
import { cn } from "~/lib/utils";
import { HistoryIcon, SearchIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";

import {
  ALL_HISTORY_HOSTS_ID,
  buildHistoryHosts,
  filterHistorySessions,
  localHistorySessions,
  messageMatchesAcrossHosts,
  paginateHistorySessions,
  remoteHistorySessionsFromShells,
  sortHistorySessions,
  type HistorySession,
} from "./history.logic";
import { useRemoteHistoryTargets } from "./useRemoteHistoryTargets";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 50;
const ALL_THREADS = createAllThreadsSelector();

export function HistoryPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const builtinFeatures = useBuiltinFeatures();
  const sessions = useWorkspaceSessions();
  const localThreads = useStore(ALL_THREADS);
  const projects = useStore((store) => store.projects);
  const context = readExecutionContext();
  const [hostId, setHostId] = useState(ALL_HISTORY_HOSTS_ID);
  const [searchInput, setSearchInput] = useState("");
  const [search] = useDebouncedValue(searchInput.trim(), { wait: SEARCH_DEBOUNCE_MS });
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const localHost = useMemo(
    () => ({
      id: context?.execution.environmentId ?? "local",
      name: context?.execution.label ?? t("workspace:history_thisComputer"),
    }),
    [context?.execution.environmentId, context?.execution.label, t],
  );

  // The selected execution is the store's host; other connected hosts are read
  // through their own channel.
  const remoteSessions = useMemo(
    () => sessions.filter((session) => session.host.executionScope.environmentId !== localHost.id),
    [localHost.id, sessions],
  );
  const remoteTargets = useRemoteHistoryTargets(remoteSessions);
  const remoteTargetKey = remoteTargets
    .map((target) => `${target.environmentId}:${target.hostName}`)
    .join("|");

  const shellsQuery = useQuery({
    queryKey: ["history-remote-shells", remoteTargetKey],
    queryFn: async () =>
      Promise.all(
        remoteTargets.map(async (target) => ({
          environmentId: target.environmentId,
          hostName: target.hostName,
          snapshot: await target.transport.request<OrchestrationShellSnapshot>(
            ORCHESTRATION_WS_METHODS.getShellSnapshot,
            {},
          ),
        })),
      ),
    enabled: remoteTargets.length > 0,
    staleTime: 30_000,
    retry: false,
  });

  const allSessions = useMemo(
    () =>
      sortHistorySessions([
        ...localHistorySessions({ threads: localThreads, projects, host: localHost }),
        ...remoteHistorySessionsFromShells({ hosts: shellsQuery.data ?? [] }),
      ]),
    [localHost, localThreads, projects, shellsQuery.data],
  );
  const hosts = useMemo(
    () => buildHistoryHosts({ local: localHost, sessions }),
    [localHost, sessions],
  );

  const searchHosts = useMemo(
    () => [
      {
        environmentId: localHost.id,
        transport: () => getConnectionClients().execution,
      },
      ...remoteTargets.map((target) => ({
        environmentId: target.environmentId,
        transport: () => target.transport,
      })),
    ],
    [localHost.id, remoteTargets],
  );
  const searchHostKey = searchHosts.map((host) => host.environmentId).join("|");
  const searchQuery = useQuery({
    queryKey: ["history-thread-search", search, searchHostKey],
    queryFn: async () =>
      Promise.all(
        searchHosts.map(async (host) => {
          try {
            const result = await host
              .transport()
              .request<OrchestrationSearchThreadsResult>(ORCHESTRATION_WS_METHODS.searchThreads, {
                query: search,
                limit: 50,
              });
            return { environmentId: host.environmentId, matches: result.matches };
          } catch {
            // One unavailable host must not hide the other hosts' hits.
            return { environmentId: host.environmentId, matches: [] };
          }
        }),
      ),
    enabled: search.length >= ORCHESTRATION_SEARCH_THREADS_MIN_QUERY_LENGTH,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
  const messageMatches = useMemo(
    () => messageMatchesAcrossHosts(searchQuery.data ?? []),
    [searchQuery.data],
  );
  const visibleSessions = useMemo(
    () => filterHistorySessions({ sessions: allSessions, hostId, query: search, messageMatches }),
    [allSessions, hostId, messageMatches, search],
  );
  const { visible, hasMore } = paginateHistorySessions(visibleSessions, visibleCount);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, hostId]);

  if (!builtinFeatures.isEnabled("sessions")) {
    return <Navigate to="/" replace />;
  }

  const openSession = (session: HistorySession) => {
    if (session.isLocal) {
      void navigate({ to: "/$threadId", params: { threadId: ThreadId.makeUnsafe(session.id) } });
      return;
    }
    const workspace = sessions.find(
      (entry) => entry.host.executionScope.environmentId === session.hostId,
    );
    const navigation = workspace ? readAvailableWorkspaceNavigation(workspace) : undefined;
    if (!workspace || !navigation) return;
    openWorkspacePath(workspace, `/${session.id}`);
  };

  return (
    <RouteInsetSurface>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--app-background)]">
        <RouteSurfaceHeader className="shrink-0" rowClassName="gap-2">
          <h1 className="truncate text-ui-lg font-medium text-foreground">
            {t("workspace:history")}
          </h1>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => requestImportThreadDialog()}
            >
              {t("workspace:history_importThread")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              onClick={() => useProjectImportDialogStore.getState().openDialog()}
            >
              {t("workspace:history_importProjects")}
            </Button>
          </div>
        </RouteSurfaceHeader>

        <div className="mx-auto flex w-full max-w-4xl min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("workspace:history_searchPlaceholder")}
              aria-label={t("workspace:history_searchPlaceholder")}
              className="pl-9"
            />
          </div>

          {hosts.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <HostChip
                active={hostId === ALL_HISTORY_HOSTS_ID}
                label={t("workspace:history_allComputers")}
                onClick={() => setHostId(ALL_HISTORY_HOSTS_ID)}
              />
              {hosts.map((host) => (
                <HostChip
                  key={host.id}
                  active={hostId === host.id}
                  label={host.name}
                  onClick={() => setHostId(host.id)}
                />
              ))}
            </div>
          ) : null}

          {visibleSessions.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
              <HistoryIcon className="size-6 text-muted-foreground/60" />
              <p className="text-ui text-muted-foreground">
                {search.length > 0
                  ? t("workspace:history_noMatches")
                  : t("workspace:history_empty")}
              </p>
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {visible.map((session) => (
                  <li key={`${session.hostId}:${session.id}`}>
                    <button
                      type="button"
                      onClick={() => openSession(session)}
                      className="flex w-full cursor-pointer flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-ui font-medium text-foreground">
                          {session.title}
                        </span>
                        {session.archived ? (
                          <span className="shrink-0 rounded-full bg-foreground/8 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
                            {t("workspace:history_archived")}
                          </span>
                        ) : null}
                        {session.messageMatchCount > 1 ? (
                          <span className="shrink-0 text-ui-xs text-muted-foreground">
                            {t("workspace:history_messageMatches", {
                              value0: session.messageMatchCount,
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground">
                        <span className="truncate">{session.projectName}</span>
                        <span aria-hidden>·</span>
                        <span className="truncate">{session.hostName}</span>
                        <span aria-hidden>·</span>
                        <span className="shrink-0">
                          {PROVIDER_DISPLAY_NAMES[session.provider] ?? session.provider}
                        </span>
                        <span aria-hidden>·</span>
                        <time className="shrink-0" dateTime={session.updatedAt}>
                          {new Date(session.updatedAt).toLocaleDateString()}
                        </time>
                      </span>
                      {session.snippet ? (
                        <span className="line-clamp-2 text-ui-xs text-muted-foreground/79">
                          {session.snippet}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-center rounded-full"
                  onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                >
                  {t("workspace:history_showMore")}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </RouteInsetSurface>
  );
}

function HostChip(props: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "cursor-pointer rounded-full px-3 py-1 text-ui-sm transition-colors",
        props.active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}
