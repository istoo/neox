import { useMemo } from "react";
import { createInstance, type i18n as I18nInstance } from "i18next";
import { initReactI18next, useTranslation as useReactTranslation } from "react-i18next";

import { APP_SETTINGS_STORAGE_KEY } from "../appSettingsStorage";
import {
  type LanguagePreference,
  type SupportedLocale,
  readLanguagePreference,
  resolveLanguagePreference,
  resolveLocale,
  UI_LOCALES,
} from "./locale";
import { uiLocalizationResources } from "@synara/shared/uiLocalizationResources";
import { UI_LOCALE_REGISTRY, isUiMessageKey } from "@synara/shared/uiLocale";

function browserLanguages(): readonly string[] {
  try {
    const nativeLanguages =
      typeof window === "undefined" ? undefined : window.desktopBridge?.getSystemLanguages?.();
    if (nativeLanguages?.length) return nativeLanguages;
  } catch {
    // An older or unavailable native bridge must not prevent the renderer from booting.
  }
  return globalThis.navigator?.languages?.length
    ? globalThis.navigator.languages
    : globalThis.navigator?.language
      ? [globalThis.navigator.language]
      : [];
}

function storedPreference(): LanguagePreference {
  return readLanguagePreference();
}

let preference = storedPreference();
let synchronizedDesktopPreference:
  | {
      setter: NonNullable<NonNullable<Window["desktopBridge"]>["setLanguagePreference"]>;
      preference: LanguagePreference;
    }
  | undefined;

function syncDesktopLanguage(force = false): void {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const setter = bridge?.setLanguagePreference;
  if (typeof setter !== "function") return;
  const nativePreference = resolveLanguagePreference(preference);
  if (
    !force &&
    synchronizedDesktopPreference?.setter === setter &&
    synchronizedDesktopPreference.preference === nativePreference
  )
    return;
  const pending = { setter, preference: nativePreference };
  synchronizedDesktopPreference = pending;
  const synchronize = async () => {
    try {
      await setter.call(bridge, pending.preference);
    } catch (error) {
      if (synchronizedDesktopPreference === pending) synchronizedDesktopPreference = undefined;
      console.warn("[i18n] Could not synchronize the native language preference.", error);
    }
  };
  void synchronize();
}

/**
 * Neox branding overlay: the shared locale files stay byte-identical to the
 * upstream Synara resources (so cherry-picks keep working), but every
 * user-visible English brand mention is rendered as Neox. Only the proper
 * noun is replaced; message keys, URLs and SYNARA_* environment variable names
 * are untouched.
 */
function rebrandSynaraMessages<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("Synara", "Neox") as T;
  if (Array.isArray(value)) return value.map(rebrandSynaraMessages) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, rebrandSynaraMessages(child)]),
    ) as T;
  }
  return value;
}

const neolixLocalizationResources: typeof uiLocalizationResources =
  rebrandSynaraMessages(uiLocalizationResources);

export const i18n: I18nInstance = createInstance();
void i18n.use(initReactI18next).init({
  lng: resolveLocale(
    preference,
    resolveLanguagePreference(preference) === "system" ? browserLanguages() : [],
  ),
  fallbackLng: "en",
  supportedLngs: [...UI_LOCALES],
  resources: neolixLocalizationResources,
  ns: Object.keys(uiLocalizationResources.en),
  defaultNS: "common",
  initAsync: false,
  keySeparator: false,
  nsSeparator: ":",
  interpolation: { escapeValue: false },
  react: { useSuspense: false, transSupportBasicHtmlNodes: false },
});

// Chinese templates put a space around each placeholder so Latin values read well
// ("打开 VS Code"). A Chinese value must sit flush ("打开审查"), so the value's edges are
// marked while i18next interpolates and only the template's spaces at those marks are judged.
const VALUE_START = "";
const VALUE_END = "";
const CJK = "\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef";
const SPACE_BEFORE_CJK_VALUE = new RegExp(`([${CJK}]) ${VALUE_START}(?=[${CJK}])`, "g");
const SPACE_AFTER_CJK_VALUE = new RegExp(`(?<=[${CJK}])${VALUE_END} (?=[${CJK}])`, "g");
const VALUE_MARKS = new RegExp(`[${VALUE_START}${VALUE_END}]`, "g");
// i18next reads these from the same object as the interpolation values; marking them would
// change which key resolves (`context`) or what language/namespace is used.
const I18NEXT_OPTION_NAMES = new Set(["context", "defaultValue", "lng", "lngs", "ns", "ordinal"]);

function translateWithCjkSpacing(message: string, values: Record<string, unknown>): string {
  const marked = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      name,
      typeof value === "string" && !I18NEXT_OPTION_NAMES.has(name)
        ? `${VALUE_START}${value}${VALUE_END}`
        : value,
    ]),
  );
  return i18n
    .t(message, { ...marked, returnObjects: false })
    .replace(SPACE_BEFORE_CJK_VALUE, `$1${VALUE_START}`)
    .replace(SPACE_AFTER_CJK_VALUE, VALUE_END)
    .replace(VALUE_MARKS, "");
}

export function t(message: string, values?: Record<string, unknown>): string {
  if (!isUiMessageKey(message, uiLocalizationResources.en)) return message;
  if (values && i18n.language.startsWith("zh")) return translateWithCjkSpacing(message, values);
  return i18n.t(message, { ...values, returnObjects: false });
}

/**
 * Translates an open-ended key, falling back to `defaultValue` when the
 * resources do not have it. Server payloads (catalog descriptions, bridge
 * errors) are keyed this way: a host that adds an entry keeps its English
 * text until the locale files catch up.
 */
export function tWithDefault(
  message: string,
  defaultValue: string,
  values?: Record<string, unknown>,
): string {
  return i18n.t(message, { ...values, defaultValue, returnObjects: false });
}

// A factory call ties identity to the subscription value without closing over its old
// language. An unused useCallback dependency is removed by React Compiler.
function createTranslationSnapshot(_subscription: unknown): { t: typeof t; formatLocale: string } {
  return {
    t: (message, values) => t(message, values),
    formatLocale: getFormatLocale(),
  };
}

export function useTranslation(): { t: typeof t; locale: string; formatLocale: string } {
  const { t: reactiveTranslator, i18n: instance } = useReactTranslation(undefined, { i18n });
  // React Compiler needs a new identity on a language change. Delegating to the current
  // runtime also keeps callbacks already installed in native menus/event listeners current.
  const snapshot = useMemo(
    () => createTranslationSnapshot(reactiveTranslator),
    [reactiveTranslator],
  );
  return { ...snapshot, locale: instance.language };
}

export function getFormatLocale(): string {
  return i18n.language;
}

function updateDocumentLanguage(locale: SupportedLocale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = UI_LOCALE_REGISTRY[locale].direction;
  }
}

/** Changes only the runtime; the existing app-settings hook owns persistence. */
export function setLanguagePreference(next: LanguagePreference): void {
  const locale = resolveLocale(
    next,
    resolveLanguagePreference(next) === "system" ? browserLanguages() : [],
  );
  if (preference !== next || i18n.language !== locale) {
    preference = next;
    void i18n.changeLanguage(locale);
  }
  updateDocumentLanguage(locale);
  syncDesktopLanguage();
}

/** Install before the first render; app settings already broadcasts same-tab writes. */
export function initializeI18n(): () => void {
  setLanguagePreference(storedPreference());
  if (typeof window === "undefined") return () => {};

  const syncPreference = () => setLanguagePreference(storedPreference());
  const onLanguageChange = () => {
    if (resolveLanguagePreference(preference) !== "system") return;
    // Refresh native candidates once: preload values would otherwise stay frozen at launch.
    const locale = resolveLocale(preference, browserLanguages());
    void i18n.changeLanguage(locale);
    updateDocumentLanguage(locale);
    syncDesktopLanguage(true);
  };
  const onStorageChange = (event: StorageEvent) => {
    if (event.key === null || event.key === APP_SETTINGS_STORAGE_KEY) {
      syncPreference();
    }
  };
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<{ key: string }>).detail?.key === APP_SETTINGS_STORAGE_KEY) {
      syncPreference();
    }
  };

  window.addEventListener("languagechange", onLanguageChange);
  window.addEventListener("storage", onStorageChange);
  window.addEventListener("synara:local_storage_change", onLocalChange);
  return () => {
    window.removeEventListener("languagechange", onLanguageChange);
    window.removeEventListener("storage", onStorageChange);
    window.removeEventListener("synara:local_storage_change", onLocalChange);
  };
}
