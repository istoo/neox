// FILE: neolixFeatures.ts
// Purpose: Entry-point switches for Synara surfaces Neox has no backend for.
//          Component files stay in the tree so upstream cherry-picks remain simple;
//          the flags only keep their UI (and startup RPCs) out of this build.
//          A flag turns on when the Electron preload exposes the matching
//          `window.desktopBridge` capability; plain browsers keep them hidden.
// Layer: Web feature gate

function desktopBridgeProvides(read: () => unknown): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Boolean(read());
  } catch {
    return false;
  }
}

/** Neox 无账号后端：账号状态查询与账号 UI 一起关闭。 */
export const NEOLIX_ACCOUNT_UI_ENABLED = false;
/**
 * Neox 无浏览器会话鉴权（bridge 不提供 `/api/auth/*`，远程访问走 daemon 配对）：
 * 「高级」里的本浏览器会话区块与其会话查询一起关闭，避免每次进页 404 重试。
 */
export const NEOLIX_BROWSER_AUTH_ENABLED = false;

/** Neox 无 Computer Use 后端：隐藏 Computer 面板、预览与设置分区。 */
export const NEOLIX_COMPUTER_UI_ENABLED = false;

/** Neox 无 device 后端：隐藏 iOS 模拟器面板与线程页入口。 */
export const NEOLIX_DEVICE_UI_ENABLED = false;

/** Neox 无 AppSnap 捕获后端：隐藏 AppSnap 协调器、欢迎页与设置分区。 */
export const NEOLIX_APPSNAP_UI_ENABLED = false;

/** Neox 无 projectAgent 后端：隐藏 Project/Groups 面板，且不再拉取 summaries。 */
export const NEOLIX_PROJECT_AGENT_UI_ENABLED = false;

/** Neox 无 GitHub inbox 后端：隐藏 Code review 列表入口（PR 详情 dock 保留）。 */
export const NEOLIX_PULL_REQUESTS_INBOX_ENABLED = false;

/** Neox 无 sync key 配对后端：隐藏 SyncKeyPairingPanel。 */
export const NEOLIX_SYNC_KEY_UI_ENABLED = false;

/** Neox 无 keep-awake 服务：浏览器里隐藏；Electron preload 提供 keepAwake 时启用。 */
export const NEOLIX_KEEP_AWAKE_UI_ENABLED = desktopBridgeProvides(
  () => window.desktopBridge?.keepAwake,
);

/**
 * 桌面 OS 集成（打开项目、深链接、Dock 角标、新窗口、CLI 安装）由 Electron 壳提供；
 * 浏览器里没有这些 IPC，入口保持隐藏。
 */
export const NEOLIX_DESKTOP_OS_INTEGRATION_UI_ENABLED = desktopBridgeProvides(
  () => window.neolixDesktop?.invoke,
);

/** 新窗口入口需要壳层的 `window.openNew`；浏览器里隐藏。 */
export const NEOLIX_OPEN_IN_NEW_WINDOW_UI_ENABLED = desktopBridgeProvides(
  () => window.neolixDesktop?.window?.openNew,
);

/** Neox 无 snooze 调度后端：隐藏 Snooze 菜单与已休眠分区。 */
export const NEOLIX_SNOOZE_UI_ENABLED = false;

/** Neox 无置顶消息后端：隐藏消息 Pin/Unpin 操作与置顶分区。 */
export const NEOLIX_PINNED_MESSAGES_UI_ENABLED = false;

/** Neox 无持久 Goal 后端：隐藏 Goal 输入入口与胶囊。 */
export const NEOLIX_GOAL_UI_ENABLED = false;

/**
 * 功能导览介绍的是 Synara 0.9.2 的多账号、侧聊、交接、中心等功能，Neox 均未开放：
 * 不在首次启动弹出，设置里也不提供重播入口。
 */
export const NEOLIX_FEATURE_TOUR_ENABLED = false;

/** Neox 无 Claude cache review 后端：隐藏缓存审查面板。 */
export const NEOLIX_CLAUDE_CACHE_REVIEW_UI_ENABLED = false;

/** Neox 无 usage-limit 自动恢复后端：隐藏恢复设置与 composer 恢复条。 */
export const NEOLIX_USAGE_LIMIT_RECOVERY_UI_ENABLED = false;

/**
 * Neox daemon 的调度只有 cron / every 两种节奏（bridge `cadenceFromAutomationSchedule`），
 * 「手动」与「仅一次」无法映射，选了只会在创建时报「不支持」：从节奏选择器中隐藏。
 */
export const NEOLIX_AUTOMATION_MANUAL_AND_ONCE_SCHEDULES_ENABLED = false;

/** Neox 无 Reset credits 后端：隐藏 Provider usage 的 credits 重置块。 */
export const NEOLIX_RESET_CREDITS_UI_ENABLED = false;

/** Neox 无 side chat 后端：隐藏 Side chat 快捷键、dock 与设置入口。 */
export const NEOLIX_SIDECHAT_UI_ENABLED = false;

/** Neox 无 provider handoff 后端：隐藏模型选择器里的跨 provider 交接。 */
export const NEOLIX_PROVIDER_HANDOFF_UI_ENABLED = false;

/**
 * Neox daemon 没有 provider CLI 更新 RPC（无 updateProvider），旧 UI 也没有更新入口。
 * 隐藏本页的更新按钮与自动检查分区；更新需在终端运行 provider 自带命令。
 * debt: daemon 提供 provider.update 后改回 true 并接上 bridge handler。
 */
export const NEOLIX_PROVIDER_CLI_UPDATES_ENABLED = false;

/** Neox 无 worktree handoff 后端：隐藏 BranchToolbar 的本地/worktree 交接。 */
export const NEOLIX_WORKTREE_HANDOFF_UI_ENABLED = false;

/** Neox 无 browser vault/cookie 后端：浏览器里隐藏；桌面桥提供 vault 时启用。 */
export const NEOLIX_BROWSER_VAULT_UI_ENABLED = desktopBridgeProvides(
  () => window.desktopBridge?.browser?.vault,
);

/** 打开 Library 目录走桌面 `showInFolder`；浏览器没有文件管理器，隐藏入口。 */
export const NEOLIX_LIBRARY_OPEN_FOLDER_UI_ENABLED = desktopBridgeProvides(
  () => window.desktopBridge?.showInFolder,
);

/** Neox 无 studio output 后端：隐藏 Environment 的 Studio outputs 分区。 */
export const NEOLIX_STUDIO_OUTPUT_UI_ENABLED = false;

/** Neox 无 editor intelligence/debug 后端：隐藏编辑器语言服务与调试面板。 */
export const NEOLIX_EDITOR_INTELLIGENCE_UI_ENABLED = false;

/** Neox 无 Space 元数据后端：隐藏 Spaces 的新建/重命名/编辑/删除入口。 */
export const NEOLIX_SPACE_EDITING_UI_ENABLED = false;

/** Neox 调度运行无已读/归档状态：隐藏自动化运行行的「已读 / 归档」操作（取消运行保留）。 */
export const NEOLIX_AUTOMATION_RUN_TRIAGE_ENABLED = false;

/** Neox 不需要活动引导气泡：不自动弹出，悬停提示仍保留。 */
export const NEOLIX_ACTIVITY_COACHMARK_ENABLED = false;

/** Neox 无多文件夹/改路径后端：隐藏新增项目的附加文件夹与项目菜单的“更改项目路径”。 */
export const NEOLIX_PROJECT_FOLDERS_UI_ENABLED = false;

/** Neox 只提供 PR merge：隐藏 ready/draft/close/reopen 入口（bridge 会拒绝这些动作）。 */
export const NEOLIX_PULL_REQUEST_STATE_ACTIONS_UI_ENABLED = false;

/** Neox 没有 PR 评论写接口：隐藏评论输入框，保留读取到的评论。 */
export const NEOLIX_PULL_REQUEST_COMMENT_COMPOSER_UI_ENABLED = false;

/** Neox 只能把 PR 检出到新 worktree：隐藏 PR 对话框的「本地」检出按钮。 */
export const NEOLIX_PULL_REQUEST_LOCAL_CHECKOUT_ENABLED = false;

/**
 * Neox 无 blame / 按 revision 读文件接口：diff 行不提供 blame 弹层，从 diff 打开编辑时用普通
 * 文件编辑器而不是左右对比编辑器（对比编辑器要读取基准版本）。
 */
export const NEOLIX_GIT_REVISION_READ_ENABLED = false;

/** Neox 无删除 index.lock 接口：分支切换失败提示不带「删除锁并重试」。 */
export const NEOLIX_GIT_INDEX_LOCK_RECOVERY_ENABLED = false;

/**
 * debt: daemon 创建终端不带 HOME/env，额外账号的登录会以默认账号身份运行并覆盖默认账号的登录。
 * 只给默认账号显示登录；daemon 支持按账号登录（或可带 env 的终端）后打开。
 */
export const NEOLIX_EXTRA_ACCOUNT_SIGN_IN_ENABLED = false;

/** 反馈只发往构建时配置的 `VITE_FEEDBACK_ENDPOINT`；未配置时隐藏 /feedback。 */
export const NEOLIX_FEEDBACK_UI_ENABLED = Boolean(import.meta.env.VITE_FEEDBACK_ENDPOINT?.trim());

/** Synara 产品导览讲的是上游功能：打开应用时不自动弹出，设置里仍可手动重放。 */
export const NEOLIX_FEATURE_TOUR_AUTOSTART = false;

/** 保留手动导入项目；首次启动不自动弹出导入公告。 */
export const NEOLIX_PROJECT_IMPORT_ANNOUNCEMENT_ENABLED = false;

/** Neox 无 Hubs/Groups 后端：群组容器、Hub 侧栏与后台工作全部关闭。 */
export const NEOLIX_GROUPS_UI_ENABLED = false;

/** Neox 无 Inline visuals 后端：组件规格渲染与工作日志条目关闭。 */
export const NEOLIX_INLINE_VISUALS_UI_ENABLED = false;

/** Neox 无 todo 后端：Tasks（todo）surface 关闭，Kanban 占据同一 slot。 */
export const NEOLIX_TASKS_UI_ENABLED = false;

/**
 * 看板对 Neox 没有价值：入口（图标栏、侧栏导航、侧栏设置、搜索/命令面板）全部门控掉，
 * 代码与 /kanban 路由保留；直接访问 /kanban 时重定向首页。
 */
export const NEOLIX_KANBAN_UI_ENABLED = false;

/**
 * daemon 没有实现的 Synara 驱动：从选择器、设置、引导与侧栏中隐藏，避免出现点不动的入口。
 * 已有会话的展示仍按完整的 PROVIDER_DESCRIPTORS 渲染。
 */
export const NEOLIX_UNSUPPORTED_PROVIDER_KINDS: ReadonlySet<string> = new Set([
  "grok",
  "droid",
  "devin",
]);
