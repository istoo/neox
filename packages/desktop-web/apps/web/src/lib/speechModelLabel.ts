// FILE: speechModelLabel.ts
// Purpose: The daemon names local speech models "<Model> (<Language>)" in English. The model name
//          is a product name and stays; the language is translated for the current locale.
// Layer: Web settings presentation

import { t } from "~/i18n";

const LANGUAGE_KEYS: Readonly<Record<string, string>> = {
  english: "settings:speechLanguage_english",
  "us english": "settings:speechLanguage_usEnglish",
  "british english": "settings:speechLanguage_britishEnglish",
  chinese: "settings:speechLanguage_chinese",
  "chinese and english": "settings:speechLanguage_chineseEnglish",
  russian: "settings:speechLanguage_russian",
  japanese: "settings:speechLanguage_japanese",
  german: "settings:speechLanguage_german",
  french: "settings:speechLanguage_french",
  spanish: "settings:speechLanguage_spanish",
};

/** A local speech model's label with its language in the UI language; unknown ones as-is. */
export function speechModelDisplayLabel(label: string, translate: typeof t = t): string {
  const match = /^(.*?)\s*\(([^)]+)\)$/.exec(label.trim());
  if (!match) return label;
  const key = LANGUAGE_KEYS[match[2]!.trim().toLowerCase()];
  return key
    ? translate("settings:speechModelWithLanguage", { model: match[1], language: translate(key) })
    : label;
}
