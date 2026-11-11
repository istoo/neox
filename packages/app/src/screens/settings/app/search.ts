import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useActiveHostBuiltinFeatures } from "@/plugins/builtin-features";
import { SETTINGS_PAGE_TITLES, type SettingsPageId } from "./types";

export interface SettingsSearchEntry {
  pageId: SettingsPageId;
  /** Title of the row, as translated by the locale files. */
  titleKey: string;
  /** Extra words a search may use: synonyms in English and Chinese. */
  keywords?: readonly string[];
}

export interface SettingsSearchGroup {
  pageId: SettingsPageId;
  titleKey: string;
  entries: SettingsSearchEntry[];
}

/**
 * What the search box can find, and where each row lives. The myna pages
 * list their own rows; the appearance card is its own page.
 */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  // Appearance: theme, fonts, sizes and syntax.
  {
    pageId: "appearance",
    titleKey: "settings.appearance.theme.title",
    keywords: ["theme", "appearance", "dark", "light", "主题", "外观", "深色", "浅色"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.fonts.interfaceFont",
    keywords: ["font", "typeface", "字体", "界面"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.fonts.codeFont",
    keywords: ["font", "code", "mono", "字体", "代码"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.fonts.interfaceSize",
    keywords: ["size", "font", "text", "字号", "文字", "大小"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.fonts.contentSize",
    keywords: ["size", "font", "chat", "字号", "内容"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.layout.contentWidth",
    keywords: ["width", "layout", "宽度", "布局"],
  },
  {
    pageId: "appearance",
    titleKey: "settings.appearance.syntax.highlightTheme",
    keywords: ["syntax", "highlight", "code", "语法", "高亮"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.colorblind",
    keywords: ["colorblind", "colors", "accessibility", "色盲", "配色", "辅助功能"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.reduceMotion",
    keywords: ["motion", "animation", "accessibility", "动效", "动画", "辅助功能"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.preventSleep",
    keywords: ["sleep", "awake", "power", "休眠", "睡眠", "唤醒"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.launchAtLogin",
    keywords: ["login", "startup", "launch", "登录", "启动"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.confirmQuit",
    keywords: ["quit", "exit", "confirm", "退出", "确认"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.dockVisible",
    keywords: ["dock", "macos", "icon", "程序坞"],
  },
  {
    pageId: "general",
    titleKey: "settings.pages.general.gatewayMode.label",
    keywords: ["gateway", "mode", "headless", "server", "网关", "模式"],
  },
  {
    pageId: "general",
    titleKey: "settings.general.language.label",
    keywords: ["language", "locale", "语言"],
  },
  {
    pageId: "general",
    titleKey: "settings.general.setup.label",
    keywords: ["setup", "onboarding", "welcome", "向导", "引导"],
  },
  {
    pageId: "general",
    titleKey: "settings.general.sending",
    keywords: ["send", "enter", "发送"],
  },
  {
    pageId: "general",
    titleKey: "settings.layout.openInSidePane.title",
    keywords: ["open", "location", "side pane", "打开", "位置"],
  },
  // Network and sharing.
  {
    pageId: "network",
    titleKey: "settings.pages.network.proxy",
    keywords: ["proxy", "http", "network", "代理", "网络"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.gateway",
    keywords: ["gateway", "port", "地址", "端口", "网关"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.keys",
    keywords: ["key", "token", "密钥"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.advanced",
    keywords: ["advanced", "lan", "cors", "allow", "share", "局域网", "共享", "跨域", "允许"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.allowIPs",
    keywords: ["allow", "ip", "cidr", "whitelist", "白名单", "地址", "网段"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.corsOrigins",
    keywords: ["cors", "origin", "browser", "跨域", "来源", "浏览器"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.githubToken",
    keywords: ["github", "token", "library", "rate limit", "令牌", "资源库"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.browserAccess",
    keywords: ["browser", "web page", "link", "key", "port", "浏览器", "网页", "链接", "端口"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.connections",
    keywords: ["connection", "relay", "remote", "连接", "远程"],
  },
  {
    pageId: "network",
    titleKey: "settings.pages.network.pairDevice",
    keywords: ["pair", "device", "配对", "设备"],
  },
  // Privacy.
  {
    pageId: "privacy",
    titleKey: "settings.pages.privacy.masking",
    keywords: ["mask", "redact", "privacy", "secret", "脱敏", "隐私", "密钥"],
  },
  {
    pageId: "privacy",
    titleKey: "settings.pages.privacy.agentsFoundLater",
    keywords: ["sessions", "history", "read", "agents", "会话", "历史", "读取"],
  },
  {
    pageId: "privacy",
    titleKey: "settings.pages.privacy.shareUsage",
    keywords: [
      "telemetry",
      "analytics",
      "usage",
      "anonymous",
      "privacy",
      "遥测",
      "统计",
      "匿名",
      "用量",
    ],
  },
  {
    pageId: "privacy",
    titleKey: "settings.pages.privacy.shareAgents",
    keywords: [
      "agents",
      "providers",
      "models",
      "usage",
      "telemetry",
      "代理",
      "模型来源",
      "模型",
      "统计",
    ],
  },
  // Observability.
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.recentCalls",
    keywords: ["calls", "requests", "trace", "调用", "请求"],
  },
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.usage",
    keywords: ["usage", "tokens", "cost", "用量", "令牌", "费用"],
  },
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.diagnostics",
    keywords: ["diagnostics", "logs", "诊断", "日志"],
  },
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.otelEnabled",
    keywords: ["otel", "opentelemetry", "traces", "langfuse", "collector", "链路", "追踪"],
  },
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.otelEndpoint",
    keywords: ["otlp", "endpoint", "headers", "端点", "请求头"],
  },
  {
    pageId: "observability",
    titleKey: "settings.pages.observability.otelSessions",
    keywords: ["session", "conversation", "trace", "transcript", "会话", "对话", "追踪"],
  },
  // Sync and backup.
  {
    pageId: "sync",
    titleKey: "settings.pages.sync.backups",
    keywords: ["backup", "restore", "备份", "恢复"],
  },
  {
    pageId: "sync",
    titleKey: "settings.pages.sync.storageLabel",
    keywords: ["storage", "data", "存储", "数据"],
  },
  // About.
  {
    pageId: "about",
    titleKey: "settings.about.appVersion",
    keywords: ["version", "about", "版本", "关于"],
  },
  {
    pageId: "about",
    titleKey: "changelog.title",
    keywords: ["what's new", "release notes", "更新", "新版本"],
  },
  {
    pageId: "about",
    titleKey: "settings.about.releaseChannel.label",
    keywords: ["channel", "beta", "stable", "通道", "测试版"],
  },
  {
    pageId: "about",
    titleKey: "settings.pages.about.updateAutoCheck",
    keywords: ["update", "auto", "interval", "更新", "自动检查", "间隔"],
  },
  {
    pageId: "about",
    titleKey: "settings.pages.about.autoDownload",
    keywords: ["download", "update", "下载", "更新"],
  },
  {
    pageId: "about",
    titleKey: "settings.about.updates.label",
    keywords: ["update", "upgrade", "更新", "升级"],
  },
  {
    pageId: "about",
    titleKey: "settings.about.connectedHosts",
    keywords: ["host", "version", "主机", "版本"],
  },
  // Neolix-only pages.
  { pageId: "sidebar", titleKey: "settings.sections.sidebar", keywords: ["sidebar", "侧边栏"] },
  { pageId: "chat", titleKey: "settings.sections.chat", keywords: ["chat", "聊天", "对话"] },
  {
    pageId: "terminal",
    titleKey: "settings.sections.terminal",
    keywords: ["terminal", "shell", "终端"],
  },
  { pageId: "browser", titleKey: "settings.sections.browser", keywords: ["browser", "浏览器"] },
  { pageId: "editor", titleKey: "settings.sections.editor", keywords: ["editor", "编辑器"] },
  { pageId: "files", titleKey: "settings.sections.files", keywords: ["files", "文件"] },
  {
    pageId: "shortcuts",
    titleKey: "settings.sections.shortcuts",
    keywords: ["keyboard", "shortcut", "快捷键"],
  },
  {
    pageId: "integrations",
    titleKey: "settings.sections.integrations",
    keywords: ["cli", "command line", "集成", "命令行"],
  },
  {
    pageId: "notifications",
    titleKey: "settings.sections.notifications",
    keywords: ["notification", "sound", "通知", "声音"],
  },
  {
    pageId: "permissions",
    titleKey: "settings.sections.permissions",
    keywords: ["permission", "权限"],
  },
  {
    pageId: "diagnostics",
    titleKey: "settings.sections.diagnostics",
    keywords: ["diagnostics", "诊断"],
  },
];

/** Settings rows whose translated title and English title contain every word. */
export function searchSettingsEntries(
  query: string,
  translate: { current: (key: string) => string; english: (key: string) => string },
  hiddenPageIds: ReadonlySet<string> = new Set(),
): SettingsSearchGroup[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const groups = new Map<SettingsPageId, SettingsSearchGroup>();
  for (const entry of SETTINGS_SEARCH_INDEX) {
    if (hiddenPageIds.has(entry.pageId)) continue;
    const haystack = [
      translate.current(entry.titleKey),
      translate.english(entry.titleKey),
      ...(entry.keywords ?? []),
    ]
      .join(" ")
      .toLowerCase();
    if (!words.every((word) => haystack.includes(word))) {
      continue;
    }
    let group = groups.get(entry.pageId);
    if (!group) {
      group = {
        pageId: entry.pageId,
        titleKey: SETTINGS_PAGE_TITLES[entry.pageId],
        entries: [],
      };
      groups.set(entry.pageId, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

/** The search box's matches, in sidebar page order. */
export function useSettingsSearch(query: string): SettingsSearchGroup[] {
  const { t, i18n } = useTranslation();
  const { hidden } = useActiveHostBuiltinFeatures();
  const english = useMemo(() => i18n.getFixedT("en"), [i18n]);
  return useMemo(
    () =>
      searchSettingsEntries(
        query,
        {
          current: (key) => t(key),
          english: (key) => english(key),
        },
        hidden.settingsPages,
      ),
    [english, hidden.settingsPages, query, t],
  );
}
