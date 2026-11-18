// Host pages backed by daemon records rather than config keys: the providers' own session
// history (trash, provider moves, relocation, conversation export) and the host's sync and
// backup setup. Every action forwards to a Neox daemon request through the bridge; the UI
// only decides which one and confirms the destructive ones.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ConfirmDialogOptions,
  NeolixCodexMove,
  NeolixExternalSession,
  NeolixSyncRemoteVersion,
  NeolixSyncStatus,
} from "@synara/contracts";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { HostUpdateNotice } from "~/components/hosts/HostUpdateNotice";
import { useHostFeatures } from "~/hooks/useHostFeatures";
import { HOST_FEATURES } from "~/lib/hostFeatures.logic";
import { EllipsisIcon } from "~/lib/icons";
import { t as i18nT, useTranslation } from "~/i18n";
import {
  deleteBackup,
  deleteExternalSessions,
  dismissSyncNotice,
  downloadBackup,
  exportBackup,
  exportExternalSession,
  followSync,
  getBackupAuto,
  getExternalSessionTranscript,
  getSyncConfig,
  getSyncStatus,
  importBackup,
  listBackups,
  listExternalSessions,
  listSyncRemote,
  moveExternalCodexProvider,
  openSessionInTerminal,
  purgeExternalSessions,
  relocateClaudeProject,
  restoreBackup,
  restoreExternalSession,
  restoreSync,
  resumeExternalSession,
  revealBackups,
  runSync,
  searchExternalSessions,
  setBackupAuto,
  setConversationRecording,
  setSyncConfig,
  undoSync,
  uploadSync,
} from "~/lib/neolixHostApi";
import { ensureNativeApi } from "~/nativeApi";
import { localizeSyncError } from "~/lib/errorLocalization";
import { syncUrlForBackend, type SyncBackend } from "~/lib/syncSettingsModel";

import { formatBytes, formatWhen } from "./hostSettingsModel";
import { canDeleteSessions, groupTitleOf } from "./hostSettingsValidation";
import { SettingsSegmentedControl } from "./SettingControls";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `work` and reports whether it threw. Panels call this instead of writing
 * try/catch/finally inline: React Compiler skips any component containing a `finally`
 * or a `throw` inside `try`, and module-level code is not compiled.
 */
async function attempt<T>(work: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function confirmAction(message: string, options: ConfirmDialogOptions): Promise<boolean> {
  try {
    return await ensureNativeApi().dialogs.confirm(message, options);
  } catch {
    return false;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function saveFile(name: string, bytes: Uint8Array, mimeType: string): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error(i18nT("settings:hostData_couldNotReadFile"))),
    );
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    });
    reader.readAsDataURL(file);
  });
}

// ── Sessions ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
/**
 * While the daemon fills header rows in, re-ask faster at first and back off
 * to one slow poll. It keeps asking until the answer stops being partial, so a
 * slow machine never settles on the header's message count and usage.
 */
const PARTIAL_REFRESH_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 15_000] as const;

export function HostSessionsSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [needle, setNeedle] = useState("");
  const [hits, setHits] = useState<
    ReadonlyArray<{ id: string; role: string; kind: string; match: string }>
  >([]);
  const [searchInfo, setSearchInfo] = useState<{
    searched: number;
    total: number;
    cut: boolean;
  } | null>(null);
  const [searching, setSearching] = useState(false);
  const [trashOn, setTrashOn] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [pickedTrash, setPickedTrash] = useState<ReadonlySet<string>>(() => new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [transcriptLimit, setTranscriptLimit] = useState(50);
  const [providerMove, setProviderMove] = useState<ReadonlyArray<NeolixExternalSession> | null>(
    null,
  );
  const [chosenMove, setChosenMove] = useState<ReadonlySet<string>>(() => new Set());
  const [lastMove, setLastMove] = useState<ReadonlyArray<NeolixCodexMove> | null>(null);
  const [relocateFrom, setRelocateFrom] = useState<string | null>(null);
  const [relocateTo, setRelocateTo] = useState("");
  const [relocateToken, setRelocateToken] = useState<string | null>(null);
  const [relocateNote, setRelocateNote] = useState("");

  const sessionsQuery = useQuery({
    queryKey: ["neolix-external-sessions", agent ?? ""],
    queryFn: () => listExternalSessions(agent),
    enabled: active,
    staleTime: 15_000,
    // A header-first answer fills in as the daemon reads the files.
    refetchInterval: (query) => {
      if (query.state.data?.partial !== true) return false;
      const step = Math.min(
        Math.max(query.state.dataUpdateCount - 1, 0),
        PARTIAL_REFRESH_DELAYS_MS.length - 1,
      );
      return PARTIAL_REFRESH_DELAYS_MS[step] ?? 15_000;
    },
    // A hidden window or an unmounted panel asks nothing.
    refetchIntervalInBackground: false,
  });
  const data = sessionsQuery.data;
  const activeAgent = data?.agent ?? agent ?? "";
  const transcriptQuery = useQuery({
    queryKey: ["neolix-external-transcript", activeAgent, expanded ?? "", transcriptLimit],
    queryFn: () =>
      getExternalSessionTranscript({
        agent: activeAgent,
        id: expanded ?? "",
        limit: transcriptLimit,
      }),
    enabled: active && expanded !== null,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["neolix-external-sessions"] });
  }, [queryClient]);

  const hitIds = useMemo(() => new Set(hits.map((hit) => hit.id)), [hits]);
  // `searchInfo` is set by every completed search, including one with no hits.
  // Keying the filter off the hit count instead would turn a fruitless search
  // into the full list, which reads as if the search never ran.
  const visibleSessions = useMemo(() => {
    const sessions = data?.sessions ?? [];
    if (searchInfo === null) return sessions;
    return sessions.filter((session) => hitIds.has(session.id));
  }, [data, hitIds, searchInfo]);
  // Transcript parts carry no id, and two turns of the same role/kind/text are
  // legitimate. Count repeats so every row gets a stable unique key.
  const transcriptRows = useMemo(() => {
    const seen = new Map<string, number>();
    return (transcriptQuery.data?.parts ?? []).map((part) => {
      const base = `${part.role}:${part.kind}:${part.text}`;
      const occurrence = seen.get(base) ?? 0;
      seen.set(base, occurrence + 1);
      return { key: `${base}#${occurrence}`, part };
    });
  }, [transcriptQuery.data?.parts]);
  const hiddenProviders = useMemo(() => {
    if (data?.agent !== "codex") return [];
    return (data?.sessions ?? []).filter(
      (session) =>
        session.provider !== undefined &&
        session.usesProvider !== undefined &&
        session.provider !== session.usesProvider,
    );
  }, [data]);
  const groups = useMemo(() => {
    const byCwd = new Map<string, NeolixExternalSession[]>();
    for (const session of visibleSessions.slice(0, limit)) {
      const list = byCwd.get(session.cwd) ?? [];
      list.push(session);
      byCwd.set(session.cwd, list);
    }
    return [...byCwd.entries()].toSorted((left, right) => right[1].length - left[1].length);
  }, [visibleSessions, limit]);

  const search = useCallback(async () => {
    const query = needle.trim();
    if (query.length < 2 || !activeAgent) return;
    setSearching(true);
    const outcome = await attempt(() => searchExternalSessions(activeAgent, query));
    setSearching(false);
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: t("settings:hostData_couldNotSearchSessions"),
        description: errorMessage(outcome.error),
      });
      return;
    }
    setHits(outcome.value.hits);
    setSearchInfo({
      searched: outcome.value.searched,
      total: outcome.value.total,
      cut: outcome.value.cut,
    });
  }, [activeAgent, needle, t]);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<unknown>,
      success: string,
      failure: string,
    ): Promise<boolean> => {
      setBusy(key);
      const outcome = await attempt(async () => {
        const result = (await action()) as
          | { error?: string | null; refused?: Array<{ error: string }> }
          | undefined;
        if (result?.error) throw new Error(result.error);
        const refusal = result?.refused?.[0];
        if (refusal) throw new Error(refusal.error);
        toastManager.add({ type: "success", title: success });
        await refresh();
      });
      setBusy(null);
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: failure,
          description: errorMessage(outcome.error),
        });
      }
      return outcome.ok;
    },
    [refresh],
  );

  const changeAgent = useCallback((next: string) => {
    setAgent(next);
    setTrashOn(false);
    setSelecting(false);
    setPicked(new Set());
    setPickedTrash(new Set());
    setHits([]);
    setSearchInfo(null);
    setExpanded(null);
    setLastMove(null);
    setProviderMove(null);
    setRelocateFrom(null);
    setLimit(PAGE_SIZE);
  }, []);

  const deleteSessions = useCallback(
    async (sessions: ReadonlyArray<NeolixExternalSession>) => {
      if (sessions.length === 0 || !data) return;
      const confirmed = await confirmAction(
        t("settings:hostData_moveToTrashConfirm", {
          count: sessions.length,
          title: sessions[0]?.title || sessions[0]?.id,
          location: data.trashDir || t("settings:hostData_hostTrash"),
        }),
        { confirmLabel: t("common:confirm_moveToTrash") },
      );
      if (!confirmed) return;
      const ok = await run(
        "delete",
        () =>
          deleteExternalSessions(
            data.agent,
            sessions.map((session) => session.id),
          ),
        t("settings:hostData_sessionsMovedToTrash"),
        t("settings:hostData_couldNotDeleteSessions"),
      );
      if (ok) {
        setPicked(new Set());
        setSelecting(false);
      }
    },
    [data, run, t],
  );

  const restoreTrash = useCallback(
    async (key: string) =>
      run(
        `restore-${key}`,
        () => restoreExternalSession(key),
        t("settings:hostData_sessionRestored"),
        t("settings:hostData_couldNotRestoreSession"),
      ),
    [run, t],
  );

  const purgeTrash = useCallback(
    async (keys: ReadonlyArray<string>, all: boolean) => {
      const confirmed = await confirmAction(
        all
          ? t("settings:hostData_emptyTrashConfirm")
          : t("settings:hostData_deleteTrashedConfirm", { count: keys.length }),
        { confirmLabel: t("common:delete"), destructive: true },
      );
      if (!confirmed) return;
      const ok = await run(
        "purge",
        () => purgeExternalSessions(all ? { all: true } : { keys: [...keys] }),
        all ? t("settings:hostData_trashEmptied") : t("settings:hostData_trashedSessionsDeleted"),
        t("settings:hostData_couldNotDeleteTrashed"),
      );
      if (ok) setPickedTrash(new Set());
    },
    [run, t],
  );

  const resumeSession = useCallback(
    async (session: NeolixExternalSession) => {
      setBusy(`resume-${session.id}`);
      const outcome = await attempt(() =>
        resumeExternalSession({
          providerId: session.agent,
          providerHandleId: session.id,
          ...(session.cwd ? { cwd: session.cwd } : {}),
        }),
      );
      setBusy(null);
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: t("settings:hostData_couldNotResume"),
          description: errorMessage(outcome.error),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: t("settings:hostData_resumedAs", { agent: outcome.value.agentId }),
        description: t("settings:hostData_findInThreads"),
      });
    },
    [t],
  );

  const copyResume = useCallback(
    async (command: string) => {
      try {
        await navigator.clipboard.writeText(command);
        toastManager.add({ type: "success", title: t("settings:hostData_resumeCommandCopied") });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: t("settings:hostData_couldNotCopyCommand"),
          description: errorMessage(cause),
        });
      }
    },
    [t],
  );

  const exportSession = useCallback(
    async (session: NeolixExternalSession) => {
      setBusy(`export-${session.id}`);
      const outcome = await attempt(async () => {
        const result = await exportExternalSession(session.agent, session.id);
        if (result.error) throw new Error(result.error);
        saveFile(result.fileName, new TextEncoder().encode(result.markdown), "text/markdown");
        toastManager.add({
          type: "success",
          title: t("settings:hostData_exportedFile", { file: result.fileName }),
        });
      });
      setBusy(null);
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: t("settings:hostData_couldNotExport"),
          description: errorMessage(outcome.error),
        });
      }
    },
    [t],
  );

  const moveProviders = useCallback(
    async (moves: ReadonlyArray<{ id: string; to: string }>, to: string) => {
      setBusy("move");
      const outcome = await attempt(async () => {
        const result = await moveExternalCodexProvider([...moves]);
        if (result.error) throw new Error(result.error);
        const refusal = result.refused[0];
        if (refusal) throw new Error(refusal.error);
        if (result.moved.length > 0) setLastMove(result.moved);
        toastManager.add({
          type: "success",
          title: t("settings:hostData_movedTo", { target: to }),
        });
        setProviderMove(null);
        await refresh();
      });
      setBusy(null);
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: t("settings:hostData_couldNotMove"),
          description: errorMessage(outcome.error),
        });
      }
    },
    [refresh, t],
  );

  const toggleTrash = useCallback(() => {
    setTrashOn((previous) => !previous);
    setSelecting(false);
    setPicked(new Set());
    setPickedTrash(new Set());
  }, []);

  const relocate = useCallback(async () => {
    if (!relocateFrom) return;
    setBusy("relocate");
    setRelocateNote("");
    const outcome = await attempt(async () => {
      const result = await relocateClaudeProject({
        from: relocateFrom,
        to: relocateTo.trim(),
        ...(relocateToken === null ? {} : { token: relocateToken }),
      });
      if (result.error) throw new Error(result.error);
      if (result.backup) {
        toastManager.add({
          type: "success",
          title: t("settings:hostData_projectMovedBackup", { path: result.backup }),
        });
        setRelocateFrom(null);
        setRelocateToken(null);
        await refresh();
        return;
      }
      setRelocateToken(result.token);
      if (result.preview) {
        setRelocateNote(
          t("settings:hostData_relocatePreview", {
            count: result.preview.sessions,
            bytes: formatBytes(result.preview.bytes),
            from: result.preview.from,
            to: result.preview.to,
          }),
        );
      }
    });
    if (!outcome.ok) {
      setRelocateToken(null);
      setRelocateNote(errorMessage(outcome.error));
    }
    setBusy(null);
  }, [refresh, relocateFrom, relocateTo, relocateToken, t]);

  const setRecording = useCallback(
    async (on: boolean) => {
      if (on) {
        const confirmed = await confirmAction(t("settings:hostData_recordConfirm"), {
          confirmLabel: t("common:confirm_record"),
        });
        if (!confirmed) return;
      }
      await run(
        "recording",
        () => setConversationRecording({ on }),
        on ? t("settings:hostData_recordingOn") : t("settings:hostData_recordingOff"),
        t("settings:hostData_couldNotChangeRecording"),
      );
    },
    [run, t],
  );

  const clearRecordings = useCallback(async () => {
    const confirmed = await confirmAction(t("settings:hostData_clearConfirm"), {
      confirmLabel: t("common:delete"),
      destructive: true,
    });
    if (!confirmed) return;
    await run(
      "clear-recordings",
      () => setConversationRecording({ clear: true }),
      t("settings:hostData_savedConversationsDeleted"),
      t("settings:hostData_couldNotDeleteSaved"),
    );
  }, [run, t]);

  if (!active) return null;

  const transcript = transcriptQuery.data;
  const selectedSessions = (data?.sessions ?? []).filter((session) => picked.has(session.id));
  const activeAgentEntry = data?.agents.find((entry) => entry.agent === activeAgent);
  const selectionDeletable = canDeleteSessions(selectedSessions);

  return (
    <div className="space-y-6">
      {/* The page description already says what this is; the header carries only Refresh. */}
      <SettingsSectionShell
        title="settings:hostData_find"
        action={
          <Button
            size="xs"
            variant="outline"
            disabled={sessionsQuery.isFetching}
            onClick={() => void sessionsQuery.refetch()}
          >
            {t("settings:host_refresh")}
          </Button>
        }
      >
        <SettingsCard>
          <SettingsRow
            id="setting-sessions-agent"
            title={t("settings:hostData_agentLabel")}
            description={t("settings:hostData_agentDescription")}
            status={
              data?.error ? (
                data.error
              ) : activeAgentEntry?.deletable === false ? (
                <span className="text-muted-foreground">
                  {t("settings:hostData_agentReadOnly")}
                </span>
              ) : undefined
            }
            control={
              <SettingsSegmentedControl
                value={activeAgent}
                onValueChange={changeAgent}
                ariaLabel={t("settings:hostData_agentLabel")}
                options={(data?.agents ?? []).map((entry) => ({
                  value: entry.agent,
                  label: `${entry.name} (${entry.count})`,
                }))}
              />
            }
          />
          {trashOn ? null : (
            <SettingsRow
              id="setting-sessions-search"
              title={t("settings:hostData_search")}
              description={t("settings:hostData_searchDescription")}
              control={
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Input
                    value={needle}
                    placeholder={t("settings:hostData_searchPlaceholder")}
                    className="sm:w-48"
                    onChange={(event) => {
                      setNeedle(event.target.value);
                      if (event.target.value.trim().length < 2) {
                        setHits([]);
                        setSearchInfo(null);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void search();
                    }}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={searching || needle.trim().length < 2}
                    onClick={() => void search()}
                  >
                    {searching ? t("settings:hostData_searching") : t("settings:hostData_search")}
                  </Button>
                  {searchInfo !== null ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setHits([]);
                        setSearchInfo(null);
                      }}
                    >
                      {t("settings:hostData_clear")}
                    </Button>
                  ) : null}
                </div>
              }
            />
          )}
          {searchInfo ? (
            <SettingsRow
              title={t("settings:hostData_searchResult")}
              description={
                searchInfo.cut
                  ? t("settings:hostData_searchCut", {
                      searched: searchInfo.searched,
                      total: searchInfo.total,
                    })
                  : t("settings:hostData_searchMatches", {
                      hits: hits.length,
                      total: searchInfo.total,
                    })
              }
            />
          ) : null}
          <SettingsRow
            title={trashOn ? t("settings:hostData_trash") : t("settings:hostData_selection")}
            description={
              trashOn
                ? t("settings:hostData_trashDescription")
                : t("settings:hostData_selectionDescription")
            }
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                {trashOn ? null : (
                  <Button
                    size="xs"
                    variant={selecting ? "default" : "outline"}
                    onClick={() => {
                      setSelecting((previous) => !previous);
                      setPicked(new Set());
                    }}
                  >
                    {selecting ? t("settings:hostData_done") : t("settings:hostData_select")}
                  </Button>
                )}
                <Button size="xs" variant="outline" onClick={toggleTrash}>
                  {trashOn
                    ? t("settings:hostData_backToSessions")
                    : data?.trash.length
                      ? t("settings:hostData_trashWithCount", { n: data.trash.length })
                      : t("settings:hostData_trash")}
                </Button>
              </div>
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      {data && (data.recording || data.recorded || data.sessions.some((s) => s.gateway)) ? (
        <SettingsSection title={t("settings:hostData_gatewayRecordings")}>
          <SettingsRow
            title={t("settings:hostData_recordGateway")}
            description={t("settings:hostData_recordGatewayDescription")}
            control={
              <Switch
                checked={data.recording}
                disabled={busy !== null}
                onCheckedChange={(checked) => void setRecording(checked === true)}
                aria-label={t("settings:hostData_recordGateway")}
              />
            }
          />
          {data.recorded ? (
            <SettingsRow
              title={t("settings:hostData_savedConversations")}
              description={t("settings:hostData_savedConversationsDescription")}
              control={
                <Button size="xs" variant="outline" onClick={() => void clearRecordings()}>
                  {t("settings:hostData_deleteSaved")}
                </Button>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      {hiddenProviders.length > 0 || lastMove !== null ? (
        <SettingsSection title={t("settings:hostData_codexProviders")}>
          <SettingsRow
            title={
              hiddenProviders.length > 0
                ? t("settings:hostData_hiddenFromCodex", { count: hiddenProviders.length })
                : t("settings:hostData_movedSessions", { count: lastMove?.length ?? 0 })
            }
            description={
              hiddenProviders.length > 0
                ? t("settings:hostData_hiddenProvidersDescription", {
                    providers: [
                      ...new Set(hiddenProviders.map((s) => s.provider).filter(Boolean)),
                    ].join(", "),
                    current: hiddenProviders[0]?.usesProvider ?? "",
                  })
                : t("settings:hostData_lastMoveUndo")
            }
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                {hiddenProviders.length > 0 ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setProviderMove(hiddenProviders);
                      setChosenMove(new Set(hiddenProviders.map((s) => s.id)));
                    }}
                  >
                    {t("settings:hostData_moveTo", {
                      target: hiddenProviders[0]?.usesProvider,
                    })}
                  </Button>
                ) : null}
                {lastMove ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() =>
                      void moveProviders(
                        lastMove.map((move) => ({ id: move.id, to: move.from })),
                        lastMove[0]?.from ?? "",
                      )
                    }
                  >
                    {t("settings:hostData_undo")}
                  </Button>
                ) : null}
              </div>
            }
          />
          {providerMove ? (
            <SettingsSection title={t("settings:hostData_chooseSessions")}>
              {providerMove.map((session) => (
                <SettingsListRow
                  key={session.path}
                  title={session.title || session.id}
                  description={`${session.provider ?? ""} · ${formatWhen(session.last)}`}
                  actions={
                    <Checkbox
                      checked={chosenMove.has(session.id)}
                      onCheckedChange={(checked) =>
                        setChosenMove((previous) => {
                          const next = new Set(previous);
                          if (checked === true) next.add(session.id);
                          else next.delete(session.id);
                          return next;
                        })
                      }
                      aria-label={session.title || session.id}
                    />
                  }
                />
              ))}
              <SettingsRow
                title={t("settings:hostData_selectedCount", { count: chosenMove.size })}
                description={t("settings:hostData_moveDescription")}
                control={
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Button size="xs" variant="ghost" onClick={() => setProviderMove(null)}>
                      {t("common:form_cancel")}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={chosenMove.size === 0 || busy !== null}
                      onClick={() =>
                        void moveProviders(
                          [...chosenMove].map((id) => ({
                            id,
                            to: hiddenProviders[0]?.usesProvider ?? "",
                          })),
                          hiddenProviders[0]?.usesProvider ?? "",
                        )
                      }
                    >
                      {t("settings:hostData_move")}
                    </Button>
                  </div>
                }
              />
            </SettingsSection>
          ) : null}
        </SettingsSection>
      ) : null}

      {relocateFrom ? (
        <SettingsSection title={t("settings:hostData_relocateTitle")}>
          <SettingsRow
            title={relocateFrom}
            description={t("settings:hostData_relocateDescription")}
            control={
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <Input
                  value={relocateTo}
                  className="sm:w-64"
                  onChange={(event) => {
                    setRelocateTo(event.target.value);
                    setRelocateToken(null);
                    setRelocateNote("");
                  }}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null || relocateTo.trim().length === 0}
                  onClick={() => void relocate()}
                >
                  {relocateToken === null
                    ? t("settings:hostData_preview")
                    : t("settings:hostData_confirmMove")}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setRelocateFrom(null)}>
                  {t("common:app_close")}
                </Button>
              </div>
            }
          />
          {relocateNote ? (
            <SettingsRow title={t("settings:hostData_preview")} description={relocateNote} />
          ) : null}
        </SettingsSection>
      ) : null}

      {trashOn ? (
        <SettingsSection title={t("settings:hostData_trash")}>
          {!data?.trash.length ? (
            <SettingsEmptyState layout="status">
              {t("settings:hostData_trashEmpty")}
            </SettingsEmptyState>
          ) : (
            <>
              {data.trash.map((entry) => (
                <SettingsListRow
                  key={entry.key}
                  title={entry.title || entry.id}
                  description={`${entry.agent} · ${entry.cwd} · ${t("settings:hostData_deletedAt", {
                    when: formatWhen(entry.deleted),
                  })}`}
                  actions={
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={pickedTrash.has(entry.key)}
                        onCheckedChange={(checked) =>
                          setPickedTrash((previous) => {
                            const next = new Set(previous);
                            if (checked === true) next.add(entry.key);
                            else next.delete(entry.key);
                            return next;
                          })
                        }
                        aria-label={entry.title || entry.id}
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void restoreTrash(entry.key)}
                      >
                        {t("settings:hostData_restore")}
                      </Button>
                    </div>
                  }
                />
              ))}
              <SettingsRow
                title={t("settings:hostData_permanentDeletion")}
                description={t("settings:hostData_permanentDeletionDescription")}
                control={
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pickedTrash.size === 0 || busy !== null}
                      onClick={() => void purgeTrash([...pickedTrash], false)}
                    >
                      {t("settings:hostData_deleteSelected")}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void purgeTrash([], true)}
                    >
                      {t("settings:hostData_emptyTrash")}
                    </Button>
                  </div>
                }
              />
            </>
          )}
        </SettingsSection>
      ) : (
        <>
          {selecting ? (
            <SettingsSection title={t("settings:hostData_selected")}>
              <SettingsRow
                title={t("settings:hostData_selectedCount", { count: selectedSessions.length })}
                description={
                  selectedSessions.length > 0 && !selectionDeletable
                    ? t("settings:hostData_someSessionsNotDeletable")
                    : t("settings:hostData_moveToHostTrash")
                }
                control={
                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={visibleSessions.length === 0 || busy !== null}
                      onClick={() =>
                        setPicked(new Set(visibleSessions.map((session) => session.id)))
                      }
                    >
                      {t("settings:hostData_selectAll")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={picked.size === 0}
                      onClick={() => setPicked(new Set())}
                    >
                      {t("settings:hostData_clearSelection")}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!selectionDeletable || busy !== null}
                      onClick={() => void deleteSessions(selectedSessions)}
                    >
                      {t("settings:hostData_deleteSelected")}
                    </Button>
                  </div>
                }
              />
            </SettingsSection>
          ) : null}

          {data?.partial === true ? (
            <p role="status" aria-live="polite" className="text-ui-xs text-muted-foreground">
              {t("settings:hostData_statsPending")}
            </p>
          ) : null}

          {sessionsQuery.isLoading ? (
            <SettingsSection title={t("settings:hostData_sessions")}>
              <SettingsEmptyState layout="status">{t("settings:host_loading")}</SettingsEmptyState>
            </SettingsSection>
          ) : visibleSessions.length === 0 ? (
            <SettingsSection title={t("settings:hostData_sessions")}>
              <SettingsEmptyState layout="status">
                {data?.error ??
                  (searchInfo !== null
                    ? t("settings:hostData_noSessionsMatched")
                    : t("settings:hostData_noRecordedSessions"))}
              </SettingsEmptyState>
            </SettingsSection>
          ) : (
            groups.map(([cwd, sessions]) => (
              <SettingsSectionShell
                key={cwd}
                title={groupTitleOf(cwd, t("settings:hostData_unknownDirectory"))}
                translateTitle={false}
                action={
                  <div className="flex items-center gap-1">
                    {selecting ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setPicked((previous) => {
                            const next = new Set(previous);
                            const allChosen = sessions.every((session) => next.has(session.id));
                            for (const session of sessions) {
                              if (allChosen) next.delete(session.id);
                              else next.add(session.id);
                            }
                            return next;
                          })
                        }
                      >
                        {sessions.every((session) => picked.has(session.id))
                          ? t("settings:hostData_clearSelection")
                          : t("settings:hostData_selectAll")}
                      </Button>
                    ) : null}
                    {activeAgent === "claude" ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setRelocateFrom(cwd);
                          setRelocateTo(cwd);
                          setRelocateToken(null);
                          setRelocateNote("");
                        }}
                      >
                        {t("settings:hostData_relocate")}
                      </Button>
                    ) : null}
                  </div>
                }
              >
                <SettingsCard>
                  {sessions.map((session) => (
                    <SettingsListRow
                      // Provider ids are file names and repeat across directories
                      // ("session", "reviewer_transcript"); the path is unique.
                      key={session.path}
                      align="start"
                      leading={
                        selecting ? (
                          <Checkbox
                            checked={picked.has(session.id)}
                            onCheckedChange={(checked) =>
                              setPicked((previous) => {
                                const next = new Set(previous);
                                if (checked === true) next.add(session.id);
                                else next.delete(session.id);
                                return next;
                              })
                            }
                            aria-label={session.title || session.id}
                          />
                        ) : undefined
                      }
                      title={session.title || session.id}
                      description={`${data?.agents.find((entry) => entry.agent === session.agent)?.name ?? session.agent} · ${
                        data?.partial === true
                          ? t("settings:hostData_messageCountPending")
                          : t("settings:hostData_messageCount", {
                              count: session.messages,
                            })
                      } · ${formatWhen(session.last)}`}
                      actions={
                        // Read and Resume stay visible; the rest live in the row's menu.
                        <div className="flex items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setExpanded(expanded === session.id ? null : session.id)}
                          >
                            {expanded === session.id
                              ? t("settings:hostData_hide")
                              : t("settings:hostData_read")}
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => void resumeSession(session)}
                          >
                            {t("settings:hostData_resume")}
                          </Button>
                          <Menu>
                            <MenuTrigger
                              render={
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={t("settings:hostData_moreActions", {
                                    title: session.title || session.id,
                                  })}
                                />
                              }
                            >
                              <EllipsisIcon />
                            </MenuTrigger>
                            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
                              {session.resume ? (
                                <MenuItem onClick={() => void copyResume(session.resume)}>
                                  {t("settings:hostData_copyCommand")}
                                </MenuItem>
                              ) : null}
                              <MenuItem
                                disabled={busy !== null}
                                onClick={() => void exportSession(session)}
                              >
                                {t("settings:hostData_export")}
                              </MenuItem>
                              <MenuItem onClick={() => void openInTerminal(session, activeAgent)}>
                                {t("settings:hostData_openInTerminal")}
                              </MenuItem>
                              <MenuSeparator />
                              <MenuItem
                                variant="destructive"
                                disabled={busy !== null || !session.deletable}
                                onClick={() => void deleteSessions([session])}
                              >
                                {session.deletable
                                  ? t("settings:hostData_delete")
                                  : t("settings:hostData_deleteUnavailable")}
                              </MenuItem>
                            </ComposerPickerMenuPopup>
                          </Menu>
                        </div>
                      }
                    >
                      {expanded === session.id ? (
                        <div className="mt-3 space-y-2 rounded-lg border border-[color:var(--color-border)] bg-[var(--color-surface-1)] p-3 text-ui-sm text-muted-foreground">
                          {transcriptQuery.isLoading ? (
                            <span>{t("settings:hostData_loadingConversation")}</span>
                          ) : transcript?.error ? (
                            <span>{transcript.error}</span>
                          ) : transcript?.parts.length ? (
                            <>
                              <span className="text-ui-xs uppercase tracking-wide opacity-60">
                                {transcript.source === "gateway"
                                  ? t("settings:hostData_gatewayRecording")
                                  : t("settings:hostData_providerFile")}
                              </span>
                              {transcriptRows.map(({ key, part }) => (
                                <div key={key} className="space-y-0.5">
                                  <span className="text-ui-xs uppercase tracking-wide opacity-60">
                                    {part.role}
                                    {part.name ? ` · ${part.name}` : ""}
                                  </span>
                                  <p className="whitespace-pre-wrap break-words text-foreground">
                                    {part.text}
                                  </p>
                                </div>
                              ))}
                              {transcript.total > transcript.parts.length ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={transcriptQuery.isFetching}
                                  onClick={() => setTranscriptLimit(transcriptLimit + 50)}
                                >
                                  {t("settings:hostData_showMore")}
                                </Button>
                              ) : null}
                            </>
                          ) : (
                            <span>{t("settings:hostData_nothingRecorded")}</span>
                          )}
                        </div>
                      ) : null}
                    </SettingsListRow>
                  ))}
                </SettingsCard>
              </SettingsSectionShell>
            ))
          )}
          {visibleSessions.length > limit ? (
            <SettingsSection title={t("common:more")}>
              <SettingsRow
                title={t("settings:hostData_showingOf", {
                  shown: limit,
                  total: visibleSessions.length,
                })}
                description={t("settings:hostData_olderOnHost")}
                control={
                  <Button size="xs" variant="outline" onClick={() => setLimit(limit + PAGE_SIZE)}>
                    {t("settings:hostData_showMore")}
                  </Button>
                }
              />
            </SettingsSection>
          ) : null}
        </>
      )}
    </div>
  );
}

async function openInTerminal(session: NeolixExternalSession, agent: string): Promise<void> {
  if (!agent) return;
  try {
    const result = await openSessionInTerminal(agent, session.id);
    if (result.error) throw new Error(result.error);
    toastManager.add({
      type: "success",
      title: i18nT("settings:hostData_sessionOpened"),
    });
  } catch (cause) {
    toastManager.add({
      type: "error",
      title: i18nT("settings:hostData_couldNotOpenSession"),
      description: errorMessage(cause),
    });
  }
}

// ── Sync and backup ────────────────────────────────────────────────────────

const PART_NAMES = ["sources", "settings", "profiles", "models", "library", "usage"] as const;
const PART_LABEL_KEYS: Record<(typeof PART_NAMES)[number], string> = {
  sources: "settings:hostData_partSources",
  settings: "settings:hostData_partSettings",
  profiles: "settings:hostData_partProfiles",
  models: "settings:hostData_partModels",
  library: "settings:hostData_partLibrary",
  usage: "settings:hostData_partUsage",
};
const PART_DESCRIPTION_KEYS: Record<(typeof PART_NAMES)[number], string> = {
  sources: "settings:hostData_partSourcesDescription",
  settings: "settings:hostData_partSettingsDescription",
  profiles: "settings:hostData_partProfilesDescription",
  models: "settings:hostData_partModelsDescription",
  library: "settings:hostData_partLibraryDescription",
  usage: "settings:hostData_partUsageDescription",
};
const INTERVALS = [-1, 3, 15, 30, 60] as const;

export function HostSyncSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const hostFeatures = useHostFeatures();
  // One gate for the whole page: without `features.sync` an older daemon answers none of these.
  const syncAvailable = hostFeatures.isAvailable(HOST_FEATURES.sync);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [backend, setBackend] = useState<SyncBackend>("webdav");
  const [versions, setVersions] = useState<ReadonlyArray<NeolixSyncRemoteVersion> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [branch, setBranch] = useState("");
  const [keys, setKeys] = useState(false);
  const [parts, setParts] = useState<Record<string, boolean | undefined>>({});
  const [intervalMinutes, setIntervalMinutes] = useState("3");
  const [exportPassphrase, setExportPassphrase] = useState("");
  const [exportSignIns, setExportSignIns] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importSignIns, setImportSignIns] = useState(true);
  const [folder, setFolder] = useState("");
  const [editingFolder, setEditingFolder] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const configQuery = useQuery({
    queryKey: ["neolix-sync-config"],
    queryFn: getSyncConfig,
    enabled: active && syncAvailable,
    staleTime: 10_000,
  });
  const statusQuery = useQuery({
    queryKey: ["neolix-sync-status"],
    queryFn: getSyncStatus,
    enabled: active && syncAvailable,
    staleTime: 5_000,
  });
  const backupsQuery = useQuery({
    queryKey: ["neolix-backups"],
    queryFn: listBackups,
    enabled: active && syncAvailable,
    staleTime: 30_000,
  });
  const autoQuery = useQuery({
    queryKey: ["neolix-backup-auto"],
    queryFn: getBackupAuto,
    enabled: active && syncAvailable,
    staleTime: 30_000,
  });

  const config = configQuery.data?.config ?? null;
  const status = statusQuery.data?.status ?? null;
  const backups = backupsQuery.data?.backups ?? [];
  const auto = autoQuery.data?.config ?? null;
  const seeded = useRef(false);
  useEffect(() => {
    if (!config || seeded.current) return;
    seeded.current = true;
    setUrl(config.url);
    setUser(config.user);
    setEndpoint(config.endpoint);
    setRegion(config.region);
    setBranch(config.branch);
    setKeys(config.keys);
    setParts({ ...config.parts });
    setIntervalMinutes(String(config.intervalMinutes));
    setBackend(config.backend === "s3" || config.backend === "github" ? config.backend : "webdav");
  }, [config]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["neolix-sync-config"] }),
      queryClient.invalidateQueries({ queryKey: ["neolix-sync-status"] }),
      queryClient.invalidateQueries({ queryKey: ["neolix-backups"] }),
      queryClient.invalidateQueries({ queryKey: ["neolix-backup-auto"] }),
    ]);
  }, [queryClient]);

  const applyStatus = useCallback(
    (result: { status?: NeolixSyncStatus; error?: string } | undefined, done: string) => {
      if (result?.error) {
        setError(localizeSyncError(result.error, t));
        return false;
      }
      setError(null);
      setNotice(done);
      if (result?.status)
        queryClient.setQueryData(["neolix-sync-status"], { status: result.status });
      return true;
    },
    [queryClient, t],
  );

  const action = useCallback(
    async (
      key: string,
      run: () => Promise<{ status?: NeolixSyncStatus; error?: string } | undefined>,
      done: string,
    ) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      const outcome = await attempt(async () => applyStatus(await run(), done));
      if (!outcome.ok) setError(errorMessage(outcome.error));
      setBusy(null);
      await refresh();
    },
    [applyStatus, refresh],
  );

  const saveConfig = useCallback(
    async (extra: Record<string, unknown> = {}) => {
      if (!config) return;
      setBusy("save");
      setError(null);
      const outcome = await attempt(async () => {
        const target = syncUrlForBackend(backend, url);
        if (backend === "webdav" && /^(?:github|s3):\/\//iu.test(target.url)) {
          setError(t("settings:hostData_syncWebdavNeedsUrl"));
          return;
        }
        const selectedBranch = target.branch ?? branch.trim();
        const result = await setSyncConfig({
          url: target.url,
          user: user.trim(),
          ...(password ? { password } : {}),
          ...(passphrase ? { passphrase } : {}),
          ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
          ...(region.trim() ? { region: region.trim() } : {}),
          ...(selectedBranch ? { branch: selectedBranch } : {}),
          keys,
          parts,
          intervalMinutes: Number(intervalMinutes),
          enabled: true,
          ...extra,
        });
        if (result.error) throw new Error(result.error);
        setPassword("");
        setPassphrase("");
        setNotice(t("settings:hostData_syncSettingsSaved"));
        await refresh();
      });
      if (!outcome.ok) setError(localizeSyncError(outcome.error, t));
      setBusy(null);
    },
    [
      backend,
      branch,
      config,
      endpoint,
      intervalMinutes,
      keys,
      passphrase,
      password,
      parts,
      refresh,
      region,
      t,
      url,
      user,
    ],
  );

  const testConnection = useCallback(async () => {
    setBusy("test");
    setError(null);
    setNotice(null);
    const outcome = await attempt(async () => {
      const result = await listSyncRemote();
      if (result.error) throw new Error(result.error);
      setVersions(result.versions);
      setNotice(
        result.versions.length === 0
          ? t("settings:hostData_connectedEmpty")
          : t("settings:hostData_connectedParts", { count: result.versions.length }),
      );
    });
    if (!outcome.ok) setError(errorMessage(outcome.error));
    setBusy(null);
  }, [t]);

  const download = useCallback(
    async (name: string) => {
      setBusy(`download-${name}`);
      const outcome = await attempt(async () => {
        const result = await downloadBackup(name);
        if (result.error) throw new Error(result.error);
        saveFile(result.fileName, base64ToBytes(result.bytesBase64), result.mimeType);
        toastManager.add({
          type: "success",
          title: t("settings:hostData_savedFile", { file: result.fileName }),
        });
      });
      if (!outcome.ok) setError(errorMessage(outcome.error));
      setBusy(null);
    },
    [t],
  );

  const importFile = useCallback(
    async (file: File) => {
      setBusy("import");
      setError(null);
      const outcome = await attempt(async () => {
        const bytesBase64 = await readFileBase64(file);
        const result = await importBackup({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          bytesBase64,
          ...(importPassphrase ? { passphrase: importPassphrase } : {}),
          signIns: importSignIns,
        });
        if (result.error) throw new Error(result.error);
        setImportPassphrase("");
        setNotice(
          t("settings:hostData_importedParts", {
            parts: (result.parts ?? []).join(", ") || t("settings:hostData_theBackup"),
          }),
        );
        await refresh();
      });
      if (!outcome.ok) setError(errorMessage(outcome.error));
      setBusy(null);
    },
    [importPassphrase, importSignIns, refresh, t],
  );

  if (!active) return null;

  if (hostFeatures.featureStatus(HOST_FEATURES.sync) === "unavailable") {
    return (
      <SettingsSectionShell title="settings:hostData_sync">
        <HostUpdateNotice />
      </SettingsSectionShell>
    );
  }

  const backendHint =
    backend === "webdav"
      ? t("settings:hostData_webdavHint")
      : backend === "s3"
        ? t("settings:hostData_s3Hint")
        : t("settings:hostData_githubHint");
  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:hostData_status")}>
        <SettingsRow
          title={t("settings:hostData_sync")}
          description={
            !status?.enabled
              ? t("settings:hostData_syncOff")
              : status.error
                ? t("settings:hostData_syncError", {
                    error: localizeSyncError(status.error, t),
                  })
                : status.last
                  ? t("settings:hostData_lastSynced", { when: formatWhen(status.last) })
                  : t("settings:hostData_neverSynced")
          }
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
              {status?.enabled ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void action("sync", runSync, t("settings:hostData_syncFinished"))
                    }
                  >
                    {busy === "sync"
                      ? t("settings:hostData_syncing")
                      : t("settings:hostData_syncNow")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void testConnection()}
                  >
                    {busy === "test"
                      ? t("settings:hostData_testing")
                      : t("settings:hostData_testConnection")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void action("restore", restoreSync, t("settings:hostData_restoredFromRemote"))
                    }
                  >
                    {t("settings:hostData_restoreFromServer")}
                  </Button>
                </>
              ) : null}
            </div>
          }
        />
        {status?.notice ? (
          <SettingsRow
            title={
              status.notice.restored
                ? t("settings:hostData_restoredParts", {
                    parts: status.notice.here.join(", "),
                  })
                : t("settings:hostData_changedHere", {
                    parts: status.notice.here.join(", ") || "—",
                  })
            }
            description={
              status.notice.there.length > 0
                ? t("settings:hostData_alsoChangedOn", {
                    parts: status.notice.there.join(", "),
                  })
                : t("settings:hostData_noNewerChanges")
            }
            control={
              <div className="flex w-full items-center gap-2 sm:w-auto">
                {status.undo ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void action("undo", undoSync, t("settings:hostData_syncUndone"))}
                  >
                    {t("settings:hostData_undo")}
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void action(
                      "dismiss",
                      dismissSyncNotice,
                      t("settings:hostData_noticeDismissed"),
                    )
                  }
                >
                  {t("settings:hostData_dismiss")}
                </Button>
              </div>
            }
          />
        ) : null}
        {status?.serverFile?.replace ? (
          <SettingsRow
            title={t("settings:hostData_uploadTitle")}
            description={t("settings:hostData_uploadDescription")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void action("upload", uploadSync, t("settings:hostData_setupUploaded"))
                }
              >
                {t("settings:hostData_upload")}
              </Button>
            }
          />
        ) : null}
        {status?.own && status.own.length > 0 ? (
          <SettingsRow
            title={t("settings:hostData_ownFields")}
            description={status.own.map((entry) => `${entry.agent}: ${entry.field}`).join(", ")}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void action("follow", followSync, t("settings:hostData_fieldsGivenBack"))
                }
              >
                {busy === "follow"
                  ? t("settings:hostData_following")
                  : t("settings:hostData_followSync")}
              </Button>
            }
          />
        ) : null}
        {versions?.map((version) => (
          <SettingsRow
            key={`${version.part}-${version.takenAt}`}
            title={version.part}
            description={`${version.device} · ${formatWhen(version.takenAt)} · ${t(
              "settings:hostData_fileCount",
              { count: version.files },
            )}`}
          />
        ))}
      </SettingsSection>

      <SettingsSection title={t("settings:hostData_remote")}>
        <SettingsRow
          title={t("settings:hostData_backend")}
          description={backendHint}
          control={
            <SettingsSegmentedControl<SyncBackend>
              value={backend}
              onValueChange={setBackend}
              ariaLabel={t("settings:hostData_backend")}
              options={[
                { value: "webdav", label: "WebDAV" },
                { value: "s3", label: "S3" },
                { value: "github", label: "GitHub" },
              ]}
            />
          }
        />
        <SettingsRow
          title={
            backend === "github"
              ? t("settings:hostData_repositoryUrl")
              : t("settings:hostData_address")
          }
          description={
            backend === "github"
              ? t("settings:hostData_repositoryUrlDescription")
              : t("settings:hostData_addressDescription")
          }
          control={
            <Input
              value={url}
              placeholder={
                backend === "github"
                  ? "github://you/setup"
                  : backend === "s3"
                    ? "s3://bucket/prefix"
                    : "https://…"
              }
              className="sm:w-64"
              onChange={(event) => setUrl(event.target.value)}
            />
          }
        />
        {backend === "s3" ? (
          <>
            <SettingsRow
              title={t("settings:hostData_endpoint")}
              description={t("settings:hostData_endpointDescription")}
              control={
                <Input
                  value={endpoint}
                  placeholder="https://s3.example.com"
                  className="sm:w-64"
                  onChange={(event) => setEndpoint(event.target.value)}
                />
              }
            />
            <SettingsRow
              title={t("settings:hostData_region")}
              description={t("settings:hostData_regionDescription")}
              control={
                <Input
                  value={region}
                  placeholder="us-east-1"
                  className="sm:w-40"
                  onChange={(event) => setRegion(event.target.value)}
                />
              }
            />
          </>
        ) : null}
        {backend === "github" ? (
          <SettingsRow
            title={t("settings:hostData_branch")}
            description={t("settings:hostData_branchDescription")}
            control={
              <Input
                value={branch}
                placeholder="main"
                className="sm:w-40"
                onChange={(event) => setBranch(event.target.value)}
              />
            }
          />
        ) : null}
        <SettingsRow
          title={t("settings:hostData_user")}
          description={t("settings:hostData_userDescription")}
          control={
            <Input
              value={user}
              placeholder={t("settings:hostData_user")}
              className="sm:w-40"
              onChange={(event) => setUser(event.target.value)}
            />
          }
        />
        <SettingsRow
          title={t("settings:hostData_password")}
          description={
            config?.passwordSet
              ? t("settings:hostData_passwordStored")
              : backend === "github"
                ? t("settings:hostData_passwordToken")
                : t("settings:hostData_passwordDescription")
          }
          control={
            <Input
              type="password"
              value={password}
              placeholder={t("settings:hostData_password")}
              className="sm:w-48"
              onChange={(event) => setPassword(event.target.value)}
            />
          }
        />
        <SettingsRow
          title={t("settings:hostData_passphrase")}
          description={
            config?.passphraseSet
              ? t("settings:hostData_passphraseStored")
              : t("settings:hostData_passphraseDescription")
          }
          control={
            <Input
              type="password"
              value={passphrase}
              placeholder={t("settings:hostData_passphrasePlaceholder")}
              className="sm:w-48"
              onChange={(event) => setPassphrase(event.target.value)}
            />
          }
        />
        <SettingsRow
          id="setting-sync-include-signins"
          title={t("settings:hostData_includeSignIns")}
          description={t("settings:hostData_includeSignInsDescription")}
          control={
            <Switch
              checked={keys}
              onCheckedChange={(checked) => setKeys(checked === true)}
              aria-label={t("settings:hostData_includeSignIns")}
            />
          }
        />
        {PART_NAMES.map((part) => (
          <SettingsRow
            key={part}
            title={t(PART_LABEL_KEYS[part])}
            description={t(PART_DESCRIPTION_KEYS[part])}
            control={
              <Switch
                checked={parts[part] !== false}
                onCheckedChange={(checked) =>
                  setParts((previous) => ({ ...previous, [part]: checked === true }))
                }
                aria-label={t(PART_LABEL_KEYS[part])}
              />
            }
          />
        ))}
        <SettingsRow
          title={t("settings:hostData_interval")}
          description={t("settings:hostData_intervalDescription")}
          control={
            <SettingsSegmentedControl
              value={intervalMinutes}
              onValueChange={setIntervalMinutes}
              ariaLabel={t("settings:hostData_interval")}
              options={INTERVALS.map((minutes) => ({
                value: String(minutes),
                label:
                  minutes === -1
                    ? t("settings:hostData_manual")
                    : minutes === 60
                      ? t("settings:host_hoursShort", { hours: 1 })
                      : t("settings:host_minutesShort", { minutes }),
              }))}
            />
          }
        />
        <SettingsRow
          title={t("settings:host_save")}
          description={t("settings:hostData_saveDescription")}
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null || url.trim().length === 0}
                onClick={() => void saveConfig()}
              >
                {busy === "save" ? t("settings:host_saving") : t("settings:host_save")}
              </Button>
              {config?.enabled ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => void saveConfig({ enabled: false })}
                >
                  {t("settings:hostData_turnOff")}
                </Button>
              ) : null}
            </div>
          }
        />
        {error ? <SettingsRow title={t("settings:hostData_error")} description={error} /> : null}
        {notice ? <SettingsRow title={t("settings:hostData_done")} description={notice} /> : null}
      </SettingsSection>

      <SettingsSection title={t("settings:hostData_backups")}>
        <SettingsRow
          title={t("settings:hostData_exportBackup")}
          description={t("settings:hostData_exportBackupDescription")}
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                type="password"
                value={exportPassphrase}
                placeholder={t("settings:hostData_passphrasePlaceholder")}
                className="sm:w-36"
                onChange={(event) => setExportPassphrase(event.target.value)}
              />
              <label className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
                <Switch
                  checked={exportSignIns}
                  onCheckedChange={(checked) => setExportSignIns(checked === true)}
                  aria-label={t("settings:hostData_includeSignInsExport")}
                />
                {t("settings:hostData_signIns")}
              </label>
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void (async () => {
                    setBusy("export");
                    setError(null);
                    const outcome = await attempt(async () => {
                      const result = await exportBackup({
                        ...(exportPassphrase ? { passphrase: exportPassphrase } : {}),
                        signIns: exportSignIns,
                      });
                      if (result.error) throw new Error(result.error);
                      if (!result.backup) throw new Error(t("settings:hostData_noBackupReturned"));
                      await download(result.backup.name);
                      setNotice(t("settings:hostData_exportedFile", { file: result.backup.name }));
                      await refresh();
                    });
                    if (!outcome.ok) setError(errorMessage(outcome.error));
                    setBusy(null);
                  })()
                }
              >
                {busy === "export"
                  ? t("settings:hostData_exporting")
                  : t("settings:hostData_export")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          title={t("settings:hostData_importBackup")}
          description={t("settings:hostData_importBackupDescription")}
          control={
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <Input
                type="password"
                value={importPassphrase}
                placeholder={t("settings:hostData_passphrasePlaceholder")}
                className="sm:w-36"
                onChange={(event) => setImportPassphrase(event.target.value)}
              />
              <label className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
                <Switch
                  checked={importSignIns}
                  onCheckedChange={(checked) => setImportSignIns(checked === true)}
                  aria-label={t("settings:hostData_importSignIns")}
                />
                {t("settings:hostData_signIns")}
              </label>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importFile(file);
                }}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={busy !== null}
                onClick={() => fileInputRef.current?.click()}
              >
                {busy === "import"
                  ? t("settings:hostData_importing")
                  : t("settings:hostData_chooseFile")}
              </Button>
            </div>
          }
        />
        <SettingsRow
          id="setting-sync-auto-backups"
          title={t("settings:hostData_autoBackups")}
          description={
            auto
              ? `${t("settings:hostData_autoSummary", {
                  hours: auto.everyHours,
                  keep: auto.keep,
                })}${auto.folder ? ` ${t("settings:hostData_storedIn", { folder: auto.folder })}` : ""}`
              : t("settings:hostData_notAvailable")
          }
          control={
            <Switch
              checked={auto?.enabled === true}
              disabled={auto === null || busy !== null}
              onCheckedChange={(checked) => {
                if (!auto) return;
                setBusy("auto");
                void setBackupAuto({ ...auto, enabled: checked === true })
                  .then(refresh)
                  .catch((cause: unknown) => setError(errorMessage(cause)))
                  .finally(() => setBusy(null));
              }}
              aria-label={t("settings:hostData_autoBackups")}
            />
          }
        />
        {auto ? (
          <>
            <SettingsRow
              title={t("settings:hostData_autoSignIns")}
              description={t("settings:hostData_autoSignInsDescription")}
              control={
                <Switch
                  checked={auto.signIns === true}
                  disabled={busy !== null}
                  onCheckedChange={(checked) => {
                    setBusy("auto-signins");
                    void setBackupAuto({ ...auto, signIns: checked === true })
                      .then(refresh)
                      .catch((cause: unknown) => setError(errorMessage(cause)))
                      .finally(() => setBusy(null));
                  }}
                  aria-label={t("settings:hostData_autoSignIns")}
                />
              }
            />
            <SettingsRow
              title={t("settings:hostData_backupFolder")}
              description={auto.folder ?? auto.dir ?? t("settings:hostData_defaultFolder")}
              control={
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setEditingFolder((previous) => !previous);
                      setFolder(auto.dir ?? "");
                    }}
                  >
                    {t("settings:hostData_changeFolder")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void revealBackups()
                        .then((result) => {
                          if (!result.ok)
                            throw new Error(result.error ?? t("settings:hostData_hostRefused"));
                        })
                        .catch((cause: unknown) => setError(errorMessage(cause)))
                    }
                  >
                    {t("settings:hostData_showFolder")}
                  </Button>
                  {auto.dir ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        void setBackupAuto({ ...auto, dir: "" })
                          .then(refresh)
                          .catch((cause: unknown) => setError(errorMessage(cause)))
                      }
                    >
                      {t("settings:hostData_default")}
                    </Button>
                  ) : null}
                </div>
              }
            />
            {editingFolder ? (
              <SettingsRow
                title={t("settings:hostData_folderPath")}
                description={t("settings:hostData_folderPathDescription")}
                control={
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <Input
                      value={folder}
                      className="sm:w-64"
                      onChange={(event) => setFolder(event.target.value)}
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy("folder");
                        void setBackupAuto({ ...auto, dir: folder.trim() })
                          .then(() => {
                            setEditingFolder(false);
                            return refresh();
                          })
                          .catch((cause: unknown) => setError(errorMessage(cause)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      {t("settings:host_save")}
                    </Button>
                  </div>
                }
              />
            ) : null}
          </>
        ) : null}
        {backups.length === 0 ? (
          <SettingsEmptyState layout="status">
            {backupsQuery.isLoading ? t("settings:host_loading") : t("settings:hostData_noBackups")}
          </SettingsEmptyState>
        ) : (
          backups.map((backup) => (
            <SettingsListRow
              key={backup.name}
              title={backup.name}
              description={`${formatWhen(backup.at)} · ${formatBytes(backup.size)}${
                backup.auto ? ` · ${t("settings:hostData_automatic")}` : ""
              }`}
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void download(backup.name)}
                  >
                    {t("settings:hostData_saveFile")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setBusy(`restore-${backup.name}`);
                      void restoreBackup({ name: backup.name })
                        .then((result) => {
                          if (result.error) throw new Error(result.error);
                          setNotice(
                            t("settings:hostData_restoredParts", {
                              parts: (result.parts ?? []).join(", ") || backup.name,
                            }),
                          );
                          return refresh();
                        })
                        .catch((cause: unknown) => setError(errorMessage(cause)))
                        .finally(() => setBusy(null));
                    }}
                  >
                    {t("settings:hostData_restore")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      void confirmAction(
                        t("settings:hostData_deleteBackupConfirm", { name: backup.name }),
                        { confirmLabel: t("common:delete"), destructive: true },
                      ).then((sure) => {
                        if (!sure) return;
                        setBusy(`delete-${backup.name}`);
                        void deleteBackup(backup.name)
                          .then((result) => {
                            if (result.error) throw new Error(result.error);
                            return refresh();
                          })
                          .catch((cause: unknown) => setError(errorMessage(cause)))
                          .finally(() => setBusy(null));
                      });
                    }}
                  >
                    {t("settings:hostData_delete")}
                  </Button>
                </div>
              }
            />
          ))
        )}
      </SettingsSection>
    </div>
  );
}
