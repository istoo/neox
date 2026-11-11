// FILE: ConnectionsAddDeviceDialog.tsx
// Purpose: "Add" on Control this computer — a single-use pairing code shown as a QR
//          for phones and as a short code for other computers, plus the requests
//          that still need a manual approval.
// Layer: Settings UI components
// Exports: ConnectionsAddDeviceDialog

import { useState } from "react";

import { remoteDeviceKind, type RemoteHostState } from "~/lib/hosts/remoteAccess";
import { NEOLIX_ACCOUNT_UI_ENABLED } from "~/neolixFeatures";
import { ClockIcon, RefreshCwIcon } from "~/lib/icons";
import { SegmentedPicker } from "../SegmentedPicker";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { type AddDeviceHeroVariant, ConnectionsAddDeviceHero } from "./ConnectionsAddDeviceHero";
import { RootFingerprint } from "./ConnectionsRows";
import {
  DEVICE_PAIRING_CARD_CLASS_NAME as CARD_CLASS_NAME,
  PairingCode,
  PendingDeviceApprovalCard,
  useDevicePairing,
} from "./DevicePairing";
import { PairingQrCode } from "./PairingQrCode";
import { useTranslation } from "~/i18n";

type DeviceTab = "phone" | "computer";

const HELP_TEXT_CLASS_NAME = "text-center text-ui-sm leading-relaxed text-muted-foreground";

export function ConnectionsAddDeviceDialog({
  open,
  onOpenChange,
  createCode,
  state,
  loadError,
  onChanged,
  computerNoun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False when opened only to review pending requests. */
  createCode: boolean;
  state: RemoteHostState | null;
  loadError: string | null;
  onChanged: () => Promise<void>;
  computerNoun: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <AddDeviceDialogContent
          createCode={createCode}
          state={state}
          loadError={loadError}
          onChanged={onChanged}
          onClose={() => onOpenChange(false)}
          computerNoun={computerNoun}
        />
      ) : null}
    </Dialog>
  );
}

function AddDeviceDialogContent({
  createCode,
  state,
  loadError,
  onChanged,
  onClose,
  computerNoun,
}: {
  createCode: boolean;
  state: RemoteHostState | null;
  loadError: string | null;
  onChanged: () => Promise<void>;
  onClose: () => void;
  computerNoun: string;
}) {
  const { t } = useTranslation();
  const deviceTabs = [
    { value: "phone", label: t("settings:connections_deviceTabPhone") },
    { value: "computer", label: t("settings:connections_deviceTabComputer") },
  ] as const;
  const [tab, setTab] = useState<DeviceTab>("phone");
  const {
    view,
    pending,
    joined,
    invitation,
    remaining,
    codeActive,
    neverExpires,
    used,
    qrLink,
    email,
    busy,
    error,
    codeRequested,
    newCode,
    approve,
    reject,
    relaySettled,
    relayBusy,
    enableRelay,
    requireProtectedSecurity,
    offerRequiresProtected,
  } = useDevicePairing({ createCode, state, loadError, onChanged });
  const firstPending = pending[0];

  const hero: AddDeviceHeroVariant =
    view === "joined"
      ? "linked"
      : view === "approval" && firstPending
        ? remoteDeviceKind(firstPending.pendingDevice.label) === "computer"
          ? "computer"
          : "phone"
        : view === "code" && tab === "computer"
          ? "computer"
          : view === "relay"
            ? "computer"
            : "phone";
  const joinedNames = joined.map((device) => device.label).join(", ");
  // A deployment-specific pairing link (the Neox bridge's daemon offer) replaces the
  // short code: it is the artifact the other computer pastes, and the QR encodes it.
  const pairingLink = invitation?.link ?? null;
  const pairingValue = pairingLink ?? invitation?.code ?? "";

  return (
    <DialogPopup className="max-w-[440px] overflow-hidden">
      <ConnectionsAddDeviceHero variant={hero} computerNoun={computerNoun} />
      <DialogHeader className="items-center px-7 pt-5 text-center">
        {view === "approval" ? (
          <>
            <DialogTitle>
              {pending.length === 1
                ? t("settings:connections_approveThisDevice")
                : t("settings:connections_approveTheseDevices")}
            </DialogTitle>
            <DialogDescription>
              {pending.length === 1
                ? t("settings:connections_approveDeviceDescription")
                : t("settings:connections_approveDevicesDescription")}
            </DialogDescription>
          </>
        ) : view === "joined" ? (
          <>
            <DialogTitle>
              {joined.length === 1
                ? t("settings:connections_joinedOne", { value0: joinedNames })
                : t("settings:connections_joinedMany", { value0: joinedNames })}
            </DialogTitle>
            <DialogDescription>
              {joined.length === 1
                ? t("settings:connections_joinedOneDescription", { value0: computerNoun })
                : t("settings:connections_joinedManyDescription", { value0: computerNoun })}
            </DialogDescription>
          </>
        ) : view === "relay" ? (
          <>
            <DialogTitle>{t("settings:connections_enableRelayTitle")}</DialogTitle>
            <DialogDescription>
              {t("settings:connections_enableRelayDescription", { value0: computerNoun })}
            </DialogDescription>
          </>
        ) : view === "code" ? (
          <>
            <DialogTitle>
              {t("settings:connections_connectDeviceTitle", { value0: computerNoun })}
            </DialogTitle>
            <DialogDescription>
              {email ? (
                <>
                  {t("settings:connections_useSameAccountEmail")}{" "}
                  <span className="font-medium break-all text-foreground">{email}</span>
                </>
              ) : NEOLIX_ACCOUNT_UI_ENABLED ? (
                t("settings:connections_useSameAccountDevices")
              ) : (
                t("settings:connections_scanCodeHelp")
              )}
            </DialogDescription>
          </>
        ) : (
          <>
            <DialogTitle>{t("settings:connections_noRequestsWaiting")}</DialogTitle>
            <DialogDescription>{t("settings:connections_noRequestsDescription")}</DialogDescription>
          </>
        )}
      </DialogHeader>
      <DialogPanel className="space-y-4 px-7 pt-4! pb-7">
        {view === "approval"
          ? pending.map((entry) => (
              <PendingDeviceApprovalCard
                key={entry.inviteId}
                entry={entry}
                computerNoun={computerNoun}
                busy={busy}
                onApprove={() => void approve(entry)}
                onReject={() => void reject(entry)}
              />
            ))
          : null}

        {view === "relay" ? (
          <div className="space-y-3">
            {relaySettled ? (
              <p className="rounded-[14px] border border-border px-3.5 py-3 text-ui leading-relaxed text-muted-foreground">
                {t("settings:connections_enableRelayHint", { value0: computerNoun })}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-ui text-muted-foreground">
                <Spinner className="size-4" aria-hidden />
                {t("settings:connections_creatingCode")}
              </p>
            )}
            {error ? (
              <p role="alert" className="text-center text-ui text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                shape="capsule"
                variant="subtle"
                className="flex-1"
                disabled={relayBusy}
                onClick={onClose}
              >
                {t("settings:connections_notNow")}
              </Button>
              <Button
                shape="capsule"
                className="flex-1"
                disabled={relayBusy || !relaySettled}
                onClick={() => void enableRelay()}
              >
                {relayBusy
                  ? t("settings:connections_enablingRelay")
                  : t("settings:connections_enableRelay")}
              </Button>
            </div>
          </div>
        ) : null}

        {view === "code" ? (
          <>
            <SegmentedPicker<DeviceTab>
              ariaLabel={t("settings:connections_deviceToConnect")}
              value={tab}
              onValueChange={setTab}
              options={deviceTabs}
            />
            <div className={`${CARD_CLASS_NAME} px-4 pt-4.5 pb-3`}>
              <div className="relative flex h-56 items-center justify-center">
                {invitation ? (
                  <div
                    className={
                      codeActive
                        ? "flex w-full justify-center"
                        : "pointer-events-none flex w-full justify-center opacity-10 blur-[2px]"
                    }
                    aria-hidden={codeActive ? undefined : true}
                  >
                    {tab === "phone" && qrLink ? (
                      <PairingQrCode
                        value={qrLink}
                        label={t("settings:connections_scanToConnect")}
                      />
                    ) : pairingLink ? (
                      <code className="block max-h-40 w-full overflow-y-auto font-mono text-ui-xs break-all text-foreground">
                        {pairingLink}
                      </code>
                    ) : (
                      <PairingCode code={invitation.code} />
                    )}
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p role="alert" className="text-ui text-destructive">
                      {error}
                    </p>
                    <Button
                      shape="capsule"
                      variant="subtle"
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      {t("settings:connections_tryAgain")}
                    </Button>
                  </div>
                ) : busy || !codeRequested ? (
                  <p className="flex items-center gap-2 text-ui text-muted-foreground">
                    <Spinner className="size-4" aria-hidden />
                    {t("settings:connections_creatingCode")}
                  </p>
                ) : (
                  <Button shape="capsule" variant="subtle" onClick={() => void newCode()}>
                    {t("settings:connections_newCode")}
                  </Button>
                )}
                {invitation && !codeActive ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center">
                    <p className="text-ui font-semibold text-foreground">
                      {used
                        ? t("settings:connections_codeUsed")
                        : t("settings:connections_codeExpired")}
                    </p>
                    <p className="mb-2 text-ui-sm text-muted-foreground">
                      {used
                        ? t("settings:connections_createNewCodeToConnect")
                        : t("settings:connections_createNewCodeToRetry")}
                    </p>
                    <Button
                      shape="capsule"
                      size="sm"
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      {t("settings:connections_newCode")}
                    </Button>
                  </div>
                ) : null}
              </div>
              {invitation && codeActive ? (
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-ui-sm text-muted-foreground tabular-nums">
                    <ClockIcon className="size-3.5" aria-hidden />
                    {remaining
                      ? t("settings:connections_expiresIn", { value0: remaining })
                      : neverExpires
                        ? t("settings:connections_doesNotExpire")
                        : ""}
                  </span>
                  <span className="flex items-center gap-0.5 text-muted-foreground">
                    <CopyTextButton
                      text={pairingValue}
                      label={
                        pairingLink
                          ? t("settings:connections_copyLink")
                          : t("settings:connections_copyCode")
                      }
                      iconOnly
                    />
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={t("settings:connections_newCode")}
                      title={t("settings:connections_newCode")}
                      disabled={busy}
                      onClick={() => void newCode()}
                    >
                      <RefreshCwIcon className="size-3" />
                    </Button>
                  </span>
                </div>
              ) : null}
            </div>
            <div className="rounded-[14px] border border-border px-3.5 py-2.5 text-ui-sm leading-relaxed">
              {requireProtectedSecurity ? (
                offerRequiresProtected ? (
                  <p className="text-muted-foreground">
                    {t("settings:connections_securityProtected")}
                  </p>
                ) : (
                  <p role="alert" className="text-destructive">
                    {t("settings:connections_securityMismatch")}
                  </p>
                )
              ) : (
                <p className="text-muted-foreground">
                  {t("settings:connections_securityLegacyAllowed")}
                </p>
              )}
            </div>
            {invitation && codeActive && tab === "phone" ? (
              <p className={HELP_TEXT_CLASS_NAME}>
                {invitation.link
                  ? t("settings:connections_cantScan")
                  : t("settings:connections_enterCodePrefix")}
                {invitation.link ? null : (
                  <span className="font-mono font-medium text-foreground">{invitation.code}</span>
                )}
                {invitation.link ? null : t("settings:connections_enterCodeSuffix")}
              </p>
            ) : null}
            {invitation && codeActive && tab === "computer" ? (
              <>
                <p className={HELP_TEXT_CLASS_NAME}>
                  {pairingLink
                    ? t("settings:connections_computerInstructionsLink")
                    : t("settings:connections_computerInstructionsCode")}
                </p>
                <div className="space-y-1.5 rounded-[14px] border border-border py-2.5 ps-3.5 pe-2">
                  <p className="text-ui-xs text-muted-foreground">
                    {t("settings:connections_thenCheckFingerprint", { value0: computerNoun })}
                  </p>
                  <RootFingerprint value={invitation.rootFingerprint} className="text-foreground" />
                </div>
              </>
            ) : null}
          </>
        ) : null}

        {error && !(view === "code" && !invitation) ? (
          <p role="alert" className="text-center text-ui text-destructive">
            {error}
          </p>
        ) : null}

        {view === "joined" || view === "empty" || (view === "approval" && !createCode) ? (
          <Button
            shape="capsule"
            variant={view === "approval" ? "subtle" : "default"}
            className="w-full"
            onClick={onClose}
          >
            {t("settings:connections_done")}
          </Button>
        ) : null}
      </DialogPanel>
    </DialogPopup>
  );
}
