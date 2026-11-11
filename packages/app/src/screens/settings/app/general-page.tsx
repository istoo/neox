import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { isNative, isWeb } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useSettingsHostServerId } from "./shared";
import {
  LANGUAGE_OPTIONS,
  formatLanguageOptionLabel,
  parseAppLanguage,
  type AppLanguage,
  type LanguageOption,
  type SupportedLocale,
} from "@/i18n/locales";
import { useOpenOnboarding } from "@/onboarding";
import { SendingSection } from "@/screens/settings/general/sending-section";
import { OpenLocationSection } from "@/screens/settings/open-location/open-location-section";
import { isElectronRuntime } from "@/desktop/host";
import { settingsStyles } from "@/styles/settings";
import { DesktopSystemRows } from "./desktop-rows";
import { GatewayModeRow } from "./gateway-mode-row";
import { SessionTerminalRow } from "./session-terminal-row";

function activeLocaleOf(language: string | undefined): SupportedLocale {
  const parsed = parseAppLanguage(language);
  return parsed && parsed !== "system" ? parsed : "en";
}

function LanguageOptionItem({
  option,
  activeLocale,
  selected,
  onChange,
}: {
  option: LanguageOption;
  activeLocale: SupportedLocale;
  selected: boolean;
  onChange: (value: AppLanguage) => void;
}) {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(option.value), [onChange, option.value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {formatLanguageOptionLabel(option, activeLocale, t(option.labelKey))}
    </DropdownMenuItem>
  );
}

function LanguageRow() {
  const { t, i18n } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const activeLocale = activeLocaleOf(i18n.language);
  const selectedOption = useMemo(
    () => LANGUAGE_OPTIONS.find((option) => option.value === settings.language),
    [settings.language],
  );
  const selectedLabel = selectedOption
    ? formatLanguageOptionLabel(selectedOption, activeLocale, t(selectedOption.labelKey))
    : settings.language;
  const handleChange = useCallback(
    (language: AppLanguage) => void updateSettings({ language }),
    [updateSettings],
  );
  return (
    <SettingsRow
      label={t("settings.general.language.label")}
      hint={t("settings.general.language.description")}
    >
      <DropdownMenu>
        <DropdownTrigger accessibilityRole="button" accessibilityLabel={selectedLabel}>
          {selectedLabel}
        </DropdownTrigger>
        <DropdownMenuContent side="bottom" align="end" width={300}>
          {LANGUAGE_OPTIONS.map((option) => (
            <LanguageOptionItem
              key={option.value}
              option={option}
              activeLocale={activeLocale}
              selected={settings.language === option.value}
              onChange={handleChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </SettingsRow>
  );
}

function SetupRow() {
  const { t } = useTranslation();
  const openOnboarding = useOpenOnboarding();
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.general.setup.label")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.general.setup.description")}</Text>
      </View>
      <Button variant="secondary" onPress={openOnboarding ?? undefined} disabled={!openOnboarding}>
        {t("settings.general.setup.action")}
      </Button>
    </View>
  );
}

function WslAgentsRow() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const supported = useHostFeature(serverId, "wslAgents");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const setEnabled = useCallback(
    (enabled: boolean) => void patchConfig({ noWslAgents: !enabled }),
    [patchConfig],
  );
  if (!supported) {
    return null;
  }
  return (
    <SettingsSwitch
      label={t("settings.pages.general.wslAgents")}
      hint={t("settings.pages.general.wslAgentsHint")}
      value={config?.noWslAgents !== true}
      onValueChange={setEnabled}
      testID="settings-wsl-agents"
    />
  );
}

function AccessibilityRows() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const setColorblind = useCallback(
    (colorblindMode: boolean) => void updateSettings({ colorblindMode }),
    [updateSettings],
  );
  const setReduceMotion = useCallback(
    (reduceMotion: boolean) => void updateSettings({ reduceMotion }),
    [updateSettings],
  );
  const setLoadingBird = useCallback(
    (loadingBird: boolean) => void updateSettings({ loadingBird }),
    [updateSettings],
  );
  return (
    <SettingsCard>
      <SettingsSwitch
        label={t("settings.pages.general.colorblind")}
        hint={t("settings.pages.general.colorblindHint")}
        value={settings.colorblindMode}
        onValueChange={setColorblind}
        testID="settings-colorblind"
      />
      <SettingsSwitch
        label={t("settings.pages.general.reduceMotion")}
        hint={t("settings.pages.general.reduceMotionHint")}
        value={settings.reduceMotion}
        onValueChange={setReduceMotion}
        testID="settings-reduce-motion"
      />
      <SettingsSwitch
        label={t("loadingBird.label")}
        hint={t("loadingBird.hint")}
        value={settings.loadingBird}
        onValueChange={setLoadingBird}
        testID="settings-loading-bird"
      />
    </SettingsCard>
  );
}

/**
 * Settings › General: colorblind mode, reduce motion and the loading animation,
 * language, the setup shortcut, and Neolix's send and open-location preferences.
 * Theme, fonts and sizes live on the Appearance page.
 */
export function GeneralPage() {
  const { t } = useTranslation();
  const isDesktopApp = isElectronRuntime();
  return (
    <View>
      <SettingsSection title={t("settings.pages.general.accessibilitySection")}>
        <AccessibilityRows />
      </SettingsSection>
      <SettingsSection title={t("settings.pages.general.preferencesSection")}>
        <SettingsCard>
          <LanguageRow />
          {/* myna hides the gateway row outside the browser page: #gatewayModeRow.hidden = !web. */}
          {isWeb && !isElectronRuntime() ? <GatewayModeRow /> : null}
          <WslAgentsRow />
          <SessionTerminalRow />
          {isNative ? null : <SetupRow />}
        </SettingsCard>
      </SettingsSection>
      {isDesktopApp ? <DesktopSystemRows /> : null}
      <SendingSection />
      {isDesktopApp ? <OpenLocationSection /> : null}
    </View>
  );
}
