// FILE: DevicePairing.tsx
// Purpose: The pairing flow behind "Connect a device": one single-use code per opening,
//          its countdown and replacement, and the requests that still need a manual
//          approval. Shared by the Connections dialog and the first-run onboarding so
//          both surfaces run the same state machine.
// Layer: Settings UI hooks and components
// Exports: useDevicePairing, PendingDeviceApprovalCard, PairingCode

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useAccount } from "~/hooks/useAccount";
import { getHostConfig, patchHostConfig } from "~/lib/neolixHostApi";
import {
  activeTrustedDevices,
  callRemoteAccess,
  countdownLabel,
  pendingApprovals,
  remoteAccessErrorMessage,
  type RemoteHostState,
  type RemotePairingCode,
} from "~/lib/hosts/remoteAccess";
import { remotePairingLink } from "~/lib/remotePairingLink";
import { useTranslation } from "~/i18n";
import { Button } from "../ui/button";
import { RemoteDeviceIcon } from "./ConnectionsRows";

export type PendingDeviceApproval = ReturnType<typeof pendingApprovals>[number];

/** Requests first (a new code would withdraw them), then a fresh join, then the code. */
export type DevicePairingView = "approval" | "joined" | "code" | "empty" | "relay";

/** The connection offer's `minimumSecurityMode`, read out of the pairing link's fragment. */
export function offerRequiresProtected(link: string | null): boolean {
  if (!link) return false;
  const match = /#offer=([A-Za-z0-9_-]+)/.exec(link);
  if (!match) return false;
  try {
    const base64 = match[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const offer: unknown = JSON.parse(atob(padded));
    return (
      typeof offer === "object" &&
      offer !== null &&
      (offer as { minimumSecurityMode?: unknown }).minimumSecurityMode === "protected"
    );
  } catch {
    return false;
  }
}

export const DEVICE_PAIRING_CARD_CLASS_NAME = "rounded-[20px] border border-border bg-muted/40";

export function useDevicePairing({
  createCode,
  state,
  loadError,
  onChanged,
}: {
  /** False when opened only to review pending requests. */
  createCode: boolean;
  state: RemoteHostState | null;
  loadError: string | null;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const account = useAccount();
  const [invitation, setInvitation] = useState<RemotePairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayBusy, setRelayBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeRequested, setCodeRequested] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [openedAt] = useState(() => Date.now());
  const mounted = useRef(true);
  const initialCodeRequested = useRef(false);
  const queryClient = useQueryClient();

  // A pairing code only exists when the daemon's relay is on: without it the daemon has no
  // public address to hand over. The config is the same document Settings › Connections edits,
  // so enabling relay there and here share one cache entry.
  const hostConfigQuery = useQuery({
    queryKey: ["neolix-host-config"],
    queryFn: getHostConfig,
    staleTime: 5_000,
    retry: false,
  });
  const relay = hostConfigQuery.data?.config.relay;
  // Older configs omit relay.enabled; the daemon's own default is on.
  const relayEnabled = relay?.enabled !== false;
  const requireProtectedSecurity = relay?.requireProtectedSecurity === true;
  const relaySettled = !hostConfigQuery.isLoading;

  const run = async (work: () => Promise<void>, failure: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      if (mounted.current) setError(remoteAccessErrorMessage(cause, failure));
    }
    if (mounted.current) setBusy(false);
  };

  const pending = pendingApprovals(state, now);
  const joined = activeTrustedDevices(state).filter(
    (device) => Date.parse(device.approvedAt) >= openedAt,
  );
  // A code someone already redeemed, or one withdrawn elsewhere, is spent.
  const shownStatus = invitation
    ? state?.invitations.find((entry) => entry.inviteId === invitation.inviteId)
    : undefined;
  const used = Boolean(
    shownStatus && (shownStatus.revoked || shownStatus.approved || shownStatus.pendingDevice),
  );
  // The daemon's connection offer is the host's public identity and never
  // expires; a countdown for it would be invented. Rendezvous-backed codes
  // keep their real countdown.
  const neverExpires = invitation?.neverExpires === true;
  const codeActive = Boolean(invitation && !used);
  const remaining =
    invitation && codeActive && !neverExpires ? countdownLabel(invitation.expiresAt, now) : null;

  // A live code being replaced is withdrawn first so only the one on screen
  // stays redeemable; it leaves the screen before the new one is requested, so
  // a failure cannot keep showing a dead code.
  const newCode = () => {
    if (state === null) return onChanged();
    return run(async () => {
      if (invitation && codeActive) {
        await callRemoteAccess({ operation: "cancel-invitation", inviteId: invitation.inviteId });
      }
      if (mounted.current) setInvitation(null);
      const result = await callRemoteAccess({ operation: "create-code" });
      if (mounted.current && result.kind === "pairing-code") setInvitation(result);
    }, t("settings:connections_createCodeFailed"));
  };

  const approve = (entry: PendingDeviceApproval) =>
    run(async () => {
      await callRemoteAccess({
        operation: "approve",
        inviteId: entry.inviteId,
        deviceJkt: entry.pendingDevice.deviceJkt,
      });
    }, t("settings:connections_approveDeviceFailed"));

  const reject = (entry: PendingDeviceApproval) =>
    run(async () => {
      await callRemoteAccess({ operation: "cancel-invitation", inviteId: entry.inviteId });
    }, t("settings:connections_rejectRequestFailed"));

  // Relay consent: a pairing offer carries the daemon's public relay address, so the daemon
  // must have the relay on before a code can be minted.
  const enableRelay = async () => {
    if (busy || relayBusy) return;
    setRelayBusy(true);
    setError(null);
    try {
      await patchHostConfig({ relay: { enabled: true } });
      await queryClient.invalidateQueries({ queryKey: ["neolix-host-config"] });
    } catch (cause) {
      if (mounted.current)
        setError(remoteAccessErrorMessage(cause, t("settings:connections_enableRelayFailed")));
    }
    if (mounted.current) setRelayBusy(false);
  };

  useEffect(() => {
    mounted.current = true;
    const countdown = setInterval(() => setNow(Date.now()), 1_000);
    // Leaving keeps the code: people close this to type it on the phone. It
    // expires on its own and can be cancelled from Connections.
    return () => {
      mounted.current = false;
      clearInterval(countdown);
    };
  }, []);

  // Creating a code withdraws pending requests. Wait for the first host state
  // and let the owner review any waiting requests before creating a code.
  const hostStateLoaded = state !== null;
  const noPending = pending.length === 0;
  const requestInitialCode = useEffectEvent(newCode);
  useEffect(() => {
    if (
      !createCode ||
      !hostStateLoaded ||
      !noPending ||
      busy ||
      initialCodeRequested.current ||
      !relaySettled ||
      !relayEnabled
    )
      return;
    initialCodeRequested.current = true;
    setCodeRequested(true);
    void requestInitialCode();
  }, [createCode, hostStateLoaded, noPending, busy, relaySettled, relayEnabled]);

  // A host that cannot mint a Synara deep link (the Neox bridge) hands over its own
  // connection offer; encode that verbatim so the QR still pairs a real device.
  const qrLink =
    invitation && codeActive
      ? (invitation.link ??
        remotePairingLink(
          account.status?.state === "signed-in" ? account.status.accountAuthority : undefined,
          invitation,
        ))
      : null;

  const view: DevicePairingView = !noPending
    ? "approval"
    : joined.length > 0
      ? "joined"
      : createCode
        ? relaySettled && relayEnabled
          ? "code"
          : "relay"
        : "empty";

  return {
    view,
    pending,
    joined,
    invitation,
    remaining,
    codeActive,
    neverExpires,
    used,
    qrLink,
    email: account.me?.email ?? null,
    busy,
    error: error ?? (state === null ? loadError : null),
    codeRequested,
    newCode,
    approve,
    reject,
    relayEnabled,
    relaySettled,
    relayBusy,
    enableRelay,
    requireProtectedSecurity,
    offerRequiresProtected: offerRequiresProtected(invitation?.link ?? null),
  };
}

export function PendingDeviceApprovalCard({
  entry,
  computerNoun,
  busy,
  onApprove,
  onReject,
}: {
  entry: PendingDeviceApproval;
  computerNoun: string;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={`${DEVICE_PAIRING_CARD_CLASS_NAME} space-y-3.5 p-4`}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <RemoteDeviceIcon label={entry.pendingDevice.label} />
        </span>
        <div className="min-w-0">
          <p
            className="truncate text-ui font-medium text-foreground"
            title={entry.pendingDevice.label}
          >
            {entry.pendingDevice.label}
          </p>
          <p className="text-ui-sm text-muted-foreground">
            {t("settings:connections_wantsToControl", { value0: computerNoun })}
          </p>
        </div>
      </div>
      <div className="space-y-1.5 border-t border-border pt-3">
        <p className="text-ui-xs text-muted-foreground">
          {t("settings:connections_shouldShowFingerprint")}
        </p>
        <code className="block font-mono text-ui-xs break-all text-foreground">
          {entry.pendingDevice.deviceJkt}
        </code>
      </div>
      <div className="flex gap-2">
        <Button
          shape="capsule"
          variant="subtle"
          className="flex-1"
          disabled={busy}
          onClick={onReject}
        >
          {t("settings:connections_reject")}
        </Button>
        <Button shape="capsule" className="flex-1" disabled={busy} onClick={onApprove}>
          {t("settings:connections_approve")}
        </Button>
      </div>
    </div>
  );
}

export function PairingCode({ code }: { code: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-2.5">
      <span className="text-ui-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {t("settings:connections_pairingCode")}
      </span>
      <span className="font-mono text-4xl font-medium tracking-[0.12em] text-foreground">
        {code}
      </span>
    </div>
  );
}
