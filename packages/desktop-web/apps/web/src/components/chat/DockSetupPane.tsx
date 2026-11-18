// FILE: DockSetupPane.tsx
// Purpose: Right-dock pane that shows a workspace's worktree setup output live and lets
//          the user run setup again. Mirrors the app's setup panel states: running,
//          completed, failed, blocked, and a workspace with no setup commands.
// Layer: Chat right-dock UI
// Exports: DockSetupPane

import type { WorkspaceSetupEvent, WorkspaceSetupSnapshot } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Loader2Icon,
  RefreshCwIcon,
  TerminalIcon,
} from "~/lib/icons";
import { HostUpdateNotice } from "~/components/hosts/HostUpdateNotice";
import { useHostFeatures } from "~/hooks/useHostFeatures";
import { HOST_FEATURES } from "~/lib/hostFeatures.logic";
import { readNativeApi } from "~/nativeApi";
import { Button } from "../ui/button";
import { useTranslation } from "~/i18n";
import {
  formatSetupDuration,
  processSetupCarriageReturns,
  setupAutoExpandIndex,
  setupCommandIsExpandable,
  setupHasNoCommands,
  setupStatusLabel,
} from "./workspaceSetup.logic";

type SetupCommand = WorkspaceSetupSnapshot["detail"]["commands"][number];

function StatusIcon({ status }: { status: string }) {
  if (status === "running") {
    return <Loader2Icon className="size-3.5 shrink-0 motion-safe:animate-spin" />;
  }
  if (status === "completed") {
    return <CircleCheckIcon className="size-3.5 shrink-0 text-[var(--color-success)]" />;
  }
  return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
}

function SetupCommandRow(props: {
  command: SetupCommand;
  showDetail: boolean;
  onToggle: () => void;
}) {
  const { command } = props;
  const { t } = useTranslation();
  const expandable = setupCommandIsExpandable(command);
  const log = command.log?.trim() ? processSetupCarriageReturns(command.log) : "";

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui leading-snug hover:bg-[var(--color-background-button-secondary-hover)]/45"
        onClick={props.onToggle}
        aria-expanded={props.showDetail}
        disabled={!expandable}
      >
        <StatusIcon status={command.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">{command.command}</span>
        {command.durationMs !== undefined ? (
          <span className="shrink-0 text-ui-sm text-[var(--color-text-foreground-secondary)]">
            {formatSetupDuration(command.durationMs)}
          </span>
        ) : null}
        <ChevronRightIcon
          className={`size-3.5 shrink-0 text-[var(--color-text-foreground-secondary)] transition-transform ${
            props.showDetail ? "rotate-90" : ""
          }`}
        />
      </button>
      {props.showDetail ? (
        <div className="border-t border-border/60 bg-[var(--color-background-elevated)]/45 px-3 py-2">
          {log ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm leading-relaxed">
              {log}
            </pre>
          ) : (
            <p className="text-ui-sm text-[var(--color-text-foreground-secondary)]">
              {t("workspace:setupLogEmpty")}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function DockSetupPane(props: { workspaceId: string | null }) {
  const { t } = useTranslation();
  const hostFeatures = useHostFeatures();
  // Setup output arrives over an owned observation; an older host has none to subscribe to.
  const setupAvailable = hostFeatures.isAvailable(HOST_FEATURES.workspaceSetupObservation);
  const [snapshot, setSnapshot] = useState<WorkspaceSetupSnapshot | null>(null);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSnapshot(null);
    setSubscribeError(null);
    setRunError(null);
    const workspaceId = props.workspaceId;
    if (!workspaceId || !setupAvailable) return;
    const api = readNativeApi();
    const workspaceSetup = api?.neolix?.workspaceSetup;
    if (!workspaceSetup) {
      setSubscribeError(t("workspace:setupUnsupported"));
      return;
    }
    let detach: (() => void) | undefined;
    try {
      detach = workspaceSetup.subscribe({ workspaceId }, (event: WorkspaceSetupEvent) => {
        if (event.workspaceId !== workspaceId) return;
        if (event.error) setSubscribeError(event.error);
        if (event.snapshot) setSnapshot(event.snapshot);
      });
    } catch (error) {
      setSubscribeError(error instanceof Error ? error.message : String(error));
    }
    return () => detach?.();
  }, [props.workspaceId, setupAvailable, t]);

  const status = setupStatusLabel(snapshot);
  const statusText = useMemo(() => {
    if (status === "running") return t("workspace:setupRunning");
    if (status === "completed") return t("workspace:setupCompleted");
    if (status === "failed") return t("workspace:setupFailed");
    if (status === "blocked") return t("workspace:setupBlocked");
    return t("workspace:setupWaiting");
  }, [status, t]);

  const autoExpandIndex = setupAutoExpandIndex(snapshot);
  const commands = snapshot?.detail.commands ?? [];
  const noCommands = setupHasNoCommands(snapshot);
  const waiting = !snapshot || (snapshot.status === "running" && commands.length === 0);

  const toggle = useCallback(
    (index: number) => {
      const isAutoExpanded = index === autoExpandIndex && !collapsed.has(index);
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(index) || isAutoExpanded) {
          next.delete(index);
          if (isAutoExpanded) setCollapsed((current) => new Set(current).add(index));
        } else {
          next.add(index);
          setCollapsed((current) => {
            const updated = new Set(current);
            updated.delete(index);
            return updated;
          });
        }
        return next;
      });
    },
    [autoExpandIndex, collapsed],
  );

  const rerun = useCallback(async () => {
    const workspaceId = props.workspaceId;
    const workspaceSetup = readNativeApi()?.neolix?.workspaceSetup;
    if (!workspaceId || !workspaceSetup) return;
    setRunError(null);
    setRunning(true);
    try {
      const result = await workspaceSetup.run({ workspaceId });
      if (result.error) setRunError(result.error);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  }, [props.workspaceId]);

  if (!props.workspaceId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-ui text-[var(--color-text-foreground-secondary)]">
        {t("workspace:setupNoWorkspace")}
      </div>
    );
  }

  if (hostFeatures.featureStatus(HOST_FEATURES.workspaceSetupObservation) === "unavailable") {
    return (
      <div className="p-3">
        <HostUpdateNotice />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="workspace-setup-pane">
      <div className="flex items-center gap-2 border-b border-border/65 px-3 py-2">
        <TerminalIcon className="size-4 shrink-0 text-[var(--color-text-foreground-secondary)]" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">
          {t("workspace:setupPanelTitle")}
        </span>
        <span className="shrink-0 text-ui-sm text-[var(--color-text-foreground-secondary)]">
          {statusText}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          onClick={() => void rerun()}
          aria-label={t("workspace:setupRerun")}
        >
          <RefreshCwIcon className="size-3.5" />
          {running ? t("workspace:setupRerunning") : t("workspace:setupRerun")}
        </Button>
      </div>

      {subscribeError ? (
        <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui leading-snug">
          {subscribeError}
        </div>
      ) : null}
      {runError ? (
        <div className="mx-3 mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui leading-snug">
          {runError}
        </div>
      ) : null}

      {snapshot?.status === "blocked" && snapshot.blockedSource ? (
        <div className="m-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-ui leading-snug">
          <p className="font-medium">{t("workspace:setupBlockedTitle")}</p>
          <p>
            {t("workspace:setupBlockedDescription", {
              repository: snapshot.blockedSource.headRepository,
            })}
          </p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {waiting ? (
          <div className="flex h-full items-center justify-center gap-2 p-6 text-ui text-[var(--color-text-foreground-secondary)]">
            <Loader2Icon className="size-4 motion-safe:animate-spin" />
            {t("workspace:setupWaiting")}
          </div>
        ) : noCommands ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-ui text-[var(--color-text-foreground-secondary)]">
            {t("workspace:setupNoCommands")}
          </div>
        ) : (
          <>
            {commands.map((command) => {
              const isAutoExpanded =
                command.index === autoExpandIndex && !collapsed.has(command.index);
              const showDetail = expanded.has(command.index) || isAutoExpanded;
              return (
                <SetupCommandRow
                  key={`${command.index}:${command.command}`}
                  command={command}
                  showDetail={showDetail}
                  onToggle={() => toggle(command.index)}
                />
              );
            })}
            {snapshot.error && !commands.some((command) => command.status === "failed") ? (
              <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui leading-snug">
                <pre className="whitespace-pre-wrap break-words font-mono text-ui-sm">
                  {snapshot.error}
                </pre>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
