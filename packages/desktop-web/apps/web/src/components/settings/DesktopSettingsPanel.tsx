// FILE: DesktopSettingsPanel.tsx
// Purpose: Settings › Desktop. Groups every shell-owned preference that the
//          legacy renderer kept in General (login, Dock, sleep, tray, shortcuts,
//          updates) and adds the File → Desktop UI switch. The whole panel is
//          absent in a plain browser, where there is no shell to configure.
// Layer: Settings UI components
// Exports: DesktopSettingsPanel

import { useQuery } from "@tanstack/react-query";

import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";

import { desktopShellAvailable } from "./desktopShellSettings";
import {
  DesktopCliSettingsSection,
  DesktopSystemSettingsSection,
  DesktopTraySettingsSection,
  DesktopUpdatePolicySettingsSection,
} from "./DesktopSystemSettingsSection";
import { SettingsSegmentedControl } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type DesktopUiMode = "native" | "web";

const DESKTOP_UI_OPTIONS: readonly { value: DesktopUiMode; label: string }[] = [
  { value: "web", label: "settings:desktop_uiStandard" },
  { value: "native", label: "settings:desktop_uiClassic" },
];

export function DesktopSettingsPanel({ active }: { readonly active: boolean }) {
  const available = desktopShellAvailable();
  if (!active || !available) return null;
  return (
    <div className="space-y-6">
      <DesktopUiModeSection active={active} />
      <DesktopSystemSettingsSection active={active} />
      <DesktopUpdatePolicySettingsSection active={active} />
      <DesktopTraySettingsSection active={active} />
      <DesktopCliSettingsSection active={active} />
    </div>
  );
}

/**
 * The renderer switch the File menu owns, here so the two never disagree. A
 * successful change relaunches the app; an environment pin leaves the row
 * read-only instead of pretending the click took.
 */
function DesktopUiModeSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.uiMode;
  const query = useQuery({
    queryKey: ["neolix-desktop-ui-mode"],
    queryFn: () => bridge!.getState(),
    enabled: active && bridge !== undefined,
    staleTime: 5_000,
    retry: false,
  });

  if (!active || bridge === undefined) return null;
  const state = query.data;
  if (!state) return null;

  const setMode = async (mode: DesktopUiMode) => {
    if (mode === state.mode) return;
    try {
      await bridge.setMode(mode);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:desktopSettingSaveFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <SettingsSection title={t("settings:desktop_uiSection")}>
      <SettingsRow
        id="setting-desktop-ui-mode"
        title={t("settings:desktop_uiMode")}
        description={
          state.selectable
            ? t("settings:desktop_uiModeDescription")
            : t("settings:desktop_uiModeLocked")
        }
        control={
          state.selectable ? (
            <SettingsSegmentedControl
              value={state.mode}
              onValueChange={(value) => void setMode(value)}
              ariaLabel={t("settings:desktop_uiMode")}
              options={DESKTOP_UI_OPTIONS}
            />
          ) : null
        }
      />
    </SettingsSection>
  );
}
