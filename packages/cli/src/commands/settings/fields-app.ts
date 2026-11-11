import { settingValue, shown, type SettingType } from "./fields.js";

/**
 * The settings the app keeps in AsyncStorage, where the daemon can't read
 * them. The app pushes a copy to the daemon (sync.app_settings.export), so
 * `neolix settings` reads that copy and writes through sync.app_settings.patch;
 * the app applies a patch as it receives it. myna's own settings live in one
 * file, so its CLI reads them directly.
 */

export interface AppSettingField {
  key: string;
  type: SettingType;
  integer?: boolean;
  choices?: string[];
  default?: unknown;
}

const THEMES = [
  "auto",
  "light",
  "dark",
  "zinc",
  "midnight",
  "claude",
  "ghostty",
  "pureBlack",
  "plugin",
];
const LANGUAGES = ["system", "ar", "en", "es", "fr", "ja", "ko", "pt-BR", "ru", "zh-CN"];
const SYNTAX_THEMES = [
  "github",
  "catppuccin",
  "dracula",
  "tokyo-night",
  "one",
  "nord",
  "gruvbox",
  "solarized",
];

/** The app's own settings, by the field names its store uses. */
const UNSORTED: readonly AppSettingField[] = [
  { key: "autoExpandReasoning", type: "on|off", default: false },
  { key: "balanceAlert", type: "number", default: 0 },
  {
    key: "chatDisplay",
    type: "text",
    choices: ["full", "collapseToolCalls", "collapseTurns"],
    default: "collapseTurns",
  },
  { key: "chatOutlineEnabled", type: "on|off", default: true },
  { key: "codeFontSize", type: "number", integer: true, default: 12 },
  { key: "colorblindMode", type: "on|off", default: false },
  // The default base and content font sizes differ between web and native,
  // so these name none: a reset unsets them and the app picks its own default.
  { key: "contentFontSize", type: "number", integer: true },
  { key: "contentMaxWidth", type: "number", integer: true, default: null },
  { key: "currency", type: "text", choices: ["usd", "cny"], default: "usd" },
  { key: "filePanelAssociations", type: "JSON", default: {} },
  { key: "gatewayMode", type: "text", choices: ["auto", "on", "off"], default: "auto" },
  { key: "language", type: "text", choices: LANGUAGES, default: "system" },
  { key: "manageBuiltInDaemon", type: "on|off", default: true },
  { key: "monoFontFamily", type: "text", default: "" },
  { key: "numberUnits", type: "text", choices: ["compact", "wan"], default: "compact" },
  {
    key: "openInSidePane",
    type: "JSON",
    default: {
      explorerFiles: false,
      diffs: false,
      chatFiles: false,
      diffFiles: false,
      subagents: false,
    },
  },
  { key: "pluginThemeId", type: "text", default: null },
  {
    key: "pullRequestOpenLocation",
    type: "text",
    choices: ["main", "side", "explorer"],
    default: "explorer",
  },
  { key: "reduceMotion", type: "on|off", default: false },
  { key: "releaseChannel", type: "text", choices: ["stable", "beta"], default: "stable" },
  { key: "resetReminderHours", type: "number", default: 0 },
  { key: "sendBehavior", type: "text", choices: ["steer", "interrupt", "queue"], default: "steer" },
  { key: "sendShortcut", type: "text", choices: ["enter", "mod-enter"], default: "enter" },
  {
    key: "serviceUrlBehavior",
    type: "text",
    choices: ["ask", "in-app", "external"],
    default: "ask",
  },
  {
    key: "sidebarChecksDisplay",
    type: "text",
    choices: ["iconAndText", "icon", "none"],
    default: "iconAndText",
  },
  { key: "sidebarFooterItems", type: "JSON", default: [] },
  { key: "sidebarNavItems", type: "JSON", default: [] },
  {
    key: "sidebarRowItems",
    type: "JSON",
    default: {
      branch: false,
      project: false,
      host: true,
      changeRequest: true,
      services: true,
      labels: true,
    },
  },
  {
    key: "sidebarWorkspaceTrailing",
    type: "text",
    choices: ["diff", "timestamp", "none"],
    default: "timestamp",
  },
  { key: "syntaxTheme", type: "text", choices: SYNTAX_THEMES, default: "one" },
  { key: "terminalScrollbackLines", type: "number", integer: true, default: 10_000 },
  { key: "theme", type: "text", choices: THEMES, default: "auto" },
  { key: "uiBaseFontSize", type: "number", integer: true },
  { key: "uiFontFamily", type: "text", default: "" },
  {
    key: "usage",
    type: "JSON",
    default: { displayAs: "used", pins: null, serverId: null },
  },
  { key: "usageAlertPercent", type: "number", default: 0 },
  { key: "vimKeybindings", type: "on|off", default: false },
  { key: "workspaceTitleSource", type: "text", choices: ["title", "branch"], default: "title" },
];

const APP_FIELDS: readonly AppSettingField[] = [...UNSORTED].sort((left, right) =>
  left.key.localeCompare(right.key),
);

const BY_KEY = new Map(APP_FIELDS.map((field) => [field.key, field]));

/** The app field a key names, or null when it belongs to config.json. */
export function appSettingField(key: string): AppSettingField | null {
  return BY_KEY.get(key) ?? null;
}

export function appSettingFields(): readonly AppSettingField[] {
  return APP_FIELDS;
}

/** Text as the JSON the app saves, for a field the app owns. */
export function appSettingValue(field: AppSettingField, text: string): unknown {
  return settingValue(field, text);
}

export function shownAppSetting(value: unknown): string {
  return shown(value);
}
