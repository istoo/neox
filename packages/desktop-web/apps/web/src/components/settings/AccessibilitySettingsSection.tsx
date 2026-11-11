// FILE: AccessibilitySettingsSection.tsx
// Purpose: Settings › General accessibility switches the native UI had: colorblind-safe
//          status colors, a forced Reduce motion, and the loading-animation switch.
// Layer: Settings UI components
// Exports: AccessibilitySettingsSection

import { useTranslation } from "~/i18n";
import { type AppSettings, useAppSettings } from "~/appSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./SettingControls";
import { SettingsSection } from "./SettingsPanelPrimitives";
import { SettingsRow } from "./SettingsPanelPrimitives";

const ROWS = [
  {
    id: "setting-colorblind",
    key: "colorblindMode",
    title: "settings:colorblindMode",
    description: "settings:colorblindModeDescription",
  },
  {
    id: "setting-reduce-motion",
    key: "reduceMotion",
    title: "settings:reduceMotion",
    description: "settings:reduceMotionDescription",
  },
  {
    id: "setting-loading-animation",
    key: "loadingAnimation",
    title: "settings:loadingAnimation",
    description: "settings:loadingAnimationDescription",
  },
] as const;

export function AccessibilitySettingsSection() {
  const { t } = useTranslation();
  const { settings, defaults, updateSettings } = useAppSettings();

  return (
    <SettingsSection title="settings:accessibility">
      {ROWS.map((row) => (
        <SettingsRow
          key={row.id}
          id={row.id}
          title={row.title}
          description={t(row.description)}
          resetAction={
            settings[row.key] !== defaults[row.key] ? (
              <SettingResetButton
                label={t(row.title)}
                onClick={() =>
                  updateSettings({ [row.key]: defaults[row.key] } as Partial<AppSettings>)
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings[row.key]}
              onCheckedChange={(checked) =>
                updateSettings({ [row.key]: Boolean(checked) } as Partial<AppSettings>)
              }
              aria-label={t(row.title)}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}
