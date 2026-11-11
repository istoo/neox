// FILE: AppearanceExtrasSettings.tsx
// Purpose: Top-level appearance rows that project onto the existing theme pack and
//          typography model instead of introducing parallel settings:
//          named theme presets, interface/code font families, the three font-size roots,
//          and an arbitrary chat width in px.
// Layer: Settings UI components
// Exports: NamedThemeRow, AppearanceFontRows, ChatWidthCustomRow

import { useEffect, useState } from "react";

import {
  MAX_CHAT_WIDTH_PX,
  MAX_CODE_FONT_SIZE_PX,
  MAX_UI_FONT_SIZE_PX,
  MIN_CHAT_WIDTH_PX,
  MIN_CODE_FONT_SIZE_PX,
  MIN_UI_FONT_SIZE_PX,
  normalizeChatWidthPx,
  normalizeCodeFontSizePx,
  normalizeUiFontSizePx,
  resolveCodeFontSizePx,
  resolveUiFontSizePx,
  type AppSettings,
  useAppSettings,
} from "~/appSettings";
import { useTranslation } from "~/i18n";
import { CODE_THEME_OPTIONS, normalizeCodeThemeId } from "~/theme/theme.logic";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { Input } from "../ui/input";
import { NumberDraftInput } from "./NumberDraftInput";
import { SelectItem } from "../ui/select";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow } from "./SettingsPanelPrimitives";

const CUSTOM_THEME_VALUE = "__custom__";

/** Named themes that exist in both light and dark slots, so one pick applies everywhere. */
const NAMED_THEME_OPTIONS = CODE_THEME_OPTIONS.filter(
  (option) => option.variants.includes("light") && option.variants.includes("dark"),
);

/** A failed sanitize leaves the committed value in place, same as the native font fields. */
function sanitizeFontFamily(value: string): string {
  return value
    .replace(/[;{}<>\n\r]/g, "")
    .slice(0, 256)
    .trim();
}

export function NamedThemeRow() {
  const { t } = useTranslation();
  const { lightTheme, darkTheme, setCodeThemeId } = useTheme();
  const lightId = normalizeCodeThemeId(lightTheme.codeThemeId, "light");
  const darkId = normalizeCodeThemeId(darkTheme.codeThemeId, "dark");
  const shared = lightId === darkId ? lightId : CUSTOM_THEME_VALUE;
  const selectedLabel =
    shared === CUSTOM_THEME_VALUE
      ? t("settings:namedThemeCustom")
      : (NAMED_THEME_OPTIONS.find((option) => option.id === shared)?.label ?? shared);

  return (
    <SettingsRow
      id="setting-named-theme"
      title="settings:namedTheme"
      description={t("settings:namedThemeDescription")}
      resetAction={
        shared !== "synara" ? (
          <SettingResetButton
            label={t("settings:namedTheme")}
            onClick={() => {
              setCodeThemeId("light", "synara");
              setCodeThemeId("dark", "synara");
            }}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={shared}
          onValueChange={(value) => {
            if (value === CUSTOM_THEME_VALUE) return;
            setCodeThemeId("light", value);
            setCodeThemeId("dark", value);
          }}
          ariaLabel={t("settings:namedTheme")}
          valueContent={selectedLabel}
          triggerClassName="w-full sm:w-48"
        >
          {/* "Custom" describes light and dark using different code themes (set below); it is
              shown only while that is the case and cannot be picked. */}
          {shared === CUSTOM_THEME_VALUE ? (
            <SelectItem hideIndicator disabled value={CUSTOM_THEME_VALUE}>
              {t("settings:namedThemeCustom")}
            </SelectItem>
          ) : null}
          {NAMED_THEME_OPTIONS.map((option) => (
            <SelectItem hideIndicator key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SettingsSelectControl>
      }
    />
  );
}

function FontFamilyField({
  value,
  placeholder,
  ariaLabel,
  mono,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  mono?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      size="sm"
      variant="soft"
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className={cn("w-full sm:w-56", mono && "font-mono")}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = sanitizeFontFamily(draft);
        if (next !== draft) setDraft(next);
        onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/**
 * Interface and code font families plus one numeric root per ramp. The families live in
 * the theme pack (both variants, so a mode flip keeps them); the sizes stay in app
 * settings with null meaning "follow the content size".
 */
export function AppearanceFontRows() {
  const { t } = useTranslation();
  const { settings, defaults, updateSettings } = useAppSettings();
  const { lightTheme, darkTheme, resolvedTheme, systemUiFont, setSystemUiFont, updateThemeFonts } =
    useTheme();

  const activeFonts = resolvedTheme === "dark" ? darkTheme.theme.fonts : lightTheme.theme.fonts;
  const setBoth = (patch: { ui?: string | null; code?: string | null }) => {
    updateThemeFonts("light", patch);
    updateThemeFonts("dark", patch);
  };
  const uiFont = activeFonts.ui ?? "";
  const codeFont = activeFonts.code ?? "";
  const uiSize = resolveUiFontSizePx(settings);
  const codeSize = resolveCodeFontSizePx(settings);

  return (
    <>
      <SettingsRow
        id="setting-ui-font"
        title="settings:interfaceFont"
        description={
          systemUiFont
            ? t("settings:interfaceFontSystemActive")
            : t("settings:interfaceFontDescription")
        }
        resetAction={
          uiFont.length > 0 ? (
            <SettingResetButton
              label={t("settings:interfaceFont")}
              onClick={() => {
                setBoth({ ui: null });
                setSystemUiFont(true);
              }}
            />
          ) : null
        }
        control={
          <FontFamilyField
            value={uiFont}
            placeholder={t("settings:systemDefaultFont")}
            ariaLabel={t("settings:interfaceFont")}
            onCommit={(value) => {
              setBoth({ ui: value.length > 0 ? value : null });
              setSystemUiFont(value.length === 0);
            }}
          />
        }
      />

      <SettingsRow
        id="setting-ui-font-size"
        title="settings:interfaceFontSize"
        description={t("settings:interfaceFontSizeDescription")}
        resetAction={
          settings.uiFontSizePx !== defaults.uiFontSizePx ? (
            <SettingResetButton
              label={t("settings:interfaceFontSize")}
              onClick={() => updateSettings({ uiFontSizePx: defaults.uiFontSizePx })}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <NumberDraftInput
              size="sm"
              min={MIN_UI_FONT_SIZE_PX}
              max={MAX_UI_FONT_SIZE_PX}
              step={1}
              inputMode="numeric"
              variant="soft"
              className="w-full text-right sm:w-20"
              value={uiSize}
              normalize={normalizeUiFontSizePx}
              onCommit={(next) => {
                if (next !== null) updateSettings({ uiFontSizePx: next });
              }}
              aria-label={t("settings:interfaceFontSizeInPixels")}
            />
            <span className="text-ui leading-snug text-muted-foreground">
              {t("settings:appearance_px")}
            </span>
          </div>
        }
      />

      <SettingsRow
        id="setting-code-font"
        title="settings:codeFont"
        description={t("settings:codeFontDescription")}
        resetAction={
          codeFont.length > 0 ? (
            <SettingResetButton
              label={t("settings:codeFont")}
              onClick={() => setBoth({ code: null })}
            />
          ) : null
        }
        control={
          <FontFamilyField
            value={codeFont}
            placeholder={t("settings:defaultMonospaceFont")}
            ariaLabel={t("settings:codeFont")}
            mono
            onCommit={(value) => setBoth({ code: value.length > 0 ? value : null })}
          />
        }
      />

      <SettingsRow
        id="setting-code-font-size"
        title="settings:codeFontSize"
        description={t("settings:codeFontSizeDescription")}
        resetAction={
          settings.codeFontSizePx !== defaults.codeFontSizePx ? (
            <SettingResetButton
              label={t("settings:codeFontSize")}
              onClick={() => updateSettings({ codeFontSizePx: defaults.codeFontSizePx })}
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <NumberDraftInput
              size="sm"
              min={MIN_CODE_FONT_SIZE_PX}
              max={MAX_CODE_FONT_SIZE_PX}
              step={1}
              inputMode="numeric"
              variant="soft"
              className="w-full text-right sm:w-20"
              value={codeSize}
              normalize={normalizeCodeFontSizePx}
              onCommit={(next) => {
                if (next !== null) updateSettings({ codeFontSizePx: next });
              }}
              aria-label={t("settings:codeFontSizeInPixels")}
            />
            <span className="text-ui leading-snug text-muted-foreground">
              {t("settings:appearance_px")}
            </span>
          </div>
        }
      />
    </>
  );
}

/** A numeric px width that overrides the standard/wide/full preset until cleared. */
export function ChatWidthCustomRow() {
  const { t } = useTranslation();
  const { settings, defaults, updateSettings } = useAppSettings();
  const custom = normalizeChatWidthPx(settings.chatWidthPx);

  return (
    <SettingsRow
      id="setting-chat-width-custom"
      title="settings:chatWidthCustom"
      description={t("settings:chatWidthCustomDescription")}
      resetAction={
        settings.chatWidthPx !== defaults.chatWidthPx ? (
          <SettingResetButton
            label={t("settings:chatWidthCustom")}
            onClick={() => updateSettings({ chatWidthPx: defaults.chatWidthPx })}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <NumberDraftInput
            size="sm"
            min={MIN_CHAT_WIDTH_PX}
            max={MAX_CHAT_WIDTH_PX}
            step={10}
            inputMode="numeric"
            variant="soft"
            className="w-full text-right sm:w-24"
            placeholder={t("settings:chatWidthPreset")}
            value={custom}
            allowEmpty
            normalize={normalizeChatWidthPx}
            onCommit={(next) => {
              updateSettings({ chatWidthPx: next } as Partial<AppSettings>);
            }}
            aria-label={t("settings:chatWidthCustomInPixels")}
          />
          <span className="text-ui leading-snug text-muted-foreground">
            {t("settings:appearance_px")}
          </span>
        </div>
      }
    />
  );
}
