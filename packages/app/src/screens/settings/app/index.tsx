import {
  Bell,
  Code2,
  Files,
  Globe,
  Info,
  Keyboard,
  LibraryBig,
  MessageSquare,
  Network,
  Palette,
  PanelLeft,
  Puzzle,
  Settings,
  Shield,
  SquareTerminal,
  Stethoscope,
} from "lucide-react-native";
import type { SettingsSectionSlug } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import { AppearanceSection } from "@/screens/settings/appearance/appearance-section";
import { SidebarNavSection } from "@/screens/settings/sidebar/sidebar-nav-section";
import { ChatSection } from "@/screens/settings/chat/chat-section";
import { TerminalSection } from "@/screens/settings/terminal/terminal-section";
import { BrowserDataSection } from "@/desktop/browser/settings/browser-data-section";
import { EditorSection } from "@/screens/settings/editor-section";
import { FilesSection } from "@/screens/settings/files-section";
import { KeyboardShortcutsSection } from "@/screens/settings/keyboard-shortcuts-section";
import { IntegrationsSection } from "@/desktop/components/integrations-section";
import { DesktopNotificationsSection } from "@/desktop/components/desktop-notifications-section";
import { DesktopPermissionsSection } from "@/desktop/components/desktop-permissions-section";
import { AboutPage } from "./about-page";
import { DiagnosticsPage } from "./diagnostics-page";
import { GeneralPage } from "./general-page";
import { NetworkPage } from "./network-page";
import { ObservabilityPage } from "./observability-page";
import { PrivacyPage } from "./privacy-page";
import { SyncPage } from "./sync-page";
import { SETTINGS_PAGE_TITLES, type SettingsPage, type SettingsPageId } from "./types";

export { AboutPage } from "./about-page";
export { DiagnosticsPage } from "./diagnostics-page";
export { GeneralPage } from "./general-page";
export { ModelsPage } from "./models-page";
export { NetworkPage } from "./network-page";
export { ObservabilityPage } from "./observability-page";
export { PrivacyPage } from "./privacy-page";
export { QuotaPage } from "./quota-page";
export { SyncPage } from "./sync-page";
export { SETTINGS_PAGE_TITLES } from "./types";
export type { SettingsPage, SettingsPageId } from "./types";
export {
  SETTINGS_SEARCH_INDEX,
  searchSettingsEntries,
  useSettingsSearch,
  type SettingsSearchEntry,
  type SettingsSearchGroup,
} from "./search";

/**
 * Every app-level settings page, in sidebar order: myna's parts first, then
 * the pages Neolix has and myna does not. Host settings stay on their host
 * pages and are reached from the myna pages that map to them.
 */
export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: "general",
    titleKey: SETTINGS_PAGE_TITLES.general,
    icon: Settings,
    Component: GeneralPage,
  },
  {
    id: "appearance",
    titleKey: SETTINGS_PAGE_TITLES.appearance,
    icon: Palette,
    Component: AppearanceSection,
  },
  {
    id: "network",
    titleKey: SETTINGS_PAGE_TITLES.network,
    icon: Network,
    Component: NetworkPage,
  },
  {
    id: "privacy",
    titleKey: SETTINGS_PAGE_TITLES.privacy,
    icon: Shield,
    Component: PrivacyPage,
  },
  {
    id: "observability",
    titleKey: SETTINGS_PAGE_TITLES.observability,
    icon: Stethoscope,
    Component: ObservabilityPage,
  },
  {
    id: "sync",
    titleKey: SETTINGS_PAGE_TITLES.sync,
    icon: LibraryBig,
    Component: SyncPage,
  },
  {
    id: "sidebar",
    titleKey: SETTINGS_PAGE_TITLES.sidebar,
    icon: PanelLeft,
    Component: SidebarNavSection,
  },
  {
    id: "chat",
    titleKey: SETTINGS_PAGE_TITLES.chat,
    icon: MessageSquare,
    Component: ChatSection,
  },
  {
    id: "terminal",
    titleKey: SETTINGS_PAGE_TITLES.terminal,
    icon: SquareTerminal,
    Component: TerminalSection,
  },
  {
    id: "browser",
    titleKey: SETTINGS_PAGE_TITLES.browser,
    icon: Globe,
    Component: BrowserDataSection,
    desktopOnly: true,
  },
  {
    id: "editor",
    titleKey: SETTINGS_PAGE_TITLES.editor,
    icon: Code2,
    Component: EditorSection,
    webOnly: true,
  },
  {
    id: "files",
    titleKey: SETTINGS_PAGE_TITLES.files,
    icon: Files,
    Component: FilesSection,
  },
  {
    id: "shortcuts",
    titleKey: SETTINGS_PAGE_TITLES.shortcuts,
    icon: Keyboard,
    Component: KeyboardShortcutsSection,
    hardwareKeyboardOnly: true,
  },
  {
    id: "integrations",
    titleKey: SETTINGS_PAGE_TITLES.integrations,
    icon: Puzzle,
    Component: IntegrationsSection,
    desktopOnly: true,
  },
  {
    id: "notifications",
    titleKey: SETTINGS_PAGE_TITLES.notifications,
    icon: Bell,
    Component: DesktopNotificationsSection,
    desktopOnly: true,
  },
  {
    id: "permissions",
    titleKey: SETTINGS_PAGE_TITLES.permissions,
    icon: Shield,
    Component: DesktopPermissionsSection,
    desktopOnly: true,
  },
  {
    id: "diagnostics",
    titleKey: SETTINGS_PAGE_TITLES.diagnostics,
    icon: Stethoscope,
    Component: DiagnosticsPage,
  },
  {
    id: "about",
    titleKey: SETTINGS_PAGE_TITLES.about,
    icon: Info,
    Component: AboutPage,
  },
];

export const SETTINGS_PAGE_BY_ID = new Map<SettingsPageId, SettingsPage>(
  SETTINGS_PAGES.map((page) => [page.id, page]),
);

/**
 * A section route's slug to the page that draws it. Every current section maps
 * to itself; the map stays as the indirection `settings-screen` uses.
 */
export const SETTINGS_PAGE_LEGACY_SECTION_MAP: Partial<
  Record<SettingsSectionSlug, SettingsPageId>
> = {
  general: "general",
  quota: "quota",
  network: "network",
  models: "models",
  privacy: "privacy",
  observability: "observability",
  sync: "sync",
  appearance: "appearance",
  sidebar: "sidebar",
  chat: "chat",
  terminal: "terminal",
  browser: "browser",
  editor: "editor",
  files: "files",
  shortcuts: "shortcuts",
  integrations: "integrations",
  notifications: "notifications",
  permissions: "permissions",
  diagnostics: "diagnostics",
  about: "about",
};

export function isSettingsPageAvailable(
  page: SettingsPage,
  isDesktopApp: boolean,
  hardwareKeyboardPresent: boolean,
): boolean {
  if (page.hardwareKeyboardOnly && !hardwareKeyboardPresent) {
    return false;
  }
  return (!page.desktopOnly || isDesktopApp) && (!page.webOnly || isWeb);
}
