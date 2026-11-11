// FILE: ConnectionsAddComputerDialog.tsx
// Purpose: "Add" on Control other devices — redeem another computer's pairing
//          code, compare its identity, and request access from it.
// Layer: Settings UI components
// Exports: ConnectionsAddComputerDialog

import { useEffect, useId, useRef, useState } from "react";

import {
  DEVICE_USER_CODE_GROUP_SIZE,
  DEVICE_USER_CODE_LENGTH,
  formatUnambiguousCode,
} from "~/lib/hosts/enrollment";
import {
  callRemoteAccess,
  remoteAccessErrorMessage,
  type RemotePairingPreview,
} from "~/lib/hosts/remoteAccess";
import type { RemoteAccessRequest } from "@synara/contracts";
import { ensureHostsApi } from "~/lib/hosts/api";
import { NEOLIX_ACCOUNT_UI_ENABLED } from "~/neolixFeatures";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import { ShortCodeField } from "../hosts/ShortCodeField";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RootFingerprint } from "./ConnectionsRows";

function fail(message: string): never {
  throw new Error(message);
}

export function ConnectionsAddComputerDialog({
  open,
  onOpenChange,
  onPaired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaired: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        NEOLIX_ACCOUNT_UI_ENABLED ? (
          <AddComputerDialogContent onClose={() => onOpenChange(false)} onPaired={onPaired} />
        ) : (
          <AddComputerByConnection onClose={() => onOpenChange(false)} onPaired={onPaired} />
        )
      ) : null}
    </Dialog>
  );
}

/**
 * Neox has no rendezvous directory, so adding a computer means handing over the
 * connection target it printed: its pairing link, or an address reachable from here.
 * The address and SSH forms build the same grammar the CLI accepts so people never
 * have to memorize it.
 */
function AddComputerByConnection({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const { t } = useTranslation();
  const connectionId = useId();
  const labelId = useId();
  const [mode, setMode] = useState<"address" | "ssh" | "link">("address");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("6868");
  const [sshUser, setSshUser] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [daemonPort, setDaemonPort] = useState("6868");
  const [connection, setConnection] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validPort = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback;
  };

  const buildConnection = (): string | null => {
    if (mode === "link") return connection.trim() || null;
    if (mode === "address") {
      const address = host.trim();
      if (!address) return null;
      return `${address}:${validPort(port, 6868)}`;
    }
    const sshHostname = sshHost.trim();
    if (!sshHostname) return null;
    const user = sshUser.trim() ? `${encodeURIComponent(sshUser.trim())}@` : "";
    const sshPortPart = sshPort.trim() ? `:${validPort(sshPort, 22)}` : "";
    // The username is percent-encoded; the host stays verbatim because it may be an
    // IPv6 literal or a DNS name, both of which the daemon's SSH parser handles.
    return `ssh://${user}${sshHostname}${sshPortPart}?daemonPort=${validPort(daemonPort, 6868)}`;
  };

  const target = buildConnection();

  const add = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    const payload = {
      connection: target,
      ...(label.trim() ? { label: label.trim() } : {}),
    };
    try {
      const api = ensureHostsApi();
      if (!api.addHost) fail(t("settings:connections_couldNotSaveComputers"));
      await api.addHost(payload);
      onPaired();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : t("settings:connections_couldNotAddComputer"),
      );
    }
    setBusy(false);
  };

  const modeButton = (value: "address" | "ssh" | "link", text: string) => (
    <Button
      size="xs"
      shape="capsule"
      variant={mode === value ? "default" : "subtle"}
      disabled={busy}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
    >
      {text}
    </Button>
  );

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t("settings:connections_addComputerTitle")}</DialogTitle>
        <DialogDescription>
          {t("settings:connections_addComputerDescriptionLink")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <div className="flex items-center gap-1.5">
          {modeButton("address", t("settings:connections_addModeAddress"))}
          {modeButton("ssh", t("settings:connections_addModeSsh"))}
          {modeButton("link", t("settings:connections_addModeLink"))}
        </div>
        {mode === "address" ? (
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <div className="space-y-1.5">
              <label htmlFor={connectionId} className="text-ui-sm font-medium">
                {t("settings:connections_addressHost")}
              </label>
              <Input
                id={connectionId}
                value={host}
                placeholder="192.168.1.20"
                disabled={busy}
                autoFocus
                onChange={(event) => setHost(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${connectionId}-port`} className="text-ui-sm font-medium">
                {t("settings:connections_addressPort")}
              </label>
              <Input
                id={`${connectionId}-port`}
                value={port}
                inputMode="numeric"
                placeholder="6868"
                disabled={busy}
                onChange={(event) => setPort(event.target.value)}
              />
            </div>
          </div>
        ) : mode === "ssh" ? (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label htmlFor={`${connectionId}-ssh-user`} className="text-ui-sm font-medium">
                  {t("settings:connections_sshUser")}
                </label>
                <Input
                  id={`${connectionId}-ssh-user`}
                  value={sshUser}
                  placeholder="root"
                  disabled={busy}
                  onChange={(event) => setSshUser(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${connectionId}-ssh-host`} className="text-ui-sm font-medium">
                  {t("settings:connections_sshHost")}
                </label>
                <Input
                  id={`${connectionId}-ssh-host`}
                  value={sshHost}
                  placeholder="192.168.1.20"
                  disabled={busy}
                  autoFocus
                  onChange={(event) => setSshHost(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add();
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label htmlFor={`${connectionId}-ssh-port`} className="text-ui-sm font-medium">
                  {t("settings:connections_sshPort")}
                </label>
                <Input
                  id={`${connectionId}-ssh-port`}
                  value={sshPort}
                  inputMode="numeric"
                  placeholder="22"
                  disabled={busy}
                  onChange={(event) => setSshPort(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor={`${connectionId}-daemon-port`} className="text-ui-sm font-medium">
                  {t("settings:connections_daemonPort")}
                </label>
                <Input
                  id={`${connectionId}-daemon-port`}
                  value={daemonPort}
                  inputMode="numeric"
                  placeholder="6868"
                  disabled={busy}
                  onChange={(event) => setDaemonPort(event.target.value)}
                />
              </div>
            </div>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:connections_sshDescription")}
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <label htmlFor={connectionId} className="text-ui-sm font-medium">
              {t("settings:connections_pairingLinkOrAddress")}
            </label>
            <Input
              id={connectionId}
              value={connection}
              placeholder={t("settings:connections_pairingLinkPlaceholder")}
              disabled={busy}
              autoFocus
              onChange={(event) => setConnection(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void add();
              }}
            />
          </div>
        )}
        <div className="space-y-1.5">
          <label htmlFor={labelId} className="text-ui-sm font-medium">
            {t("settings:connections_name")}{" "}
            <span className="text-muted-foreground">{t("settings:connections_optional")}</span>
          </label>
          <Input
            id={labelId}
            value={label}
            placeholder={t("settings:connections_namePlaceholder")}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void add();
            }}
          />
        </div>
        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button shape="capsule" variant="subtle" onClick={onClose}>
          {t("common:form_cancel")}
        </Button>
        <Button shape="capsule" disabled={busy || !target} onClick={() => void add()}>
          {busy ? t("settings:connections_adding") : t("settings:connections_addComputer")}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

function AddComputerDialogContent({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  onPaired: () => void;
}) {
  const { t } = useTranslation();
  const confirmationId = useId();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<RemotePairingPreview | null>(null);
  const [compared, setCompared] = useState(false);
  const [deviceJkt, setDeviceJkt] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [paired, setPaired] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void callRemoteAccess({ operation: "device-info" }).then(
      (info) => {
        if (mounted.current && info.kind === "device-info") setDeviceJkt(info.deviceJkt);
      },
      () => {},
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  const perform = async (request: RemoteAccessRequest) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const pairedLabel = preview?.label ?? t("settings:connections_theComputer");
    try {
      const result = await callRemoteAccess(request);
      if (!mounted.current) return;
      if (result.kind === "pairing-preview") {
        setPreview(result);
        setCompared(false);
      }
      if (request.operation === "forget-host") {
        setPreview(null);
        setCompared(false);
        setNotice(t("settings:connections_savedPairingRemoved"));
      }
      if (result.kind === "paired") {
        setPaired(pairedLabel);
        onPaired();
      }
    } catch (cause) {
      if (mounted.current)
        setError(remoteAccessErrorMessage(cause, t("settings:connections_requestIncomplete")));
    }
    if (mounted.current) {
      setBusy(false);
      setWaiting(false);
    }
  };

  const cancelRequest = () => {
    if (!preview) return;
    void callRemoteAccess({ operation: "forget-host", environmentId: preview.environmentId }).then(
      () => {
        if (!mounted.current) return;
        setPreview(null);
        setCompared(false);
        setError(null);
        setNotice(t("settings:connections_requestCancelled"));
      },
      () => setError(t("settings:connections_couldNotCancel")),
    );
  };

  const forgetPrevious = async () => {
    if (!preview) return;
    if (
      await ensureNativeApi().dialogs.confirm(
        t("settings:connections_forgetIdentityConfirm", { value0: preview.label }),
      )
    )
      await perform({ operation: "forget-host", environmentId: preview.environmentId });
  };

  const complete = code.length === DEVICE_USER_CODE_LENGTH;
  const find = () => {
    if (!complete || !deviceJkt) return;
    void perform({
      operation: "redeem-code",
      code: formatUnambiguousCode(code, DEVICE_USER_CODE_GROUP_SIZE),
    });
  };

  return (
    <DialogPopup className="max-w-md">
      <DialogHeader>
        <DialogTitle>{t("settings:connections_addComputerTitle")}</DialogTitle>
        <DialogDescription>
          {t("settings:connections_addComputerCodeDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {paired ? (
          <p role="status" className="py-4 text-center text-ui text-foreground">
            {t("settings:connections_approvedThisComputer", { value0: paired })}
          </p>
        ) : !preview ? (
          <ShortCodeField
            label={t("settings:connections_pairingCode")}
            value={code}
            codeLength={DEVICE_USER_CODE_LENGTH}
            groupSize={DEVICE_USER_CODE_GROUP_SIZE}
            placeholder="ABCD-2345"
            disabled={busy}
            onValueChange={setCode}
            onSubmit={find}
          />
        ) : (
          <div className="space-y-3">
            <p className="text-ui font-medium">{preview.label}</p>
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:connections_checkIdentity")}
            </p>
            <RootFingerprint
              value={preview.rootFingerprint}
              className="rounded-xl border border-[color:var(--color-border)] px-3 py-2"
            />
            <div className="flex items-center gap-2">
              <Checkbox
                id={confirmationId}
                checked={compared}
                onCheckedChange={setCompared}
                disabled={busy || waiting}
              />
              <label htmlFor={confirmationId} className="text-ui-sm">
                {t("settings:connections_identityMatches")}
              </label>
            </div>
            {deviceJkt ? (
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:connections_appearsAs")}{" "}
                <code className="break-all font-mono text-ui-xs text-foreground">{deviceJkt}</code>
              </p>
            ) : null}
          </div>
        )}
        {error ? (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="text-ui text-foreground">
            {notice}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {paired ? (
          <Button shape="capsule" onClick={onClose}>
            {t("settings:connections_done")}
          </Button>
        ) : preview ? (
          <>
            {waiting ? (
              <Button shape="capsule" variant="subtle" onClick={cancelRequest}>
                {t("settings:connections_cancelRequest")}
              </Button>
            ) : (
              <Button
                shape="capsule"
                variant="subtle"
                disabled={busy}
                onClick={() => void forgetPrevious()}
              >
                {t("settings:connections_forgetPreviousPairing")}
              </Button>
            )}
            <Button
              shape="capsule"
              disabled={busy || !compared || Date.parse(preview.expiresAt) <= Date.now()}
              onClick={() => {
                setWaiting(true);
                void perform({
                  operation: "confirm-code",
                  inviteId: preview.inviteId,
                  rootFingerprint: preview.rootFingerprint,
                });
              }}
            >
              {waiting
                ? t("settings:connections_waitingForApproval")
                : t("settings:connections_requestAccess")}
            </Button>
          </>
        ) : (
          <>
            <Button shape="capsule" variant="subtle" onClick={onClose}>
              {t("common:form_cancel")}
            </Button>
            <Button shape="capsule" disabled={busy || !complete || !deviceJkt} onClick={find}>
              {t("settings:connections_findComputer")}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}
