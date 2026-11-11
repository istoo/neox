// FILE: ConnectionsOtherComputers.tsx
// Purpose: "Control other devices" — confirmed pairings on this controller,
//          the window's current destination, and adding a computer.
// Layer: Settings UI components
// Exports: ConnectionsOtherComputers

import type { AccountHost, HostConnection } from "@synara/contracts";
import { useCallback, useState } from "react";

import { useHostConnections, useHosts } from "~/hooks/useHosts";
import { useAppSettings } from "~/appSettings";
import { accountErrorMessage } from "~/lib/accountLogic";
import {
  HOST_BADGE_DISPLAYS,
  HOST_COLORS,
  hostColorValue,
  readHostAppearance,
  type HostBadgeDisplay,
  type HostColor,
} from "~/lib/hosts/appearance";
import {
  activateHost,
  deactivateHost,
  readActiveHost,
  type ActiveHost,
} from "~/lib/hosts/activeHost";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { ensureHostsApi, readHostsApi } from "~/lib/hosts/api";
import { NEOLIX_ACCOUNT_UI_ENABLED } from "~/neolixFeatures";
import { HostsUnsupportedError } from "~/lib/hosts/queries";
import type { HostReachability } from "~/lib/hosts/reachability";
import { callRemoteAccess } from "~/lib/hosts/remoteAccess";
import { prepareWorkspaceSessionRemoval } from "~/lib/hosts/workspaceSessions";
import { RotateCcwIcon } from "~/lib/icons";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import { HostConnectionControl } from "../hosts/HostConnectionControl";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { ConnectionsAddComputerDialog } from "./ConnectionsAddComputerDialog";
import { HostRow } from "./ConnectionsRows";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

function connectionHost(connection: HostConnection): ActiveHost {
  return {
    ...(connection.executionScope ? { executionScope: connection.executionScope } : {}),
    hostId: connection.hostId,
    hostName: connection.hostName,
    wsPath: connection.wsPath,
  };
}

/** Rendered only when signed in with remote connections available. */
export function ConnectionsOtherComputers() {
  const { t } = useTranslation();
  const remote = useHosts({ enabled: true });
  const connections = useHostConnections({ enabled: true });
  const activeHost = readActiveHost();
  const { settings, updateSettings } = useAppSettings();
  const [addOpen, setAddOpen] = useState(false);
  // Reachability is attempt-based (ADR 0010): the map holds what the LAST
  // probe said, per host, and a host nobody probed simply is not in it.
  const [reachability, setReachability] = useState<Readonly<Record<string, HostReachability>>>({});
  const [renaming, setRenaming] = useState<AccountHost | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [appearanceHost, setAppearanceHost] = useState<AccountHost | null>(null);
  const check = readHostsApi()?.checkReachability;

  const refresh = () => {
    void remote.hostsQuery.refetch();
    void remote.enrollmentQuery.refetch();
    void connections.connectionsQuery.refetch();
  };

  const probeHost = useCallback(
    async (host: AccountHost) => {
      if (!check) return;
      setReachability((current) => ({ ...current, [host.id]: { state: "probing" } }));
      try {
        const result = await check({ hostId: host.id });
        setReachability((current) => ({ ...current, [host.id]: result }));
      } catch {
        setReachability((current) => ({
          ...current,
          [host.id]: { state: "no-answer", at: Date.now() },
        }));
      }
    },
    [check],
  );

  const fail = (
    title: string,
    cause: unknown,
    fallback = t("settings:connections_tryAgainMoment"),
  ) =>
    toastManager.add({ type: "error", title, description: accountErrorMessage(cause, fallback) });

  /** Open a session to the host and add its projects alongside the local workspace. */
  const connectToHost = async (host: AccountHost) => {
    try {
      const connection = await connections.connect.mutateAsync({ hostId: host.id });
      await activateHost(connectionHost(connection));
    } catch (cause) {
      fail(
        t("settings:connections_couldNotConnect", { value0: host.name }),
        cause,
        t("settings:connections_hostOffline"),
      );
    }
  };

  const closeHost = async (hostId: string, close: () => Promise<unknown>, failure: string) => {
    let removal: ReturnType<typeof prepareWorkspaceSessionRemoval>;
    try {
      removal = prepareWorkspaceSessionRemoval(hostId);
    } catch (cause) {
      fail(
        t("settings:connections_couldNotPreserveDrafts"),
        cause,
        t("settings:connections_preserveDraftsDescription"),
      );
      return;
    }
    try {
      const persisted = await removal.close(close);
      if (!persisted)
        toastManager.add({
          type: "warning",
          title: t("settings:connections_connectionClosed"),
          description: t("settings:connections_connectionClosedDescription"),
        });
    } catch (cause) {
      fail(failure, cause);
      return;
    }
    refresh();
  };

  const disconnectFromHost = (hostId: string) =>
    closeHost(
      hostId,
      () => connections.disconnect.mutateAsync({ hostId }),
      t("settings:connections_couldNotDisconnect"),
    );

  const forgetHost = async (host: AccountHost) => {
    const confirmed = await (readNativeApi() ?? ensureNativeApi()).dialogs.confirm(
      t("settings:connections_forgetConfirm", { value0: host.name }),
    );
    if (!confirmed) return;
    await closeHost(
      host.id,
      () => callRemoteAccess({ operation: "forget-host", environmentId: host.environmentId }),
      t("settings:connections_couldNotForget", { value0: host.name }),
    );
  };

  const startRename = (host: AccountHost) => {
    setRenameValue(host.name);
    setRenaming(host);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name || name === renaming.name) {
      setRenaming(null);
      return;
    }
    try {
      await ensureHostsApi().updateHost({ hostId: renaming.id, name });
      setRenaming(null);
      refresh();
    } catch (cause) {
      fail(t("settings:connections_couldNotRename"), cause);
    }
  };

  const appearanceFor = (hostId: string) => readHostAppearance(settings.hostAppearance, hostId);
  const setAppearance = (
    hostId: string,
    patch: { color?: HostColor; badgeDisplay?: HostBadgeDisplay },
  ) => {
    const current = appearanceFor(hostId);
    updateSettings({
      hostAppearance: {
        ...settings.hostAppearance,
        [hostId]: { ...current, ...patch },
      },
    });
  };

  const hostsError = remote.hostsQuery.error ?? connections.connectionsQuery.error;
  const localHostId = remote.enrollment?.host?.id;
  const localEnvironmentId = readExecutionContext()?.controller.environmentId;
  // Account registration is not pairing. Only show identities trusted by this
  // controller; never collapse independent installations by their display name.
  const pairedHosts = connections.pairedHosts;
  const hosts = remote.hosts.filter(
    (host) =>
      host.id !== localHostId &&
      host.environmentId !== localEnvironmentId &&
      pairedHosts?.some(
        (paired) => paired.hostId === host.id && paired.environmentId === host.environmentId,
      ),
  );

  return (
    <>
      <SettingsSectionShell
        title={t("settings:connections_computersYouControl")}
        action={
          <div className="flex items-center gap-1.5">
            <IconButton label={t("settings:connections_refresh")} variant="ghost" onClick={refresh}>
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
            <Button size="xs" shape="capsule" onClick={() => setAddOpen(true)}>
              {t("settings:connections_add")}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          {remote.hostsQuery.isPending || connections.connectionsQuery.isPending ? (
            <SettingsListRow title={<Muted>{t("settings:connections_loadingComputers")}</Muted>} />
          ) : hostsError ? (
            <SettingsListRow
              title={t("settings:connections_computersUnavailable")}
              description={
                <span className="text-destructive">
                  {hostsError instanceof HostsUnsupportedError
                    ? t("settings:connections_serverTooOld")
                    : accountErrorMessage(
                        hostsError,
                        t("settings:connections_loadComputersFailed"),
                      )}
                </span>
              }
            />
          ) : pairedHosts === undefined ? (
            <SettingsListRow
              title={t("settings:connections_updateNeolix")}
              description={t("settings:connections_updateNeolixDescription")}
            />
          ) : hosts.length === 0 ? (
            <SettingsListRow
              title={<Muted>{t("settings:connections_noOtherComputers")}</Muted>}
              description={
                NEOLIX_ACCOUNT_UI_ENABLED
                  ? t("settings:connections_clickAddCode")
                  : t("settings:connections_clickAddLink")
              }
            />
          ) : (
            hosts.map((host) => {
              const connection = connections.connections.find((entry) => entry.hostId === host.id);
              return (
                <HostRow
                  key={host.id}
                  host={host}
                  reachability={reachability[host.id] ?? { state: "unknown" }}
                  appearance={appearanceFor(host.id)}
                  busy={remote.setDiscoverable.isPending}
                  connection={
                    connection
                      ? {
                          kind: "connected",
                          transport: connection.transport,
                          active: activeHost?.hostId === host.id,
                          busy: connections.disconnect.isPending,
                        }
                      : { kind: "disconnected", busy: connections.connect.isPending }
                  }
                  {...(check ? { onProbe: () => void probeHost(host) } : {})}
                  onToggleDiscoverable={(discoverable) =>
                    void remote.setDiscoverable
                      .mutateAsync({ hostId: host.id, discoverable })
                      .catch((cause: unknown) =>
                        fail(
                          discoverable
                            ? t("settings:connections_couldNotShare")
                            : t("settings:connections_couldNotStopSharing"),
                          cause,
                        ),
                      )
                  }
                  onConnect={() => void connectToHost(host)}
                  onDisconnect={() => void disconnectFromHost(host.id)}
                  onActivate={() => void connectToHost(host)}
                  onDeactivate={() => deactivateHost()}
                  onForget={() => void forgetHost(host)}
                  onRename={() => startRename(host)}
                  onAppearance={() => setAppearanceHost(host)}
                />
              );
            })
          )}
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title={t("settings:connections_thisWindow")}>
        <SettingsCard className="p-1">
          <HostConnectionControl />
        </SettingsCard>
      </SettingsSectionShell>

      <ConnectionsAddComputerDialog open={addOpen} onOpenChange={setAddOpen} onPaired={refresh} />

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        {renaming ? (
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("settings:connections_renameComputer")}</DialogTitle>
              <DialogDescription>{t("settings:connections_renameDescription")}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <Input
                value={renameValue}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                }}
              />
            </DialogPanel>
            <DialogFooter>
              <Button shape="capsule" variant="subtle" onClick={() => setRenaming(null)}>
                {t("common:form_cancel")}
              </Button>
              <Button shape="capsule" onClick={() => void submitRename()}>
                {t("settings:connections_save")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>

      <Dialog
        open={appearanceHost !== null}
        onOpenChange={(open) => !open && setAppearanceHost(null)}
      >
        {appearanceHost ? (
          <DialogPopup className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{t("settings:connections_appearanceTitle")}</DialogTitle>
              <DialogDescription>
                {t("settings:connections_appearanceDescription", { value0: appearanceHost.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              <div className="space-y-2">
                <p className="text-ui-sm font-medium">{t("settings:connections_color")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {HOST_COLORS.map((color) => {
                    const value = hostColorValue(color);
                    const selected = appearanceFor(appearanceHost.id).color === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        aria-label={t(`settings:connections_color_${color}`)}
                        aria-pressed={selected}
                        className={`flex size-7 items-center justify-center rounded-full border transition-colors ${
                          selected ? "border-foreground" : "border-border"
                        }`}
                        onClick={() => setAppearance(appearanceHost.id, { color })}
                      >
                        {value ? (
                          <span
                            className="size-4 rounded-full"
                            style={{ backgroundColor: value }}
                          />
                        ) : (
                          <span className="text-ui-xs text-muted-foreground">—</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-ui-sm font-medium">{t("settings:connections_badge")}</p>
                <div className="flex flex-wrap gap-1.5">
                  {HOST_BADGE_DISPLAYS.map((badge) => (
                    <Button
                      key={badge}
                      size="xs"
                      shape="capsule"
                      variant={
                        appearanceFor(appearanceHost.id).badgeDisplay === badge
                          ? "default"
                          : "subtle"
                      }
                      onClick={() => setAppearance(appearanceHost.id, { badgeDisplay: badge })}
                    >
                      {t(`settings:connections_badge_${badge}`)}
                    </Button>
                  ))}
                </div>
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:connections_badgeDescription")}
                </p>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button shape="capsule" onClick={() => setAppearanceHost(null)}>
                {t("settings:connections_done")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

function Muted({ children }: { children: string }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}
