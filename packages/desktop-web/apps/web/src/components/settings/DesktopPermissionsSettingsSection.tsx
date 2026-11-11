// FILE: DesktopPermissionsSettingsSection.tsx
// Purpose: macOS/Windows system permission rows for the forked web UI (Full Disk
//          Access, Accessibility, Screen Recording, Microphone, Notifications),
//          backed by the desktop bridge's osPermissions surface.
// Layer: Settings UI component

import type {
  DesktopOsPermissionKind,
  DesktopOsPermissionSnapshot,
  DesktopOsPermissionState,
} from "@synara/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "~/components/ui/button";
import { StatusDot } from "~/components/ui/status-chip";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";

import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

type Translate = ReturnType<typeof useTranslation>["t"];

const PERMISSION_ROWS: readonly {
  kind: DesktopOsPermissionKind;
  label: string;
}[] = [
  { kind: "notifications", label: "settings:nav_notifications" },
  { kind: "microphone", label: "settings:microphone" },
  { kind: "accessibility", label: "settings:accessibility" },
  { kind: "screenRecording", label: "settings:screenRecording" },
  { kind: "fullDiskAccess", label: "settings:fullDiskAccess" },
];

const STATE_LABELS: Record<DesktopOsPermissionState, string> = {
  granted: "settings:granted",
  denied: "settings:denied",
  prompt: "settings:notRequestedYet",
  "not-determined": "settings:notRequestedYet",
  restricted: "settings:restricted",
  unavailable: "settings:unavailable",
  unknown: "common:common_unknown",
};

function PermissionStatus({ state, t }: { state: DesktopOsPermissionState; t: Translate }) {
  const granted = state === "granted";
  return (
    <span className="inline-flex items-center gap-1.5 text-ui-xs text-muted-foreground">
      <StatusDot
        aria-hidden
        className={
          granted
            ? "bg-emerald-500"
            : state === "denied" || state === "restricted"
              ? "bg-red-500"
              : "bg-[color:var(--color-border)]"
        }
      />
      {t(STATE_LABELS[state])}
    </span>
  );
}

export function DesktopPermissionsSettingsSection() {
  const { t } = useTranslation();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.osPermissions;
  const [snapshot, setSnapshot] = useState<DesktopOsPermissionSnapshot | null>(null);
  const [busy, setBusy] = useState<DesktopOsPermissionKind | "refresh" | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setBusy("refresh");
    const next = await bridge.getState().finally(() => setBusy(null));
    setSnapshot(next);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.getState().then(
      (next) => {
        if (!cancelled) setSnapshot(next);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  const request = async (kind: DesktopOsPermissionKind) => {
    if (busy !== null) return;
    setBusy(kind);
    try {
      const state = await bridge.request(kind);
      setSnapshot((current) =>
        current ? { ...current, permissions: { ...current.permissions, [kind]: state } } : current,
      );
      if (state === "granted") {
        toastManager.add({ type: "success", title: t("settings:granted") });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:permissionRequestFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setBusy(null);
  };

  return (
    <SettingsSectionShell
      title="settings:permissions"
      action={
        <Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === "refresh" ? t("settings:refreshing") : t("settings:permissionRefresh")}
        </Button>
      }
    >
      <SettingsCard>
        {PERMISSION_ROWS.map((row) => {
          const state = snapshot?.permissions[row.kind] ?? "unknown";
          const granted = state === "granted";
          return (
            <SettingsListRow
              key={row.kind}
              title={t(row.label)}
              description={t("settings:permissionsDescription")}
              actions={
                <div className="flex items-center gap-2">
                  <PermissionStatus state={state} t={t} />
                  {granted ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void request(row.kind)}
                    >
                      {busy === row.kind ? t("settings:requesting") : t("settings:grant")}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => {
                      void bridge.openSettings(row.kind).then((opened) => {
                        if (!opened) {
                          toastManager.add({
                            type: "error",
                            title: t("settings:permissionOpenSettingsFailed"),
                          });
                        }
                      });
                    }}
                  >
                    {t("settings:openSystemSettings")}
                  </Button>
                </div>
              }
            />
          );
        })}
      </SettingsCard>
    </SettingsSectionShell>
  );
}
