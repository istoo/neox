// FILE: ConnectionsThisComputer.tsx
// Purpose: "Control this Mac" — the owner's allow switch, the devices trusted to
//          control this computer, keep-awake, and an Advanced disclosure with the
//          account's devices, live sessions, and this machine's account link.
// Layer: Settings UI components
// Exports: ConnectionsThisComputer

import type {
  AccountDevice,
  HostSession,
  RemoteAccessRequest,
  RemoteTrustedDevice,
} from "@synara/contracts";
import { type ReactNode, useEffect, useState } from "react";

import { useAccount } from "~/hooks/useAccount";
import { reportRemoteAccessAllowed, useDesktopKeepAwake } from "~/hooks/useDesktopKeepAwake";
import { useDevices, useHosts, useHostSessions } from "~/hooks/useHosts";
import { useRemoteHostState } from "~/hooks/useRemoteHostState";
import { accountErrorMessage } from "~/lib/accountLogic";
import { readHostsApi } from "~/lib/hosts/api";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import { NEOLIX_ACCOUNT_UI_ENABLED } from "~/neolixFeatures";
import {
  activeTrustedDevices,
  callRemoteAccess,
  pendingApprovals,
  remoteAccessErrorMessage,
} from "~/lib/hosts/remoteAccess";
import { RotateCcwIcon } from "~/lib/icons";
import { ensureNativeApi, readNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { IconButton } from "../ui/icon-button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ConnectionsAddDeviceDialog } from "./ConnectionsAddDeviceDialog";
import { DeviceRow, SessionRow, TrustedDeviceRow } from "./ConnectionsRows";
import { useHostConfig } from "./hostSettingsModel";
import {
  SettingsCard,
  SettingsListRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

function confirmAction(message: string): Promise<boolean> {
  return (readNativeApi() ?? ensureNativeApi()).dialogs.confirm(message);
}

/** Rendered only when signed in with remote connections available. */
export function ConnectionsThisComputer({
  computerNoun,
  onRefreshBilling,
  onViewProPlans,
}: {
  /** "Mac" on macOS, "computer" elsewhere. */
  computerNoun: string;
  onRefreshBilling?: (() => void) | undefined;
  onViewProPlans?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const { state, loadError, refresh } = useRemoteHostState();
  const hostConfig = useHostConfig(true);
  const relay = hostConfig.config?.relay;
  // Older configs omit relay.enabled; the daemon's own default is on.
  const relayEnabled = relay?.enabled !== false;
  const requireProtected = relay?.requireProtectedSecurity === true;
  const relayDisabled =
    hostConfig.isLoading || hostConfig.saving || hostConfig.config === undefined;
  const keepAwake = useDesktopKeepAwake();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allowOverride, setAllowOverride] = useState<boolean | null>(null);
  const [dialog, setDialog] = useState<"add" | "review" | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedSeen, setAdvancedSeen] = useState(false);

  const allowConnections = state ? (state.allowConnections ?? true) : null;
  useEffect(() => {
    if (allowConnections !== null) reportRemoteAccessAllowed(allowConnections);
  }, [allowConnections]);

  const perform = async (request: RemoteAccessRequest, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await callRemoteAccess(request);
      await refresh();
    } catch (cause) {
      setError(remoteAccessErrorMessage(cause, failure));
    }
    setBusy(false);
  };

  const setAllow = async (enabled: boolean) => {
    setAllowOverride(enabled);
    await perform(
      { operation: "set-allow-connections", enabled },
      enabled ? t("settings:connections_allowFailed") : t("settings:connections_disallowFailed"),
    );
    setAllowOverride(null);
  };

  const revoke = async (device: RemoteTrustedDevice) => {
    if (
      !(await confirmAction(
        t("settings:connections_revokeAccessConfirm", {
          value0: device.label,
          value1: computerNoun,
        }),
      ))
    )
      return;
    await perform(
      { operation: "revoke-device", deviceJkt: device.deviceJkt },
      t("settings:connections_revokeAccessFailed"),
    );
  };

  const repair = async () => {
    const local = readExecutionContext()?.controller;
    if (
      !local ||
      !(await confirmAction(t("settings:connections_repairConfirm", { value0: computerNoun })))
    )
      return;
    await perform(
      { operation: "reset-identity", environmentId: local.environmentId },
      t("settings:connections_repairFailed"),
    );
  };

  const devices = activeTrustedDevices(state);
  const pending = pendingApprovals(state, Date.now());
  const allowChecked = allowOverride ?? allowConnections ?? true;

  return (
    <>
      <SettingsSectionShell
        title={t("settings:connections_devicesThatCanControl", { value0: computerNoun })}
        action={
          <div className="flex items-center gap-1.5">
            <IconButton
              label={t("settings:connections_refresh")}
              variant="ghost"
              onClick={() => {
                void refresh();
                onRefreshBilling?.();
              }}
            >
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
            <Button size="xs" shape="capsule" onClick={() => setDialog("add")}>
              {t("settings:connections_connectDevice")}
            </Button>
          </div>
        }
      >
        <SettingsCard>
          {onViewProPlans ? (
            <SettingsListRow
              title="Neox Alto"
              description={t("settings:connections_altoDescription", { value0: computerNoun })}
              actions={
                <Button size="xs" shape="capsule" variant="subtle" onClick={onViewProPlans}>
                  {t("settings:connections_viewAltoPlans")}
                </Button>
              }
            />
          ) : null}
          <SettingsListRow
            title={t("settings:connections_allowConnections")}
            description={allowChecked ? undefined : t("settings:connections_allowConnectionsOff")}
            actions={
              <Switch
                checked={allowChecked}
                disabled={busy || state === null}
                aria-label={t("settings:connections_allowConnections")}
                onCheckedChange={(next) => void setAllow(next)}
              />
            }
          />
          {pending.length > 0 ? (
            <SettingsListRow
              title={
                pending.length === 1
                  ? t("settings:connections_oneDeviceWaiting", {
                      value0: pending[0]!.pendingDevice.label,
                    })
                  : t("settings:connections_devicesWaiting", { value0: pending.length })
              }
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  onClick={() => setDialog("review")}
                >
                  {t("settings:connections_review")}
                </Button>
              }
            />
          ) : null}
          {/* The daemon's connection offer carries no device registry, so the
              bridge always answers with an empty list. Showing "no devices yet"
              would describe a backend that cannot exist; the native app has no
              device list either.
              debt: render TrustedDeviceRow again when the daemon tracks paired devices. */}
          {NEOLIX_ACCOUNT_UI_ENABLED
            ? devices.map((device) => (
                <TrustedDeviceRow
                  key={device.deviceJkt}
                  device={device}
                  busy={busy}
                  onRevoke={() => void revoke(device)}
                />
              ))
            : null}
          {state !== null && devices.length === 0 && NEOLIX_ACCOUNT_UI_ENABLED ? (
            <SettingsListRow
              title={
                <span className="font-normal text-muted-foreground">
                  {t("settings:connections_noDevicesYet")}
                </span>
              }
              description={t("settings:connections_addDeviceDescription", {
                value0: computerNoun,
              })}
            />
          ) : null}
          {state?.rootNeedsRepair ? (
            <SettingsListRow
              title={t("settings:connections_repairTitle")}
              description={t("settings:connections_repairDescription")}
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="subtle"
                  disabled={busy}
                  onClick={() => void repair()}
                >
                  {t("settings:connections_repair")}
                </Button>
              }
            />
          ) : null}
        </SettingsCard>
        {error || (loadError && state === null) ? (
          <p role="alert" className="px-2 text-ui text-destructive">
            {error ?? loadError}
          </p>
        ) : null}
      </SettingsSectionShell>

      <SettingsSection title={t("settings:connections_relaySection")}>
        <SettingsListRow
          title={t("settings:connections_relayTitle")}
          description={
            relayEnabled
              ? t("settings:connections_relayDescriptionOn")
              : t("settings:connections_relayDescriptionOff")
          }
          actions={
            <Switch
              checked={relayEnabled}
              disabled={relayDisabled}
              aria-label={t("settings:connections_relayTitle")}
              onCheckedChange={(next) => void hostConfig.patch({ relay: { enabled: next } })}
            />
          }
        />
        {relayEnabled ? (
          <>
            <SettingsListRow
              title={t("settings:connections_requireProtectedTitle")}
              description={t("settings:connections_requireProtectedDescription")}
              actions={
                <Switch
                  checked={requireProtected}
                  disabled={relayDisabled}
                  aria-label={t("settings:connections_requireProtectedTitle")}
                  onCheckedChange={(next) =>
                    void hostConfig.patch({ relay: { requireProtectedSecurity: next } })
                  }
                />
              }
            />
            <SettingsListRow
              title={t("settings:connections_securityModeTitle")}
              description={
                requireProtected
                  ? t("settings:connections_securityModeProtected")
                  : t("settings:connections_securityModeLegacyAllowed")
              }
            />
          </>
        ) : null}
      </SettingsSection>

      {keepAwake.state ? (
        <SettingsSection title={t("settings:connections_otherSettings")}>
          <SettingsListRow
            title={t("settings:connections_keepAwakeTitle", { value0: computerNoun })}
            description={
              keepAwake.state.enabled && keepAwake.state.onBattery
                ? t("settings:connections_keepAwakePaused")
                : t("settings:connections_keepAwakeDescription")
            }
            actions={
              <Switch
                checked={keepAwake.state.enabled}
                aria-label={t("settings:connections_keepAwakeTitle", { value0: computerNoun })}
                onCheckedChange={(next) =>
                  void keepAwake.setEnabled(next).catch((cause: unknown) =>
                    toastManager.add({
                      type: "error",
                      title: t("settings:connections_keepAwakeError"),
                      description: remoteAccessErrorMessage(
                        cause,
                        t("settings:connections_tryAgain"),
                      ),
                    }),
                  )
                }
              />
            }
          />
        </SettingsSection>
      ) : null}

      <section className="mt-6">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 px-2 text-ui-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={advancedOpen}
          onClick={() => {
            setAdvancedOpen((open) => !open);
            setAdvancedSeen(true);
          }}
        >
          <DisclosureChevron open={advancedOpen} />
          {t("settings:connections_advanced")}
        </button>
        <DisclosureRegion open={advancedOpen}>
          {advancedSeen ? <AccountAdvanced /> : null}
        </DisclosureRegion>
      </section>

      <ConnectionsAddDeviceDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        createCode={dialog === "add"}
        state={state}
        loadError={loadError}
        onChanged={refresh}
        computerNoun={computerNoun}
      />
    </>
  );
}

/** The account-level view: this machine's link, signed-in devices, and live sessions. */
function AccountAdvanced() {
  const { t } = useTranslation();
  const account = useAccount();
  const remote = useHosts({ enabled: true });
  const devices = useDevices({ enabled: true });
  const sessions = useHostSessions({ enabled: true });
  const localHost = remote.enrollment?.host
    ? (remote.hosts.find((host) => host.id === remote.enrollment?.host?.id) ?? null)
    : null;

  const fail = (title: string, cause: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: accountErrorMessage(cause, t("settings:connections_tryAgainMoment")),
    });

  const unlink = async () => {
    if (!(await confirmAction(t("settings:connections_unlinkConfirm")))) return;
    try {
      await remote.unlinkLocalHost.mutateAsync();
      toastManager.add({
        type: "success",
        title: t("settings:connections_machineUnlinked"),
        description: t("settings:connections_machineUnlinkedDescription"),
      });
    } catch (cause) {
      fail(t("settings:connections_couldNotUnlink"), cause);
    }
  };

  const revokeDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
        t("settings:connections_revokeDeviceConfirm", { value0: device.displayName }),
      ))
    )
      return;
    try {
      await devices.revokeDevice.mutateAsync({ deviceId: device.id });
      toastManager.add({
        type: "success",
        title: t("settings:connections_deviceRevoked"),
        description: t("settings:connections_deviceRevokedDescription"),
      });
    } catch (cause) {
      fail(t("settings:connections_couldNotRevoke"), cause);
    }
  };

  const signOutDevice = async (device: AccountDevice) => {
    if (
      !(await confirmAction(
        t("settings:connections_signOutConfirm", { value0: device.displayName }),
      ))
    )
      return;
    const hostsApi = readHostsApi();
    if (!hostsApi?.remoteAccess) {
      fail(
        t("settings:connections_couldNotSignOut"),
        new Error(t("settings:connections_accountSessionUnavailable")),
      );
      return;
    }
    let result;
    try {
      result = await hostsApi.remoteAccess({
        operation: "revoke-account-sessions",
        deviceId: device.id,
      });
    } catch (cause) {
      fail(t("settings:connections_couldNotSignOut"), cause);
      return;
    }
    if (result?.kind !== "account-sessions-revoked") {
      fail(
        t("settings:connections_couldNotSignOut"),
        new Error(t("settings:connections_accountSessionUnavailable")),
      );
      return;
    }
    toastManager.add({
      type: result.pending ? "warning" : "success",
      title: result.pending
        ? t("settings:connections_signOutPending")
        : t("settings:connections_signedOut"),
      description: t("settings:connections_signOutDescription", {
        value0: result.confirmed,
        value1: result.pending,
        value2: result.pending
          ? t("settings:connections_canRetry")
          : t("settings:connections_deviceKeyUnchanged"),
      }),
    });
  };

  const endSession = async (session: HostSession) => {
    if (
      !(await confirmAction(
        t("settings:connections_endSessionConfirm", { value0: session.userId }),
      ))
    )
      return;
    try {
      await sessions.endSession.mutateAsync({ sessionId: session.id });
      toastManager.add({
        type: "success",
        title: t("settings:connections_sessionEnded"),
        description: t("settings:connections_sessionEndedDescription"),
      });
    } catch (cause) {
      fail(t("settings:connections_couldNotEndSession"), cause);
    }
  };

  return (
    <div className="pt-1">
      {remote.enrollment?.host ? (
        <SettingsSection title={t("settings:connections_thisMachineOnAccount")}>
          <SettingsListRow
            title={remote.enrollment.host.name}
            description={t("settings:connections_unlinkDescription")}
            actions={
              <Button
                size="xs"
                shape="capsule"
                variant="destructive-outline"
                disabled={remote.unlinkLocalHost.isPending}
                onClick={() => void unlink()}
              >
                {remote.unlinkLocalHost.isPending
                  ? t("settings:connections_unlinking")
                  : t("settings:connections_unlink")}
              </Button>
            }
          />
          {NEOLIX_ACCOUNT_UI_ENABLED && localHost && remote.canManageHost(localHost) ? (
            <SettingsListRow
              title={t("settings:connections_shareWorkspace")}
              description={t("settings:connections_shareWorkspaceDescription")}
              actions={
                <Switch
                  checked={localHost.discoverable}
                  disabled={remote.setDiscoverable.isPending}
                  aria-label={t("settings:connections_shareWorkspaceAria")}
                  onCheckedChange={(discoverable) =>
                    void remote.setDiscoverable
                      .mutateAsync({ hostId: localHost.id, discoverable })
                      .catch((cause: unknown) =>
                        fail(
                          discoverable
                            ? t("settings:connections_couldNotShare")
                            : t("settings:connections_couldNotStopSharing"),
                          cause,
                        ),
                      )
                  }
                />
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title={t("settings:connections_accountDevices")}>
        <QueryRows
          query={devices.devicesQuery}
          loading={t("settings:connections_loadingDevices")}
          failure={t("settings:connections_loadDevicesFailed")}
          empty={t("settings:connections_noAccountDevices")}
          count={devices.devices.length}
        >
          {devices.devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              busy={devices.revokeDevice.isPending}
              onRevoke={() => void revokeDevice(device)}
              onRevokeAccountSessions={() => void signOutDevice(device)}
            />
          ))}
        </QueryRows>
      </SettingsSection>

      <SettingsSection title={t("settings:connections_activeSessions")}>
        <QueryRows
          query={sessions.sessionsQuery}
          loading={t("settings:connections_loadingSessions")}
          failure={t("settings:connections_loadSessionsFailed")}
          empty={t("settings:connections_nobodyConnected")}
          count={sessions.sessions.length}
        >
          {sessions.sessions.map((session) => {
            const device = devices.devices.find((entry) => entry.jkt === session.deviceJkt);
            return (
              <SessionRow
                key={session.id}
                session={session}
                userLabel={
                  account.me?.id === session.userId
                    ? account.me.name
                    : t("settings:connections_userLabel", { value0: session.userId })
                }
                deviceLabel={device?.displayName ?? t("settings:connections_unknownDevice")}
                busy={sessions.endSession.isPending}
                onEnd={() => void endSession(session)}
              />
            );
          })}
        </QueryRows>
      </SettingsSection>
    </div>
  );
}

function QueryRows({
  query,
  loading,
  failure,
  empty,
  count,
  children,
}: {
  query: { isPending: boolean; error: unknown };
  loading: string;
  failure: string;
  empty: string;
  count: number;
  children: ReactNode;
}) {
  if (query.isPending) return <SettingsListRow title={<Muted>{loading}</Muted>} />;
  if (query.error)
    return (
      <SettingsListRow
        title={<Muted>{failure}</Muted>}
        description={
          <span className="text-destructive">{accountErrorMessage(query.error, failure)}</span>
        }
      />
    );
  if (count === 0) return <SettingsListRow title={<Muted>{empty}</Muted>} />;
  return <>{children}</>;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>;
}
