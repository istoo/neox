import { addWsTransportStateListener, type WsTransportState } from "../../wsTransportEvents";
import { useEffect, useState, useSyncExternalStore } from "react";
import { appHistory } from "../../appNavigation";
import { useHandleNewChat } from "../../hooks/useHandleNewChat";
import { readExecutionContext } from "../../lib/hosts/executionContext";
import { readWorkspaceFrame, workspaceRoute } from "../../lib/hosts/workspaceFrame";
import {
  readWorkspaceSessions,
  subscribeWorkspaceSessions,
} from "../../lib/hosts/workspaceSessions";
import { CheckIcon } from "../../lib/icons";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { useTranslation } from "~/i18n";

export interface ComputerChoice {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly available: boolean;
}

/** Frames read the controller's directory, while commands retain their owning runtime. */
export function useWorkspaceComputers() {
  const { t } = useTranslation();
  const frame = readWorkspaceFrame();
  const context = readExecutionContext();
  const sessions = useSyncExternalStore(
    frame?.controller.subscribe ?? subscribeWorkspaceSessions,
    frame?.controller.sessions ?? readWorkspaceSessions,
    frame?.controller.sessions ?? readWorkspaceSessions,
  );
  const local = frame?.controller.environment ?? context?.controller;
  const localId = local?.environmentId ?? "local";
  const computers: ComputerChoice[] = [
    {
      id: localId,
      label: t("settings:connections_thisComputer"),
      detail: local?.label ?? t("settings:connections_local"),
      available: true,
    },
    ...sessions.map((session) => ({
      id: session.host.executionScope.environmentId,
      label: session.host.hostName,
      detail: session.error
        ? t("settings:connections_unavailable")
        : session.summary?.state === "open"
          ? t("settings:connections_connected")
          : t("settings:connections_reconnecting"),
      available: !session.error && Boolean(session.navigation) && session.summary?.state === "open",
    })),
  ];
  const navigate = (path: string) => {
    if (frame) frame.controller.navigate(path);
    else appHistory.push(path);
  };
  return {
    computers,
    sessions,
    localId,
    currentId: context?.execution.environmentId ?? localId,
    navigate,
  };
}

export function ComputerPicker({
  computers,
  value,
  disabled,
  onChange,
  onManage,
  purpose,
}: {
  computers: readonly ComputerChoice[];
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  onManage?: (() => void) | undefined;
  purpose?: string;
}) {
  const { t } = useTranslation();
  const resolvedPurpose = purpose ?? t("settings:connections_computerPurpose");
  const selected = computers.find((computer) => computer.id === value);
  if (!onManage && computers.length === 1)
    return <span className="text-ui text-foreground">{selected?.label}</span>;
  return (
    <Menu>
      <MenuTrigger
        render={
          <PickerTriggerButton
            icon={null}
            label={selected?.label ?? t("settings:connections_computerUnavailableSelect")}
            aria-label={t("settings:connections_computerAriaLabel", {
              purpose: resolvedPurpose,
              computer: selected?.label ?? t("settings:connections_unavailableLower"),
            })}
            title={selected?.detail}
            variant="ghost"
            disabled={disabled}
          />
        }
      />
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-72">
        <p className="px-2 py-1.5 text-ui-xs text-muted-foreground">{resolvedPurpose}</p>
        {computers.map((computer) => (
          <MenuItem
            key={computer.id}
            disabled={!computer.available}
            onClick={() => onChange(computer.id)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{computer.label}</span>
              <span className="block truncate text-ui-xs text-muted-foreground">
                {computer.detail}
              </span>
            </span>
            {computer.id === value ? <CheckIcon className="size-3.5 shrink-0" /> : null}
          </MenuItem>
        ))}
        {onManage ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={onManage}>
              {t("settings:connections_connectComputerEllipsis")}
            </MenuItem>
          </>
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Open the selected computer's overview without carrying another owner's IDs or filters. */
export function WorkspaceSurfaceComputerPicker({
  path,
}: {
  path: "/tasks" | "/kanban" | "/inbox" | "/pull-requests";
}) {
  const { t } = useTranslation();
  const { computers, localId, currentId, navigate } = useWorkspaceComputers();
  const frame = readWorkspaceFrame();
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  const select = (environmentId: string) => {
    if (environmentId === currentId) return;
    if (environmentId === localId) {
      navigate(path);
      return;
    }
    const session = (frame?.controller.sessions ?? readWorkspaceSessions)().find(
      (item) => item.host.executionScope.environmentId === environmentId,
    );
    if (!session?.navigation || session.error || session.summary?.state !== "open") {
      toastManager.add({
        type: "error",
        title: t("settings:connections_computerUnavailableSelect"),
        description: t("settings:connections_reconnectInConnections"),
      });
      return;
    }
    navigate(workspaceRoute(environmentId, path));
  };
  return (
    <div className="min-w-0 [-webkit-app-region:no-drag]">
      <ComputerPicker
        computers={computers}
        value={currentId}
        onChange={select}
        onManage={() => navigate("/settings?section=connections")}
      />
    </div>
  );
}

type WorkspaceSessions = ReturnType<typeof useWorkspaceComputers>["sessions"];
type NewChatHandler = ReturnType<typeof useHandleNewChat>["handleNewChat"];

interface SelectComputerOptions {
  readonly environmentId: string;
  readonly localId: string;
  readonly frame: ReturnType<typeof readWorkspaceFrame>;
  readonly sessions: WorkspaceSessions;
  readonly navigate: (path: string) => void;
  readonly handleNewChat: NewChatHandler;
  readonly reportError: (error: unknown) => void;
  readonly setBusy: (busy: boolean) => void;
}

async function selectComputer({
  environmentId,
  localId,
  frame,
  sessions,
  navigate,
  handleNewChat,
  reportError,
  setBusy,
}: SelectComputerOptions): Promise<void> {
  setBusy(true);
  try {
    if (environmentId === localId) {
      if (frame) navigate(await frame.controller.newChat());
      else {
        const result = await handleNewChat();
        if (!result.ok) throw new Error(result.error);
      }
    } else {
      const session = sessions.find(
        (item) => item.host.executionScope.environmentId === environmentId,
      );
      const navigation = session?.navigation;
      if (!navigation || session?.summary?.state !== "open")
        throw new Error("This computer is not connected.");
      const path = await navigation.newChat();
      const current = (frame?.controller.sessions ?? readWorkspaceSessions)();
      if (!current.some((item) => item.host === session.host && item.navigation === navigation))
        throw new Error("The connection changed. Choose the computer again.");
      navigate(workspaceRoute(environmentId, path));
    }
  } catch (error) {
    reportError(error);
  } finally {
    setBusy(false);
  }
}

/** Selecting another computer opens its own draft; it never migrates the current one. */
export function NewChatComputerPicker() {
  const { t } = useTranslation();
  const { computers, sessions, localId, currentId, navigate } = useWorkspaceComputers();
  const { handleNewChat } = useHandleNewChat();
  const [busy, setBusy] = useState(false);
  const frame = readWorkspaceFrame();
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return null;
  const select = async (environmentId: string) => {
    if (busy || environmentId === currentId) return;
    await selectComputer({
      environmentId,
      localId,
      frame,
      sessions,
      navigate,
      handleNewChat,
      reportError: (error) => {
        toastManager.add({
          type: "error",
          title: t("workspace:couldNotOpenChat"),
          description: error instanceof Error ? error.message : t("chat:tryAgain"),
        });
      },
      setBusy,
    });
  };
  return (
    <ComputerPicker
      computers={computers}
      value={currentId}
      disabled={busy}
      purpose={t("automation:runOn")}
      onChange={(id) => void select(id)}
      onManage={() => navigate("/settings?section=connections")}
    />
  );
}

/** Task ownership belongs beside its title, independently of the selected sidebar section. */
export function ChatComputerLabel() {
  const context = readExecutionContext();
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(
    () =>
      context?.remote ? addWsTransportStateListener(setState, { replayCurrent: true }) : undefined,
    [context],
  );
  if (!context?.remote) return null;
  const status =
    state === "open" ? "Connected" : state === "incompatible" ? "Update required" : "Reconnecting…";
  return (
    <span
      className="min-w-0 max-w-40 truncate text-ui-xs text-muted-foreground"
      title={`${context.execution.label} · ${status}`}
      aria-label={`Computer: ${context.execution.label}. ${status}`}
    >
      {context.execution.label}
      {state === "open" ? null : ` · ${status}`}
    </span>
  );
}
