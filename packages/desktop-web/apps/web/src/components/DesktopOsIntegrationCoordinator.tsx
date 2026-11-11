// FILE: DesktopOsIntegrationCoordinator.tsx
// Purpose: Consumes the Electron shell's OS-level hand-offs the new UI replaces:
//          opening a project passed on the command line, agent deep links, the
//          Dock badge, and mirroring the UI language onto the tray menu.
// Layer: Root web coordinator

import { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { findWorkspaceRootMatch } from "~/components/Sidebar.logic";
import { useAppSettings } from "~/appSettings";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { t } from "~/i18n";
import { countDesktopBadgeThreads } from "~/lib/desktopBadge";
import { getHostStatus } from "~/lib/neolixHostApi";
import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

interface AgentNavigationPayload {
  readonly serverId?: unknown;
  readonly agentId?: unknown;
}

function latestThreadIdForProject(projectId: string): string | null {
  const store = useStore.getState();
  const threads = Object.values(store.sidebarThreadSummaryById ?? {}).filter(
    (thread) => thread.projectId === projectId && !thread.archivedAt,
  );
  threads.sort((left, right) =>
    (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt),
  );
  return threads[0]?.id ?? null;
}

export function DesktopOsIntegrationCoordinator() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const [allThreadsSelector] = useState(() => createAllThreadsSelector());
  const threads = useStore(allThreadsSelector);
  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null);
  const pendingProjectReadRef = useRef(false);
  const localServerIdRef = useRef<string | null | undefined>(undefined);
  const lastBadgeCountRef = useRef<number | null>(null);

  // The main process hands each window its own pending project on mount; a
  // second window (or a second-instance launch) pulls its own copy.
  useEffect(() => {
    if (pendingProjectReadRef.current) return;
    const read = window.neolixDesktop?.getPendingOpenProject;
    if (typeof read !== "function") return;
    pendingProjectReadRef.current = true;
    let disposed = false;
    void read()
      .then((path) => {
        if (!disposed && typeof path === "string" && path.trim() !== "") {
          setPendingProjectPath(path.trim());
        }
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const openProjectPath = useCallback(
    async (path: string) => {
      const api = ensureNativeApi();
      const existing = findWorkspaceRootMatch(
        useStore.getState().projects,
        path,
        (project) => project.cwd,
      );
      if (existing) {
        const threadId = latestThreadIdForProject(existing.id);
        if (threadId) {
          await navigate({ to: "/$threadId", params: { threadId } });
          return;
        }
        const created = await handleNewThread(existing.id).catch(() => null);
        if (created) await navigate({ to: "/$threadId", params: { threadId: created } });
        return;
      }

      const result = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot: path,
        defaultProvider: settings.defaultProvider,
        loadSnapshot: () => api.orchestration.getShellSnapshot(),
      });
      if (result.snapshot) useStore.getState().syncServerShellSnapshot(result.snapshot);
      if (!result.project) {
        throw new Error(t("settings:desktop_projectStillSyncing"));
      }
      const threadId = await handleNewThread(result.project.id).catch(() => null);
      if (!threadId) {
        throw new Error(t("settings:desktop_projectCouldNotOpen"));
      }
      await navigate({ to: "/$threadId", params: { threadId } });
    },
    [handleNewThread, navigate, settings.defaultProvider],
  );

  useEffect(() => {
    if (!pendingProjectPath || !threadsHydrated) return;
    const path = pendingProjectPath;
    setPendingProjectPath(null);
    void openProjectPath(path).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: t("settings:desktop_couldNotOpenProject"),
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, [openProjectPath, pendingProjectPath, threadsHydrated]);

  const openAgent = useCallback(
    async (payload: AgentNavigationPayload | null) => {
      const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
      const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
      if (!serverId || !agentId) return;
      const store = useStore.getState();
      const knownLocally =
        (store.threadIds ?? []).includes(ThreadId.makeUnsafe(agentId)) ||
        store.sidebarThreadSummaryById?.[agentId] !== undefined;
      if (localServerIdRef.current === undefined) {
        localServerIdRef.current = await getHostStatus()
          .then((status) => status.serverId)
          .catch(() => null);
      }
      if (knownLocally || localServerIdRef.current === serverId) {
        await navigate({
          to: "/$threadId",
          params: { threadId: ThreadId.makeUnsafe(agentId) },
        });
        return;
      }
      toastManager.add({
        type: "warning",
        title: t("settings:desktop_agentOnAnotherComputer"),
      });
    },
    [navigate],
  );

  useEffect(() => {
    const host = window.neolixDesktop;
    const subscribe = host?.events?.on;
    const ready = host?.agentNavigation?.ready;
    if (typeof subscribe !== "function") return;
    let disposed = false;
    let unsubscribe: (() => void) | null = null;
    const receive = (payload: unknown) => {
      void openAgent((payload ?? null) as AgentNavigationPayload | null);
    };
    void subscribe("open-agent", receive)
      .then((stop) => {
        if (disposed) stop();
        else unsubscribe = stop;
        return undefined;
      })
      .catch(() => undefined);
    if (typeof ready === "function") {
      void ready()
        .then((pending) => {
          if (!disposed && pending) receive(pending);
          return undefined;
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [openAgent]);

  const actionableThreads = useMemo(
    () =>
      threads
        .filter((thread) => !thread.archivedAt)
        .map((thread) => ({
          archivedAt: thread.archivedAt,
          parentThreadId: thread.parentThreadId,
          sessionStatus: thread.session?.status ?? null,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
          hasActionableProposedPlan: thread.hasActionableProposedPlan,
        })),
    [threads],
  );
  const badgeCount = useMemo(
    () => countDesktopBadgeThreads(actionableThreads),
    [actionableThreads],
  );

  useEffect(() => {
    const setBadgeCount = window.neolixDesktop?.window?.getCurrentWindow?.()?.setBadgeCount;
    if (typeof setBadgeCount !== "function") return;
    if (lastBadgeCountRef.current === badgeCount) return;
    lastBadgeCountRef.current = badgeCount;
    void setBadgeCount(badgeCount > 0 ? badgeCount : undefined).catch(() => undefined);
  }, [badgeCount]);

  // The tray menu is built in the main process; mirroring the UI language keeps
  // it in step even before a window exists next launch (the shell persists it).
  const language = settings.language;
  useEffect(() => {
    const invoke = window.neolixDesktop?.invoke;
    if (typeof invoke !== "function") return;
    void invoke("desktop_set_tray_language", {
      language: language === "system" ? "" : language,
    }).catch(() => undefined);
  }, [language]);

  return null;
}
