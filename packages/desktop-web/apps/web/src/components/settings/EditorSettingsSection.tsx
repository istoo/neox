// FILE: EditorSettingsSection.tsx
// Purpose: Settings › Editor. The native UI's Vim keybindings switch; monaco-vim loads
//          on demand only while this is on, and the editor shows its mode in a status bar.
// Layer: Settings UI components
// Exports: EditorSettingsSection

import { useTranslation } from "~/i18n";
import { useAppSettings } from "~/appSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton } from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function EditorSettingsSection() {
  const { t } = useTranslation();
  const { settings, defaults, updateSettings } = useAppSettings();

  return (
    <SettingsSection title="settings:editorSettings">
      <SettingsRow
        id="setting-vim-keybindings"
        title="settings:vimKeybindings"
        description={t("settings:vimKeybindingsDescription")}
        resetAction={
          settings.vimKeybindings !== defaults.vimKeybindings ? (
            <SettingResetButton
              label={t("settings:vimKeybindings")}
              onClick={() => updateSettings({ vimKeybindings: defaults.vimKeybindings })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.vimKeybindings}
            onCheckedChange={(checked) => updateSettings({ vimKeybindings: Boolean(checked) })}
            aria-label={t("settings:vimKeybindings")}
          />
        }
      />
    </SettingsSection>
  );
}
