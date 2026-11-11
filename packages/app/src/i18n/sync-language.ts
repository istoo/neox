import { isWeb } from "@/constants/platform";
import type { SupportedLocale } from "./locales";

interface I18nLanguageController {
  language?: string;
  changeLanguage: (language: SupportedLocale) => Promise<unknown>;
}

type I18nErrorReporter = (message: string, error: unknown) => void;

interface DocumentLanguageRoot {
  lang: string;
}

export const reportI18nError: I18nErrorReporter = (message, error) => {
  console.error(message, error);
};

/**
 * Keeps the document language in step with the app language. The web shell starts with
 * Expo's `%LANG_ISO_CODE%` placeholder, which resolves to `en` regardless of the app setting,
 * so screen readers and CJK font selection would otherwise ignore the user's choice.
 */
export function syncDocumentLanguage(
  locale: SupportedLocale,
  root: DocumentLanguageRoot | undefined = typeof document === "undefined"
    ? undefined
    : document.documentElement,
): void {
  if (!isWeb || !root) return;
  root.lang = locale;
}

export function ensureI18nLanguageForRender(
  locale: SupportedLocale,
  i18n: I18nLanguageController,
  reportError: I18nErrorReporter = reportI18nError,
): void {
  syncDocumentLanguage(locale);

  if (i18n.language === locale) {
    return;
  }

  i18n
    .changeLanguage(locale)
    .catch((error) => reportError("[i18n] Failed to change language", error));
}
