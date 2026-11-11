// FILE: ConnectionsRows.tsx
// Purpose: The row shapes the Connections pane lists — devices trusted by this
//          computer, computers this one can control, and the account's devices
//          and sessions shown under Advanced.
// Layer: Settings UI components
// Exports: RemoteDeviceIcon, RootFingerprint, TrustedDeviceRow, HostRow, HostRowConnection,
//          DeviceRow, SessionRow

import type {
  AccountDevice,
  AccountHost,
  HostConnection,
  HostSession,
  RemoteTrustedDevice,
} from "@synara/contracts";

import { canManageHost, hostPlatformLabel } from "~/lib/hosts/api";
import { hostColorValue, type HostAppearance } from "~/lib/hosts/appearance";
import {
  reachabilityLabel,
  reachabilityToneClassName,
  transportLabel,
  type HostReachability,
} from "~/lib/hosts/reachability";
import {
  fingerprintGroups,
  remoteDeviceKind,
  trustedDeviceActivityLabel,
} from "~/lib/hosts/remoteAccess";
import { NEOLIX_ACCOUNT_UI_ENABLED } from "~/neolixFeatures";
import { formatRelativeTime } from "~/lib/relativeTime";
import { t, useTranslation } from "~/i18n";
import {
  DeviceComputerIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  EllipsisIcon,
  ServerIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { Menu, MenuCheckboxItem, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SettingsListRow } from "./SettingsPanelPrimitives";

const ICON_CLASS_NAME = "size-5";

export function RemoteDeviceIcon({ label }: { label: string }) {
  const kind = remoteDeviceKind(label);
  if (kind === "phone") return <DeviceMobileIcon className={ICON_CLASS_NAME} aria-hidden />;
  if (kind === "tablet") return <DeviceTabletIcon className={ICON_CLASS_NAME} aria-hidden />;
  return <DeviceComputerIcon className={ICON_CLASS_NAME} aria-hidden />;
}

/** Grouped identity for comparison; copies the original fingerprint without display spacing. */
export function RootFingerprint({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <p className="grid min-w-0 flex-1 grid-cols-4 gap-x-2 gap-y-1 font-mono text-ui-xs">
        {fingerprintGroups(value).map((group) => (
          <span key={group.offset}>{group.text}</span>
        ))}
      </p>
      <CopyTextButton text={value} label={t("settings:connections_fingerprint")} iconOnly />
    </div>
  );
}

/** A device this computer trusts to control it. */
export function TrustedDeviceRow({
  device,
  busy,
  onRevoke,
}: {
  device: RemoteTrustedDevice;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t: translate } = useTranslation();
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={device.label} />}
      title={device.label}
      description={trustedDeviceActivityLabel(device)}
      actions={
        <Button size="xs" shape="capsule" variant="subtle" disabled={busy} onClick={onRevoke}>
          {translate("settings:connections_revokeAccess")}
        </Button>
      }
    />
  );
}

/** Where this window stands with respect to one host row. */
export type HostRowConnection =
  | { readonly kind: "disconnected"; readonly busy: boolean }
  | {
      readonly kind: "connected";
      readonly transport: HostConnection["transport"];
      /** This window is currently working on that host. */
      readonly active: boolean;
      readonly busy: boolean;
    };

function hostStatusLabel(
  host: AccountHost,
  connection: HostRowConnection,
  reachability: HostReachability,
): string | null {
  if (connection.kind === "connected")
    return t("settings:connections_statusOver", {
      value0: connection.active
        ? t("settings:connections_workingOnIt")
        : t("settings:connections_connected"),
      value1: transportLabel(connection.transport),
    });
  if (!host.linked) return t("settings:connections_notLinked");
  if (reachability.state === "unknown") return null;
  return reachabilityLabel(reachability);
}

/** A computer this one can control, with its connect action and an overflow menu. */
export function HostRow({
  host,
  reachability,
  busy,
  appearance,
  connection: connectionProp,
  onProbe,
  onAppearance,
  onToggleDiscoverable,
  onConnect,
  onDisconnect,
  onActivate,
  onDeactivate,
  onForget,
  onRename,
}: {
  host: AccountHost;
  reachability: HostReachability;
  busy: boolean;
  appearance?: HostAppearance | undefined;
  connection?: HostRowConnection;
  onProbe?: () => void;
  onAppearance?: () => void;
  onToggleDiscoverable: (discoverable: boolean) => void;
  onRename?: () => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onActivate?: () => void;
  onDeactivate?: () => void;
  onForget?: () => void;
}) {
  const { t: translate } = useTranslation();
  const connection = connectionProp ?? { kind: "disconnected", busy: false };
  const owned = canManageHost(host);
  const status = hostStatusLabel(host, connection, reachability);
  const details = [
    hostPlatformLabel(host.platform),
    ...(owned ? [] : [translate("settings:connections_sharedByWorkspace")]),
  ].join(" · ");
  const color = appearance ? hostColorValue(appearance.color) : null;
  const hostIcon =
    host.platform === "linux" ? (
      <ServerIcon className={ICON_CLASS_NAME} aria-hidden />
    ) : (
      <DeviceComputerIcon className={ICON_CLASS_NAME} aria-hidden />
    );
  return (
    <SettingsListRow
      leading={
        color ? (
          <span className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            {hostIcon}
          </span>
        ) : (
          hostIcon
        )
      }
      title={host.name}
      description={
        <span>
          {details}
          {status ? (
            <>
              {" · "}
              <span
                className={cn(
                  connection.kind === "disconnected" && reachabilityToneClassName(reachability),
                )}
              >
                {status}
              </span>
            </>
          ) : null}
        </span>
      }
      actions={
        <>
          {connection.kind === "connected" ? (
            connection.active ? (
              <Button size="xs" shape="capsule" variant="subtle" onClick={onDeactivate}>
                {translate("settings:connections_backToThisComputer")}
              </Button>
            ) : (
              <Button size="xs" shape="capsule" variant="subtle" onClick={onActivate}>
                {translate("settings:connections_open")}
              </Button>
            )
          ) : (
            <Button
              size="xs"
              shape="capsule"
              variant="subtle"
              disabled={!host.linked || connection.busy}
              onClick={onConnect}
            >
              {connection.busy
                ? translate("settings:connections_connecting")
                : translate("settings:connections_connect")}
            </Button>
          )}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={translate("settings:connections_moreActions", { value0: host.name })}
                />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-52">
              {onProbe ? (
                <MenuItem disabled={reachability.state === "probing"} onClick={onProbe}>
                  {reachability.state === "probing"
                    ? translate("settings:connections_checking")
                    : translate("settings:connections_checkAvailability")}
                </MenuItem>
              ) : null}
              {connection.kind === "connected" ? (
                <MenuItem disabled={connection.busy} onClick={onDisconnect}>
                  {translate("settings:connections_disconnect")}
                </MenuItem>
              ) : null}
              {onRename ? (
                <MenuItem onClick={onRename}>{translate("settings:connections_rename")}</MenuItem>
              ) : null}
              {onAppearance ? (
                <MenuItem onClick={onAppearance}>
                  {translate("settings:connections_appearanceAction")}
                </MenuItem>
              ) : null}
              {owned && NEOLIX_ACCOUNT_UI_ENABLED ? (
                <MenuCheckboxItem
                  variant="switch"
                  checked={host.discoverable}
                  disabled={busy}
                  onCheckedChange={(checked) => onToggleDiscoverable(Boolean(checked))}
                >
                  {translate("settings:connections_shareWithWorkspace")}
                </MenuCheckboxItem>
              ) : null}
              {onForget ? (
                <>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={onForget}>
                    {translate("settings:connections_forgetPairing")}
                  </MenuItem>
                </>
              ) : null}
            </ComposerPickerMenuPopup>
          </Menu>
        </>
      }
    />
  );
}

function usedLabel(iso: string | null): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return t("settings:connections_neverUsed");
  const relative = formatRelativeTime(iso);
  return relative === "now"
    ? t("settings:connections_usedJustNow")
    : t("settings:connections_usedAgo", { value0: relative });
}

/** A device signed in to the account (Advanced). */
export function DeviceRow({
  device,
  busy,
  onRevoke,
  onRevokeAccountSessions,
}: {
  device: AccountDevice;
  busy: boolean;
  onRevoke: () => void;
  onRevokeAccountSessions?: () => void;
}) {
  const { t: translate } = useTranslation();
  const revoked = device.revokedAt !== null;
  return (
    <SettingsListRow
      align="start"
      leading={<RemoteDeviceIcon label={`${device.platform} ${device.displayName}`} />}
      title={device.displayName}
      description={
        <span className="flex flex-col gap-0.5">
          <span>
            {revoked
              ? translate("settings:connections_deviceKeyRevoked")
              : usedLabel(device.lastUsedAt)}
          </span>
          {device.revocationDeliveries?.map((delivery) => (
            <span key={delivery.hostId} className="text-ui-sm">
              {delivery.hostName}:{" "}
              {delivery.confirmedAt
                ? translate("settings:connections_revocationConfirmed")
                : translate("settings:connections_revocationPending")}
            </span>
          ))}
        </span>
      }
      actions={
        <>
          {onRevokeAccountSessions ? (
            <Button
              size="xs"
              shape="capsule"
              variant="subtle"
              disabled={busy}
              onClick={onRevokeAccountSessions}
            >
              {translate("settings:connections_signOut")}
            </Button>
          ) : null}
          {!revoked ? (
            <Button
              size="xs"
              shape="capsule"
              variant="destructive-outline"
              disabled={busy}
              onClick={onRevoke}
            >
              {translate("settings:connections_revokeKey")}
            </Button>
          ) : null}
        </>
      }
    />
  );
}

function sessionTransportLabel(transport: HostSession["transport"]): string {
  switch (transport) {
    case "cloudflare":
      return "Cloudflare";
    case "direct":
      return t("settings:connections_transportDirect");
    case "relay":
      return t("settings:connections_transportRelay");
    case "ssh-forward":
      return t("settings:connections_transportSshForward");
  }
}

function startedLabel(iso: string): string {
  if (Number.isNaN(Date.parse(iso))) return t("settings:connections_startedUnknown");
  const relative = formatRelativeTime(iso);
  return relative === "now"
    ? t("settings:connections_startedJustNow")
    : t("settings:connections_startedAgo", { value0: relative });
}

/** A live session another device holds to this computer (Advanced). */
export function SessionRow({
  session,
  userLabel,
  deviceLabel,
  busy,
  onEnd,
}: {
  session: HostSession;
  userLabel: string;
  deviceLabel: string;
  busy: boolean;
  onEnd: () => void;
}) {
  return (
    <SettingsListRow
      leading={<RemoteDeviceIcon label={deviceLabel} />}
      title={deviceLabel}
      description={
        <span>
          {userLabel} · {sessionTransportLabel(session.transport)} ·{" "}
          <time dateTime={session.startedAt}>{startedLabel(session.startedAt)}</time>
        </span>
      }
      actions={
        <Button
          size="xs"
          shape="capsule"
          variant="destructive-outline"
          disabled={busy}
          onClick={onEnd}
        >
          {t("settings:connections_endSession")}
        </Button>
      }
    />
  );
}
