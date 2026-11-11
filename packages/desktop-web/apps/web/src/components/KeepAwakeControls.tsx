import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";
import { localizedKeepAwakeModeOptions, keepAwakeStatusLabel } from "~/lib/keepAwake";
import { SettingResetButton, SettingsSegmentedControl } from "./settings/SettingControls";
import { SettingsRow, SettingsSection } from "./settings/SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

export function KeepAwakeSettingsSection({
  state,
  mode,
  defaultMode,
  onSelectMode,
}: {
  state: ServerKeepAwakeState | null;
  mode: KeepAwakeMode;
  defaultMode: KeepAwakeMode;
  onSelectMode: (mode: KeepAwakeMode) => void;
}) {
  const { t } = useTranslation();
  // The desktop bridge is a single on/off blocker; the server's "agent" mode
  // has no counterpart there, so that choice is only offered by the daemon.
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge?.keepAwake;
  const options = localizedKeepAwakeModeOptions(t).filter(
    (option) => !desktopBridge || option.value !== "agent",
  );

  if (!state?.available) return null;
  return (
    <SettingsSection title={t("common:themeOptions_system")}>
      <SettingsRow
        title={t("settings:keepAwakeTitle")}
        description={t("settings:keepAwakeDescription")}
        status={state.error ?? keepAwakeStatusLabel(state, t)}
        resetAction={
          mode !== defaultMode ? (
            <SettingResetButton
              label={t("common:keepComputerAwake2")}
              onClick={() => onSelectMode(defaultMode)}
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={mode}
            onValueChange={onSelectMode}
            ariaLabel={t("settings:keepAwakeTitle")}
            options={options}
          />
        }
      />
    </SettingsSection>
  );
}
