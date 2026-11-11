import type { ComponentType } from "react";

/** The myna settings parts, then the Neolix-only pages that have no myna part. */
export type SettingsPageId =
  | "general"
  | "appearance"
  | "quota"
  | "network"
  | "models"
  | "privacy"
  | "observability"
  | "sync"
  | "about"
  | "sidebar"
  | "chat"
  | "terminal"
  | "browser"
  | "editor"
  | "files"
  | "shortcuts"
  | "integrations"
  | "notifications"
  | "permissions"
  | "diagnostics";

export interface SettingsPage {
  id: SettingsPageId;
  titleKey: string;
  icon: ComponentType<{ size: number; color: string; strokeWidth?: number }>;
  Component: ComponentType;
  desktopOnly?: boolean;
  webOnly?: boolean;
  hardwareKeyboardOnly?: boolean;
}

/**
 * Page titles. Myna's parts need new keys; the Neolix-only pages reuse the
 * sidebar section labels they always had.
 */
export const SETTINGS_PAGE_TITLES: Record<SettingsPageId, string> = {
  general: "settings.sections.general",
  appearance: "settings.sections.appearance",
  quota: "settings.pages.quota.title",
  network: "settings.pages.network.title",
  models: "settings.pages.models.title",
  privacy: "settings.pages.privacy.title",
  observability: "settings.pages.observability.title",
  sync: "settings.pages.sync.title",
  about: "settings.sections.about",
  sidebar: "settings.sections.sidebar",
  chat: "settings.sections.chat",
  terminal: "settings.sections.terminal",
  browser: "settings.sections.browser",
  editor: "settings.sections.editor",
  files: "settings.sections.files",
  shortcuts: "settings.sections.shortcuts",
  integrations: "settings.sections.integrations",
  notifications: "settings.sections.notifications",
  permissions: "settings.sections.permissions",
  diagnostics: "settings.sections.diagnostics",
};
