import type {
  ExternalCodexMove,
  ExternalSession,
  ExternalSessionAgent,
  ExternalSessionTrashed,
} from "@neolix/protocol/messages";
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
} from "lucide-react-native";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { SettingsCard, SettingsRow } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import { useProviderIcon } from "@/components/provider-icons";
import { i18n as appI18n } from "@/i18n/i18next";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { formatAgo } from "@/usage/format";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatFileSize } from "@/utils/format-file-size";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { ProviderBar, ProviderMoveForm, RelocateForm } from "./session-admin";
import { ConversationPanel, SubagentsFold } from "./session-conversation";
import {
  compactNumber,
  costText,
  filterSessions,
  GATEWAY_GROUP,
  groupSessions,
  hiddenProviderSessions,
  modelsText,
  type SessionGroup,
  type SessionsT,
} from "./sessions-view";

const PAGE_SIZE = 100;

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedTrash = withUnistyles(Trash2);
const ThemedPlay = withUnistyles(Play);
const ThemedUndo = withUnistyles(RotateCcw);
const ThemedCheck = withUnistyles(Check);
const ThemedSquare = withUnistyles(Square);
const ThemedCopy = withUnistyles(Copy);
const ThemedTerminal = withUnistyles(SquareTerminal);

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIcon = (theme: Theme) => ({ color: theme.colors.foreground });
const dangerIcon = (theme: Theme) => ({ color: theme.colors.destructive });

function useSessionsT(): SessionsT {
  const { t } = useTranslation();
  return useCallback(
    (key: string, options?: Record<string, unknown>) =>
      options === undefined
        ? t(`settings.usePages.sessions.${key}`)
        : t(`settings.usePages.sessions.${key}`, options),
    [t],
  );
}

function sessionsCountLabel(t: SessionsT, count: number): string {
  return count === 1 ? t("oneSession") : t("sessionsCount", { count });
}

function messagesCountLabel(t: SessionsT, count: number): string {
  return count === 1 ? t("oneMessage") : t("messagesCount", { count });
}

function groupLabel(t: SessionsT, group: SessionGroup): string {
  if (group.key === GATEWAY_GROUP) {
    return t("gatewayGroup");
  }
  if (group.key.length === 0) {
    return t("noFolder");
  }
  return group.name;
}

export function HostSessionsPage({ serverId }: { serverId: string }) {
  const t = useSessionsT();
  const { i18n } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "externalSessions");
  const [agent, setAgent] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [trashOn, setTrashOn] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [othersOpen, setOthersOpen] = useState(false);
  const [limits, setLimits] = useState<Readonly<Record<string, number>>>({});
  const [busy, setBusy] = useState(false);
  const [lastMove, setLastMove] = useState<readonly ExternalCodexMove[] | null>(null);
  const [providerMove, setProviderMove] = useState<readonly ExternalSession[] | null>(null);
  const [relocateFrom, setRelocateFrom] = useState<string | null>(null);

  const listQuery = useFetchQuery({
    queryKey: ["external-sessions", serverId, agent],
    enabled: supported && client !== null,
    dataShape: "value" as const,
    staleTimeMs: 15_000,
    refetchInterval: 15_000,
    queryFn: () => {
      if (client === null) {
        throw new Error(t("loadFailed", { error: t("hostDisconnected") }));
      }
      return client.listExternalSessions(agent ?? undefined);
    },
  });
  const data = listQuery.data;
  const activeAgent = data?.agent ?? null;

  const needle = deferredQuery.trim();
  const searchQuery = useFetchQuery({
    queryKey: ["external-sessions-search", serverId, activeAgent, needle],
    enabled: supported && client !== null && activeAgent !== null && needle.length >= 2 && !trashOn,
    dataShape: "value" as const,
    staleTimeMs: 30_000,
    queryFn: () => {
      if (client === null || activeAgent === null) {
        throw new Error(t("searchFailed", { error: t("hostDisconnected") }));
      }
      return client.searchExternalSessions(activeAgent, needle);
    },
  });
  const hits = useMemo(() => {
    const found = new Map<string, NonNullable<typeof searchQuery.data>["hits"][number]>();
    for (const hit of searchQuery.data?.hits ?? []) {
      found.set(hit.id, hit);
    }
    return found;
  }, [searchQuery.data]);

  const groups = useMemo(() => {
    if (data === undefined) {
      return { projects: [] as SessionGroup[], others: [] as SessionGroup[] };
    }
    return groupSessions(filterSessions(data.sessions, query, hits), data.home);
  }, [data, hits, query]);

  const currentAgent = data?.agents.find((entry) => entry.agent === data.agent);
  const hiddenProviders = useMemo(
    () => (data?.agent === "codex" ? hiddenProviderSessions(data.sessions) : []),
    [data],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["external-sessions", serverId] });
    void queryClient.invalidateQueries({ queryKey: ["external-sessions-search", serverId] });
  }, [queryClient, serverId]);

  const chooseAgent = useCallback((name: string) => {
    setAgent(name);
    setOpen(new Set());
    setOthersOpen(false);
    setLimits({});
    setPicked(new Set());
    setSelecting(false);
    setTrashOn(false);
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const togglePicked = useCallback((id: string) => {
    setPicked((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const setPickedMany = useCallback((ids: readonly string[], on: boolean) => {
    setPicked((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (on) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }, []);

  const showMore = useCallback((key: string, shown: number) => {
    setLimits((previous) => ({ ...previous, [key]: shown + PAGE_SIZE }));
  }, []);

  const toggleTrash = useCallback(() => {
    setTrashOn((previous) => !previous);
    setSelecting(false);
    setPicked(new Set());
  }, []);

  const toggleSelect = useCallback(() => {
    setSelecting((previous) => {
      if (previous) {
        setPicked(new Set());
      }
      return !previous;
    });
  }, []);

  const deleteSessions = useCallback(
    async (sessions: readonly ExternalSession[]) => {
      if (client === null || sessions.length === 0) {
        return;
      }
      const message = deleteMessageOf(t, sessions, data?.trashDir ?? "");
      const confirmed = await confirmDialog({
        title:
          sessions.length === 1
            ? t("deleteTitleOne")
            : t("deleteTitleMany", { count: sessions.length }),
        message,
        confirmLabel: t("delete"),
        cancelLabel: t("cancel"),
        destructive: true,
      });
      const targetAgent = data?.agent ?? "";
      if (!confirmed || targetAgent.length === 0) {
        return;
      }
      setBusy(true);
      try {
        const result = await client.deleteExternalSessions(
          targetAgent,
          sessions.map((session) => session.id),
        );
        if (result.error !== null) {
          toast.error(result.error);
        } else {
          const first = result.refused[0];
          if (first !== undefined) {
            toast.error(first.error);
          } else {
            toast.show(
              <Text style={styles.toastText}>
                {result.deleted.length === 1
                  ? t("deletedOne")
                  : t("deletedMany", { count: result.deleted.length })}
              </Text>,
            );
          }
          setPicked(new Set());
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, data?.agent, data?.trashDir, refresh, t, toast],
  );

  const restoreSession = useCallback(
    async (entry: ExternalSessionTrashed) => {
      if (client === null) {
        return;
      }
      setBusy(true);
      try {
        const result = await client.restoreExternalSession(entry.key);
        if (result.error !== null) {
          toast.error(result.error);
        } else {
          toast.show(
            <Text style={styles.toastText}>{t("restored", { title: result.title })}</Text>,
          );
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, refresh, t, toast],
  );

  const purgeSessions = useCallback(
    async (entries: readonly ExternalSessionTrashed[], all: boolean) => {
      if (client === null || (!all && entries.length === 0)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: purgeTitle(t, all, entries.length),
        message: all === true ? t("purgeMessageAll") : t("purgeMessage"),
        confirmLabel: all === true ? t("emptyTrash") : t("deleteForever"),
        cancelLabel: t("cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setBusy(true);
      try {
        const result = all
          ? await client.purgeExternalSessions({ all: true })
          : await client.purgeExternalSessions({ keys: entries.map((entry) => entry.key) });
        if (result.error !== null) {
          toast.error(result.error);
        } else {
          const first = result.refused[0];
          if (first !== undefined) {
            toast.error(first.error);
          } else {
            toast.show(
              <Text style={styles.toastText}>
                {result.purged.length === 1
                  ? t("purgedOne")
                  : t("purgedMany", { count: result.purged.length })}
              </Text>,
            );
          }
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, refresh, t, toast],
  );

  const resumeSession = useCallback(
    async (session: ExternalSession) => {
      if (client === null) {
        return;
      }
      setBusy(true);
      try {
        const imported = await client.importAgent({
          providerId: session.agent,
          providerHandleId: session.id,
          ...(session.cwd.length > 0 ? { cwd: session.cwd } : {}),
        });
        navigateToAgent({ serverId, agentId: imported.id });
      } catch (error) {
        toast.error(
          t("resumeFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        setBusy(false);
      }
    },
    [client, serverId, t, toast],
  );

  const setRecording = useCallback(
    async (on: boolean) => {
      if (client === null) {
        return;
      }
      if (on) {
        const confirmed = await confirmDialog({
          title: t("recordingTitle"),
          message: t("recordingEnableMessage"),
          confirmLabel: t("enable"),
          cancelLabel: t("cancel"),
        });
        if (!confirmed) {
          return;
        }
      }
      setBusy(true);
      try {
        const result = await client.setGatewayConversationRecording({ on });
        if (result.error !== null) {
          toast.error(result.error);
        } else {
          toast.show(
            <Text style={styles.toastText}>
              {result.recording ? t("recordingOnToast") : t("recordingOffToast")}
            </Text>,
          );
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, refresh, t, toast],
  );

  const clearRecordings = useCallback(async () => {
    if (client === null) {
      return;
    }
    const confirmed = await confirmDialog({
      title: t("deleteSavedConfirmTitle"),
      message: t("deleteSavedConfirmMessage"),
      confirmLabel: t("delete"),
      cancelLabel: t("cancel"),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    try {
      const result = await client.setGatewayConversationRecording({ clear: true });
      if (result.error !== null) {
        toast.error(result.error);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }, [client, refresh, t, toast]);

  const moveProviders = useCallback(
    async (moves: readonly { id: string; to: string }[], to: string) => {
      if (client === null || moves.length === 0) {
        return;
      }
      setBusy(true);
      try {
        const result = await client.moveExternalCodexProvider([...moves]);
        if (result.error !== null) {
          toast.error(result.error);
        } else if (result.refused.length > 0) {
          const active = result.refused.filter((entry) => entry.active);
          toast.error(
            active.length > 0
              ? t("providerStillWriting", { count: active.length })
              : (result.refused[0]?.error ?? ""),
          );
        }
        if (result.moved.length > 0) {
          setLastMove(result.moved);
          toast.show(
            result.moved.length === 1
              ? t("providerMovedOneToast", { to })
              : t("providerMovedManyToast", { count: result.moved.length, to }),
          );
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [client, refresh, t, toast],
  );

  const askProviderMove = useCallback((hidden: readonly ExternalSession[]) => {
    if (hidden.length > 0) {
      setProviderMove(hidden);
    }
  }, []);

  const moveChosen = useCallback(
    (ids: readonly string[]) => {
      const to = hiddenProviders[0]?.usesProvider ?? "";
      setProviderMove(null);
      void moveProviders(
        ids.map((id) => ({ id, to })),
        to,
      );
    },
    [hiddenProviders, moveProviders],
  );

  const closeProviderMove = useCallback(() => setProviderMove(null), []);

  const undoMove = useCallback(async () => {
    if (lastMove === null) {
      return;
    }
    await moveProviders(
      lastMove.map((move) => ({ id: move.id, to: move.from })),
      lastMove[0]?.from ?? "",
    );
    setLastMove(null);
  }, [lastMove, moveProviders]);

  const moveHidden = useCallback(() => {
    askProviderMove(hiddenProviders);
  }, [askProviderMove, hiddenProviders]);
  const undoLast = useCallback(() => {
    void undoMove();
  }, [undoMove]);
  const relocateProject = useCallback((from: string) => setRelocateFrom(from), []);
  const closeRelocate = useCallback(() => setRelocateFrom(null), []);
  const doneRelocate = useCallback(() => {
    setRelocateFrom(null);
    refresh();
  }, [refresh]);

  const selectedSessions = (data?.sessions ?? []).filter((session) => picked.has(session.id));
  const toggleOthers = useCallback(() => setOthersOpen((previous) => !previous), []);
  const deleteSelected = useCallback(() => {
    void deleteSessions(selectedSessions);
  }, [deleteSessions, selectedSessions]);

  if (!supported) {
    return <Alert description={t("hostNeedsUpdate")} variant="warning" />;
  }

  if (loadFailed(listQuery, data)) {
    const message = errorMessageOf(listQuery.error);
    return (
      <View style={styles.centered}>
        <Alert description={t("loadFailed", { error: message })} variant="error" />
        <Button variant="secondary" onPress={refresh}>
          {t("retry")}
        </Button>
      </View>
    );
  }

  if (data === undefined) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
        <Text style={styles.mutedText}>{t("loading")}</Text>
      </View>
    );
  }

  const searchNote = searchNoteOf(t, searchQuery, needle);

  return (
    <View style={styles.page} testID="host-sessions-page">
      <SessionsToolbar
        data={data}
        currentAgent={currentAgent}
        serverId={serverId}
        trashOn={trashOn}
        query={query}
        selecting={selecting}
        onChooseAgent={chooseAgent}
        onQueryChange={setQuery}
        onToggleSelect={toggleSelect}
        onToggleTrash={toggleTrash}
        t={t}
      />

      <RecordingSection
        recording={data.recording}
        recorded={data.recorded}
        hasGatewaySessions={data.sessions.some((session) => session.gateway === true)}
        disabled={busy}
        onToggle={setRecording}
        onClear={clearRecordings}
        t={t}
      />

      <ProviderBar
        hidden={hiddenProviders}
        moved={lastMove}
        disabled={busy}
        onMove={moveHidden}
        onUndo={undoLast}
        t={t}
      />

      <AdminPanels
        serverId={serverId}
        providerMove={providerMove}
        relocateFrom={relocateFrom}
        busy={busy}
        onMoveChosen={moveChosen}
        onCloseProviderMove={closeProviderMove}
        onRelocateDone={doneRelocate}
        onCloseRelocate={closeRelocate}
        t={t}
      />

      {trashOn ? (
        <TrashView
          entries={data.trash}
          trashDir={data.trashDir}
          disabled={busy}
          onRestore={restoreSession}
          onPurge={purgeSessions}
          t={t}
        />
      ) : (
        <SessionsList
          serverId={serverId}
          groups={groups}
          query={query}
          hits={hits}
          searchNote={searchNote}
          selecting={selecting}
          picked={picked}
          deleted={busy}
          open={open}
          othersOpen={othersOpen}
          limits={limits}
          currentAgent={currentAgent}
          locale={languageOf(i18n.resolvedLanguage)}
          onToggleGroup={toggleGroup}
          onToggleOthers={toggleOthers}
          onTogglePicked={togglePicked}
          onPickMany={setPickedMany}
          onShowMore={showMore}
          onDelete={deleteSessions}
          onDeleteSelected={deleteSelected}
          onResume={resumeSession}
          onRelocate={relocateProject}
          t={t}
        />
      )}
    </View>
  );
}

function AdminPanels({
  serverId,
  providerMove,
  relocateFrom,
  busy,
  onMoveChosen,
  onCloseProviderMove,
  onRelocateDone,
  onCloseRelocate,
  t,
}: {
  serverId: string;
  providerMove: readonly ExternalSession[] | null;
  relocateFrom: string | null;
  busy: boolean;
  onMoveChosen: (ids: readonly string[]) => void;
  onCloseProviderMove: () => void;
  onRelocateDone: () => void;
  onCloseRelocate: () => void;
  t: SessionsT;
}) {
  return (
    <>
      {providerMove !== null ? (
        <ProviderMoveForm
          sessions={providerMove}
          to={providerMove[0]?.usesProvider ?? ""}
          disabled={busy}
          onMove={onMoveChosen}
          onClose={onCloseProviderMove}
          t={t}
        />
      ) : null}
      {relocateFrom !== null ? (
        <RelocateForm
          serverId={serverId}
          from={relocateFrom}
          onDone={onRelocateDone}
          onClose={onCloseRelocate}
          t={t}
        />
      ) : null}
    </>
  );
}

function deleteMessageOf(t: SessionsT, sessions: readonly ExternalSession[], dir: string): string {
  if (sessions.every((session) => session.gateway === true)) {
    return t("deleteGatewayMessage", { dir });
  }
  return t("deleteMessage", { dir });
}

function searchNoteOf(
  t: SessionsT,
  query: {
    isFetching: boolean;
    isError: boolean;
    error: Error | null;
    data?: { cut: boolean; searched: number; total: number };
  },
  needle: string,
): string | null {
  if (needle.length < 2) {
    return null;
  }
  if (query.isFetching) {
    return t("searching");
  }
  if (query.isError) {
    const reason = query.error instanceof Error ? query.error.message : String(query.error);
    return t("searchFailed", { error: reason });
  }
  if (query.data?.cut === true) {
    return t("searchCut", { n: query.data.searched, total: query.data.total });
  }
  return null;
}

function loadFailed(query: { isError: boolean }, data: unknown): boolean {
  return data === undefined && query.isError;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function languageOf(language: string | undefined): string {
  return language ?? "en";
}

function purgeTitle(t: SessionsT, all: boolean, count: number): string {
  if (all === true) {
    return t("purgeTitleAll");
  }
  return count === 1 ? t("purgeTitleOne") : t("purgeTitleAll");
}

interface SessionsToolbarProps {
  data: {
    agents: ExternalSessionAgent[];
    sessions: readonly ExternalSession[];
    trash: readonly ExternalSessionTrashed[];
    agent: string;
  };
  currentAgent: ExternalSessionAgent | undefined;
  serverId: string;
  trashOn: boolean;
  query: string;
  selecting: boolean;
  onChooseAgent: (agent: string) => void;
  onQueryChange: (query: string) => void;
  onToggleSelect: () => void;
  onToggleTrash: () => void;
  t: SessionsT;
}

function SessionsToolbar(props: SessionsToolbarProps) {
  const { t, data, trashOn, selecting } = props;
  const canSelect = !trashOn && data.sessions.length > 0;
  return (
    <View style={styles.toolbar}>
      <AgentPicker
        agents={data.agents}
        current={props.currentAgent}
        serverId={props.serverId}
        onChoose={props.onChooseAgent}
      />
      {trashOn ? null : (
        <SearchField
          value={props.query}
          onChangeText={props.onQueryChange}
          placeholder={t("searchPlaceholder")}
          clearAccessibilityLabel={t("clearSearch")}
          testID="sessions-external-search"
        />
      )}
      <View style={styles.toolbarButtons}>
        {canSelect ? (
          <Button variant="ghost" onPress={props.onToggleSelect}>
            {selecting ? t("done") : t("select")}
          </Button>
        ) : null}
        <Button variant="ghost" onPress={props.onToggleTrash}>
          {t("trash")}
          {data.trash.length > 0 ? ` ${data.trash.length}` : ""}
        </Button>
      </View>
    </View>
  );
}

interface AgentPickerProps {
  agents: ExternalSessionAgent[];
  current: ExternalSessionAgent | undefined;
  serverId: string;
  onChoose: (agent: string) => void;
}

function AgentPicker({ agents, current, serverId, onChoose }: AgentPickerProps) {
  const t = useSessionsT();
  const Icon = useProviderIcon(current?.agent ?? "claude", serverId);
  const leading = useMemo(() => <Icon size={16} color={styles.agentIcon.color} />, [Icon]);
  const label = current === undefined ? t("agent") : `${current.name} (${current.count})`;
  return (
    <DropdownMenu>
      <DropdownTrigger
        leading={leading}
        accessibilityLabel={t("agent")}
        disabled={agents.length < 2}
      >
        {label}
      </DropdownTrigger>
      <DropdownMenuContent side="bottom" align="start" width={240}>
        {agents.map((agent) => (
          <AgentOption
            key={agent.agent}
            item={agent}
            selected={agent.agent === current?.agent}
            serverId={serverId}
            onChoose={onChoose}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentOption({
  item,
  selected,
  serverId,
  onChoose,
}: {
  item: ExternalSessionAgent;
  selected: boolean;
  serverId: string;
  onChoose: (agent: string) => void;
}) {
  const Icon = useProviderIcon(item.agent, serverId);
  const select = useCallback(() => onChoose(item.agent), [item.agent, onChoose]);
  const leading = useMemo(() => <Icon size={16} color={styles.agentIcon.color} />, [Icon]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select} leading={leading}>
      {`${item.name} (${item.count})`}
    </DropdownMenuItem>
  );
}

function RecordingSection({
  recording,
  recorded,
  hasGatewaySessions,
  disabled,
  onToggle,
  onClear,
  t,
}: {
  recording: boolean;
  recorded: boolean;
  hasGatewaySessions: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onClear: () => void;
  t: SessionsT;
}) {
  const show = recording || recorded || hasGatewaySessions;
  if (!show) {
    return null;
  }
  return (
    <RecordingCard
      recording={recording}
      recorded={recorded}
      disabled={disabled}
      onToggle={onToggle}
      onClear={onClear}
      t={t}
    />
  );
}

function RecordingCard({
  recording,
  recorded,
  disabled,
  onToggle,
  onClear,
  t,
}: {
  recording: boolean;
  recorded: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onClear: () => void;
  t: SessionsT;
}) {
  return (
    <SettingsCard>
      <SettingsRow
        label={t("recordingTitle")}
        hint={recording ? t("recordingOn") : t("recordingOff")}
      >
        <Switch
          value={recording}
          onValueChange={onToggle}
          disabled={disabled}
          accessibilityLabel={t("recordingTitle")}
        />
      </SettingsRow>
      {recorded ? (
        <SettingsRow label={t("deleteSaved")}>
          <Button variant="ghost" leftIcon={ThemedTrash} disabled={disabled} onPress={onClear}>
            {t("delete")}
          </Button>
        </SettingsRow>
      ) : null}
    </SettingsCard>
  );
}

interface SessionsListProps {
  serverId: string;
  groups: { projects: SessionGroup[]; others: SessionGroup[] };
  query: string;
  hits: ReadonlyMap<string, { before: string; match: string; after: string }>;
  searchNote: string | null;
  selecting: boolean;
  picked: ReadonlySet<string>;
  deleted: boolean;
  open: ReadonlySet<string>;
  othersOpen: boolean;
  limits: Readonly<Record<string, number>>;
  currentAgent: ExternalSessionAgent | undefined;
  locale: string;
  onToggleGroup: (key: string) => void;
  onToggleOthers: () => void;
  onTogglePicked: (id: string) => void;
  onPickMany: (ids: readonly string[], on: boolean) => void;
  onShowMore: (key: string, shown: number) => void;
  onDelete: (sessions: readonly ExternalSession[]) => void;
  onDeleteSelected: () => void;
  onResume: (session: ExternalSession) => void;
  onRelocate: (from: string) => void;
  t: SessionsT;
}

function SessionsList(props: SessionsListProps) {
  const { t, groups, query } = props;
  const all = [...groups.projects, ...groups.others].flatMap((group) => group.sessions);
  const gatewayCount = all.filter((session) => session.gateway === true).length;
  const readOnly = all.some((session) => !session.deletable);
  const agentName = props.currentAgent?.name ?? "";
  if (groups.projects.length === 0 && groups.others.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>
          {query.trim().length > 0 ? t("noMatch") : t("emptyTitle")}
        </Text>
        {query.trim().length > 0 ? null : <Text style={styles.mutedText}>{t("emptyHint")}</Text>}
      </View>
    );
  }
  return (
    <View style={styles.list}>
      {props.selecting ? (
        <SelectionBar
          sessions={all}
          picked={props.picked}
          onPickMany={props.onPickMany}
          onDelete={props.onDeleteSelected}
          t={t}
        />
      ) : null}
      {gatewayCount > 0 ? (
        <Text style={styles.note}>
          {gatewayCount === all.length
            ? t("notesGatewayOnly", { agent: agentName })
            : t("notesGatewaySome", { agent: agentName })}
        </Text>
      ) : null}
      {readOnly ? (
        <Text style={styles.note}>{t("notesReadOnly", { agent: agentName })}</Text>
      ) : null}
      {props.searchNote !== null ? (
        <Text style={styles.note} accessibilityLiveRegion="polite">
          {props.searchNote}
        </Text>
      ) : null}
      {groups.projects.map((group, index) => (
        <GroupSection
          key={group.key}
          {...props}
          group={group}
          expanded={props.open.has(group.key) || (props.open.size === 0 && index === 0)}
        />
      ))}
      {groups.others.length > 0 ? <OthersSection {...props} /> : null}
    </View>
  );
}

function SelectionBar({
  sessions,
  picked,
  onPickMany,
  onDelete,
  t,
}: {
  sessions: readonly ExternalSession[];
  picked: ReadonlySet<string>;
  onPickMany: (ids: readonly string[], on: boolean) => void;
  onDelete: () => void;
  t: SessionsT;
}) {
  const writable = sessions.filter((session) => session.deletable);
  const allPicked = writable.length > 0 && writable.every((session) => picked.has(session.id));
  const somePicked = writable.some((session) => picked.has(session.id));
  const toggleAll = useCallback(() => {
    onPickMany(
      writable.map((session) => session.id),
      !allPicked,
    );
  }, [allPicked, onPickMany, writable]);
  const count =
    picked.size > 0
      ? t("selectedCount", { count: picked.size })
      : sessionsCountLabel(t, writable.length);
  return (
    <View style={styles.selectionBar}>
      <PickBox
        checked={allPicked}
        partial={!allPicked && somePicked}
        onPress={toggleAll}
        label={t("selectEverySession")}
      />
      <Text style={styles.groupCount}>{count}</Text>
      <View style={styles.grow} />
      <Button variant="destructive" onPress={onDelete} disabled={picked.size === 0}>
        {t("delete")}
      </Button>
    </View>
  );
}

function OthersSection(props: SessionsListProps) {
  const { t, groups, othersOpen, open } = props;
  const count = groups.others.length;
  return (
    <View style={styles.others}>
      <PressHighlight onPress={props.onToggleOthers} style={styles.groupRow}>
        <View style={styles.chevron}>
          {othersOpen ? (
            <ThemedChevronDown size={14} uniProps={mutedIcon} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedIcon} />
          )}
        </View>
        <View style={styles.groupMain}>
          <Text style={styles.groupName}>{t("otherFolders")}</Text>
          <Text style={styles.groupLatest} numberOfLines={1}>
            {t("otherFoldersHint")}
          </Text>
        </View>
        <Text style={styles.groupCount}>
          {count === 1 ? t("oneFolder") : t("foldersCount", { count })}
        </Text>
      </PressHighlight>
      {othersOpen
        ? groups.others.map((group) => (
            <GroupSection key={group.key} group={group} expanded={open.has(group.key)} {...props} />
          ))
        : null}
    </View>
  );
}

interface GroupSectionProps extends SessionsListProps {
  group: SessionGroup;
  expanded: boolean;
}

function GroupSection(props: GroupSectionProps) {
  const { t, group, expanded, locale, limits, picked, selecting } = props;
  const limit = limits[group.key] ?? PAGE_SIZE;
  const shown = group.sessions.slice(0, limit);
  const writable = group.sessions.filter((session) => session.deletable);
  const allPicked = writable.length > 0 && writable.every((session) => picked.has(session.id));
  const somePicked = writable.some((session) => picked.has(session.id));
  const pickFolder = useCallback(() => {
    props.onPickMany(
      writable.map((session) => session.id),
      !allPicked,
    );
  }, [allPicked, props, writable]);
  const fold = useCallback(() => props.onToggleGroup(group.key), [group.key, props]);
  const relocate = useCallback(() => props.onRelocate(group.key), [group.key, props]);
  const canRelocate =
    props.currentAgent?.agent === "claude" &&
    group.key.length > 0 &&
    group.key !== GATEWAY_GROUP &&
    group.sessions.every((session) => session.wsl === undefined);
  const latestAgo = formatAgo(group.latest.last, Date.now(), appI18n.t) ?? "";
  return (
    <View style={styles.group}>
      <View style={styles.groupRow}>
        {selecting && writable.length > 0 ? (
          <PickBox
            checked={allPicked}
            partial={!allPicked && somePicked}
            onPress={pickFolder}
            label={t("selectEverySessionInFolder", { folder: groupLabel(t, group) })}
          />
        ) : null}
        <PressHighlight onPress={fold} style={styles.groupFold} accessibilityRole="button">
          <View style={styles.chevron}>
            {expanded ? (
              <ThemedChevronDown size={14} uniProps={mutedIcon} />
            ) : (
              <ThemedChevronRight size={14} uniProps={mutedIcon} />
            )}
          </View>
          <View style={styles.groupMain}>
            <View style={styles.groupTitleLine}>
              <Text style={styles.groupName} numberOfLines={1}>
                {groupLabel(t, group)}
              </Text>
              {group.where.length > 0 ? (
                <Text style={styles.groupWhere} numberOfLines={1}>
                  {group.where}
                </Text>
              ) : null}
            </View>
            <Text style={styles.groupLatest} numberOfLines={1}>
              {group.latest.title.length > 0 ? group.latest.title : t("noPrompt")}
            </Text>
          </View>
        </PressHighlight>
        <View style={styles.groupMeta}>
          <Text style={styles.groupWhen}>{latestAgo}</Text>
          <Text style={styles.groupCount}>{sessionsCountLabel(t, group.sessions.length)}</Text>
        </View>
        {canRelocate ? (
          <PressHighlight
            onPress={relocate}
            accessibilityRole="button"
            style={styles.rowIconButton}
          >
            <Text style={styles.groupAction}>{t("relocateProject")}</Text>
          </PressHighlight>
        ) : null}
      </View>
      {expanded
        ? shown.map((session) => (
            <SessionRow
              key={session.id}
              serverId={props.serverId}
              session={session}
              hit={props.hits.get(session.id)}
              selected={picked.has(session.id)}
              selecting={selecting}
              disabled={props.deleted}
              locale={locale}
              onTogglePicked={props.onTogglePicked}
              onDelete={props.onDelete}
              onResume={props.onResume}
              t={t}
            />
          ))
        : null}
      {expanded && limit < group.sessions.length ? (
        <ShowMore
          remaining={group.sessions.length - limit}
          onPress={props.onShowMore}
          groupKey={group.key}
          shown={limit}
          t={t}
        />
      ) : null}
    </View>
  );
}

function ShowMore({
  remaining,
  onPress,
  groupKey,
  shown,
  t,
}: {
  remaining: number;
  onPress: (key: string, shown: number) => void;
  groupKey: string;
  shown: number;
  t: SessionsT;
}) {
  const press = useCallback(() => onPress(groupKey, shown), [groupKey, onPress, shown]);
  return (
    <Button variant="ghost" onPress={press}>
      {t("showMore", { count: Math.min(PAGE_SIZE, remaining) })}
    </Button>
  );
}

function PickBox({
  checked,
  partial,
  onPress,
  label,
}: {
  checked: boolean;
  partial: boolean;
  onPress: () => void;
  label: string;
}) {
  const state = useMemo(() => ({ checked }), [checked]);
  return (
    <PressHighlight
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="checkbox"
      accessibilityState={state}
      accessibilityLabel={label}
      style={styles.pickBox}
    >
      {checked ? (
        <ThemedCheck size={16} uniProps={foregroundIcon} />
      ) : (
        <ThemedSquare size={16} uniProps={mutedIcon} />
      )}
      {partial && !checked ? <View style={styles.partialDot} /> : null}
    </PressHighlight>
  );
}

interface SessionRowProps {
  serverId: string;
  session: ExternalSession;
  hit: { before: string; match: string; after: string } | undefined;
  selected: boolean;
  selecting: boolean;
  disabled: boolean;
  locale: string;
  onTogglePicked: (id: string) => void;
  onDelete: (sessions: readonly ExternalSession[]) => void;
  onResume: (session: ExternalSession) => void;
  t: SessionsT;
}

/**
 * myna's terminal button (plugins/sessions/client.js:1007): the session's own
 * resume line, which the host builds from its session list, opens in the
 * chosen Mac terminal. Only a host that advertises the terminal RPC has one.
 */
function useTerminalAction(serverId: string, session: ExternalSession, t: SessionsT) {
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "sessionTerminal");
  // The feature says the host has the RPC; only macOS hosts report a
  // supported list, and myna shows the button only there (settings.js:9).
  // One query key per host, so every row shares the one call.
  const terminals = useFetchQuery({
    queryKey: ["session-terminals", serverId],
    enabled: supported && client !== null,
    dataShape: "value" as const,
    staleTimeMs: 60_000,
    queryFn: () => {
      if (client === null) {
        throw new Error(t("hostDisconnected"));
      }
      return client.listSessionTerminals();
    },
  });
  const available =
    supported &&
    client !== null &&
    terminals.data?.supported === true &&
    terminals.data.error === null &&
    session.resume.length > 0 &&
    session.cwd.startsWith("/");
  const openInTerminal = useCallback(() => {
    if (!available || client === null) {
      return;
    }
    void client.openSessionInTerminal({ agent: session.agent, id: session.id }).then(
      (result) => {
        if (result.error !== null) {
          toast.error(t("openTerminalFailed", { error: result.error }));
          return undefined;
        }
        toast.show(t("openingInTerminal"), { variant: "success" });
        return undefined;
      },
      (error: unknown) =>
        toast.error(
          t("openTerminalFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
    );
  }, [available, client, session.agent, session.id, t, toast]);
  return { available, openInTerminal };
}

function SessionRow({
  serverId,
  session,
  hit,
  selected,
  selecting,
  disabled,
  locale,
  onTogglePicked,
  onDelete,
  onResume,
  t,
}: SessionRowProps) {
  const toast = useToast();
  const [talkOpen, setTalkOpen] = useState(false);
  const toggle = useCallback(() => onTogglePicked(session.id), [onTogglePicked, session.id]);
  const remove = useCallback(() => onDelete([session]), [onDelete, session]);
  const resume = useCallback(() => onResume(session), [onResume, session]);
  const copyCommand = useCallback(() => {
    void copyToClipboard(session.resume).then(() => toast.copied(t("copyCommand")));
  }, [session.resume, t, toast]);
  const terminal = useTerminalAction(serverId, session, t);
  const toggleTalk = useCallback(() => setTalkOpen((previous) => !previous), []);
  const talkState = useMemo(() => ({ expanded: talkOpen }), [talkOpen]);
  const ago = formatAgo(session.last, Date.now(), appI18n.t) ?? "";
  const sizeText = sizeLabel(session, t);
  const sub = [
    ago,
    session.wsl === undefined ? "" : t("wslDistro", { distro: session.wsl }),
    modelsText(session),
    session.messages > 0 ? messagesCountLabel(t, session.messages) : "",
    sizeText,
    session.title === session.id ? "" : session.id.slice(0, 8),
  ]
    .filter(Boolean)
    .join(" · ");
  const tokens = tokensLine(session, locale, t);
  const cost = session.priced ? t("costApprox", { value: costText(session.cost, locale) }) : null;
  return (
    <View style={styles.sessionBlock}>
      <View style={[styles.sessionRow, selected && styles.sessionRowPicked]}>
        {selecting && session.deletable ? (
          <PickBox checked={selected} partial={false} onPress={toggle} label={t("select")} />
        ) : null}
        <View style={styles.sessionMain}>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {session.title.length > 0 ? session.title : t("noPrompt")}
          </Text>
          <Text style={styles.sessionSub} numberOfLines={1}>
            {sub}
          </Text>
          {hit !== undefined ? (
            <Text style={styles.hit} numberOfLines={2}>
              {hit.before}
              <Text style={styles.hitMark}>{hit.match}</Text>
              {hit.after}
            </Text>
          ) : null}
        </View>
        <View style={styles.sessionMetrics}>
          {tokens !== null ? <Text style={styles.metric}>{tokens}</Text> : null}
          {cost !== null ? <Text style={styles.metricStrong}>{cost}</Text> : null}
        </View>
        {session.resume.length > 0 ? (
          <ResumeAction
            copy={session.wsl !== undefined || session.agent === "agy"}
            disabled={disabled}
            onCopy={copyCommand}
            onResume={resume}
            terminal={terminal.available}
            onTerminal={terminal.openInTerminal}
            t={t}
          />
        ) : null}
        {session.deletable ? (
          <PressHighlight
            onPress={remove}
            disabled={disabled}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("delete")}
            style={styles.rowIconButton}
          >
            <ThemedTrash size={15} uniProps={dangerIcon} />
          </PressHighlight>
        ) : null}
      </View>
      <View style={styles.sessionActions}>
        <PressHighlight
          onPress={toggleTalk}
          accessibilityRole="button"
          accessibilityState={talkState}
          style={styles.rowIconButton}
        >
          <Text style={styles.actionText}>
            {talkOpen ? t("hideConversation") : t("showConversation")}
          </Text>
        </PressHighlight>
      </View>
      {talkOpen ? <ConversationPanel serverId={serverId} session={session} t={t} /> : null}
      <SubagentsFold serverId={serverId} session={session} t={t} />
    </View>
  );
}

function ResumeAction({
  copy,
  disabled,
  onCopy,
  onResume,
  terminal,
  onTerminal,
  t,
}: {
  copy: boolean;
  disabled: boolean;
  onCopy: () => void;
  onResume: () => void;
  terminal: boolean;
  onTerminal: () => void;
  t: SessionsT;
}) {
  const action = copy ? (
    <Button
      variant="secondary"
      leftIcon={ThemedCopy}
      disabled={disabled}
      onPress={onCopy}
      accessibilityLabel={t("copyCommand")}
    >
      {t("copyCommand")}
    </Button>
  ) : (
    <Button
      variant="secondary"
      leftIcon={ThemedPlay}
      disabled={disabled}
      onPress={onResume}
      accessibilityLabel={t("resume")}
    >
      {t("resume")}
    </Button>
  );
  if (!terminal) {
    return action;
  }
  return (
    <>
      {action}
      <PressHighlight
        onPress={onTerminal}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("openInTerminal")}
        style={styles.rowIconButton}
      >
        <ThemedTerminal size={15} uniProps={foregroundIcon} />
      </PressHighlight>
    </>
  );
}

function TrashView({
  entries,
  trashDir,
  disabled,
  onRestore,
  onPurge,
  t,
}: {
  entries: ExternalSessionTrashed[];
  trashDir: string;
  disabled: boolean;
  onRestore: (entry: ExternalSessionTrashed) => void;
  onPurge: (entries: readonly ExternalSessionTrashed[], all: boolean) => void;
  t: SessionsT;
}) {
  const empty = useCallback(() => onPurge(entries, true), [entries, onPurge]);
  if (entries.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>{t("trashEmptyTitle")}</Text>
        <Text style={styles.mutedText}>{t("trashEmptyHint")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.list}>
      <View style={styles.trashBar}>
        <Text style={styles.groupCount}>{sessionsCountLabel(t, entries.length)}</Text>
        <View style={styles.grow} />
        <Button variant="ghost" disabled={disabled} onPress={empty}>
          {t("emptyTrash")}
        </Button>
      </View>
      {entries.map((entry) => (
        <TrashRow
          key={entry.key}
          entry={entry}
          disabled={disabled}
          onRestore={onRestore}
          onPurge={onPurge}
          t={t}
        />
      ))}
      <Text style={styles.note}>{t("trashKeptNote", { dir: trashDir })}</Text>
      {entries.some((entry) => entry.gateway === true) ? (
        <Text style={styles.note}>{t("trashGatewayNote")}</Text>
      ) : null}
    </View>
  );
}

function TrashRow({
  entry,
  disabled,
  onRestore,
  onPurge,
  t,
}: {
  entry: ExternalSessionTrashed;
  disabled: boolean;
  onRestore: (entry: ExternalSessionTrashed) => void;
  onPurge: (entries: readonly ExternalSessionTrashed[], all: boolean) => void;
  t: SessionsT;
}) {
  const restore = useCallback(() => onRestore(entry), [entry, onRestore]);
  const purge = useCallback(() => onPurge([entry], false), [entry, onPurge]);
  const deleted = formatAgo(entry.deleted, Date.now(), appI18n.t) ?? "";
  const sub = [
    entry.gateway === true ? t("gatewayGroup") : entry.cwd,
    t("deletedWhen", { when: deleted }),
    entry.size > 0 ? formatFileSize(entry.size) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={styles.sessionRow}>
      <View style={styles.sessionMain}>
        <Text style={styles.sessionTitle} numberOfLines={1}>
          {entry.title.length > 0 ? entry.title : entry.id}
        </Text>
        <Text style={styles.sessionSub} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Button variant="secondary" leftIcon={ThemedUndo} disabled={disabled} onPress={restore}>
        {t("restore")}
      </Button>
      <PressHighlight
        onPress={purge}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("deleteForever")}
        style={styles.rowIconButton}
      >
        <ThemedTrash size={15} uniProps={dangerIcon} />
      </PressHighlight>
    </View>
  );
}

function sizeLabel(session: ExternalSession, t: SessionsT): string {
  if (session.gateway === true) {
    return session.size > 0 ? t("recordedSize", { size: formatFileSize(session.size) }) : "";
  }
  return session.size > 0 ? formatFileSize(session.size) : "";
}

function tokensLine(session: ExternalSession, locale: string, t: SessionsT): string | null {
  const total =
    session.tokens.input +
    session.tokens.output +
    session.tokens.cacheRead +
    session.tokens.cacheWrite;
  if (total === 0) {
    return null;
  }
  return t("tokensLine", {
    input: compactNumber(session.tokens.input, locale),
    output: compactNumber(session.tokens.output, locale),
    cache: compactNumber(session.tokens.cacheRead + session.tokens.cacheWrite, locale),
  });
}

const styles = StyleSheet.create((theme) => ({
  page: {
    gap: theme.spacing[4],
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  toolbarButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  toolbarSearch: {
    flexGrow: 1,
    minWidth: 180,
  },
  agentIcon: {
    color: theme.colors.foregroundMuted,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[8],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyState: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[8],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  list: {
    gap: theme.spacing[2],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  group: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: "hidden",
  },
  others: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    overflow: "hidden",
  },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  groupFold: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  chevron: {
    width: 16,
    alignItems: "center",
  },
  groupMain: {
    flex: 1,
    minWidth: 0,
  },
  groupTitleLine: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  groupName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  groupWhere: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  groupLatest: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  groupMeta: {
    alignItems: "flex-end",
    gap: 2,
  },
  groupWhen: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  groupCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sessionBlock: {
    borderTopColor: theme.colors.border,
    borderTopWidth: theme.borderWidth[1],
  },
  sessionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  actionText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  groupAction: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  sessionRowPicked: {
    backgroundColor: theme.colors.surface2,
  },
  sessionMain: {
    flex: 1,
    minWidth: 0,
  },
  sessionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sessionSub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  hit: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  hitMark: {
    backgroundColor: theme.colors.surface3,
    color: theme.colors.foreground,
  },
  sessionMetrics: {
    alignItems: "flex-end",
    gap: 2,
    minWidth: 90,
  },
  metric: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  metricStrong: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowIconButton: {
    padding: theme.spacing[1],
  },
  pickBox: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  partialDot: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.foreground,
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
  },
  trashBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  grow: {
    flex: 1,
  },
  toastText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
