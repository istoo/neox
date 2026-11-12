import { app, Menu, BrowserWindow, ipcMain } from "electron";
import { getActiveNeolixBrowserWebContentsForHostWindow } from "./browser-webviews/index.js";
import type { DesktopUiMode } from "../settings/desktop-settings.js";

interface ShowContextMenuInput {
  kind?: "terminal";
  hasSelection?: boolean;
}

interface ApplicationMenuOptions {
  onNewWindow: () => void;
  /** Renderer selection shown under File → Desktop UI. */
  uiMode?: DesktopUiMode;
  /** Env override wins; the menu is informational then. */
  uiModeSelectable?: boolean;
  onSelectUiMode?: (mode: DesktopUiMode) => void;
}

function withBrowserWindow(
  callback: (win: BrowserWindow) => void,
): (_item: Electron.MenuItem, baseWin: Electron.BaseWindow | undefined) => void {
  return (_item, baseWin) => {
    const win = baseWin instanceof BrowserWindow ? baseWin : BrowserWindow.getFocusedWindow();
    if (win) callback(win);
  };
}

interface ReloadableWebContents {
  isLoadingMainFrame(): boolean;
  stop(): void;
  reload(): void;
  reloadIgnoringCache(): void;
}

interface ReloadableWindow {
  webContents: ReloadableWebContents & { id: number };
}

interface ReloadActiveBrowserOrWindowInput {
  win: ReloadableWindow;
  getActiveBrowserContentsForHostWindow: (
    hostWebContentsId: number,
  ) => ReloadableWebContents | null;
  ignoreCache?: boolean;
}

export function reloadActiveBrowserOrWindow({
  win,
  getActiveBrowserContentsForHostWindow,
  ignoreCache = false,
}: ReloadActiveBrowserOrWindowInput): void {
  const browserContents = getActiveBrowserContentsForHostWindow(win.webContents.id);
  if (browserContents) {
    if (ignoreCache) {
      browserContents.reloadIgnoringCache();
      return;
    }
    if (browserContents.isLoadingMainFrame()) {
      browserContents.stop();
      return;
    }
    browserContents.reload();
    return;
  }

  if (ignoreCache) {
    win.webContents.reloadIgnoringCache();
    return;
  }
  win.webContents.reload();
}

export interface MenuLabels {
  readonly about: string;
  readonly services: string;
  readonly hide: string;
  readonly hideOthers: string;
  readonly showAll: string;
  readonly quit: string;
  readonly file: string;
  readonly newWindow: string;
  readonly desktopUi: string;
  readonly standard: string;
  readonly classic: string;
  readonly edit: string;
  readonly undo: string;
  readonly redo: string;
  readonly cut: string;
  readonly copy: string;
  readonly paste: string;
  readonly selectAll: string;
  readonly view: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly actualSize: string;
  readonly reload: string;
  readonly forceReload: string;
  readonly devTools: string;
  readonly toggleFullScreen: string;
  readonly window: string;
  readonly minimize: string;
  readonly zoom: string;
  readonly front: string;
  readonly close: string;
}

/**
 * Electron 的 role 默认标签是英文，macOS 不会替它们本地化，所以整个菜单在这里
 * 按系统语言取文案。只支持界面已有的两种语言，其他系统语言回退英文。
 */
export function menuLabels(locale: string, appName: string): MenuLabels {
  if (!locale.trim().toLowerCase().startsWith("zh")) {
    return {
      about: `About ${appName}`,
      services: "Services",
      hide: `Hide ${appName}`,
      hideOthers: "Hide Others",
      showAll: "Show All",
      quit: `Quit ${appName}`,
      file: "File",
      newWindow: "New Window",
      desktopUi: "Desktop UI",
      standard: "Standard",
      classic: "Classic (legacy)",
      edit: "Edit",
      undo: "Undo",
      redo: "Redo",
      cut: "Cut",
      copy: "Copy",
      paste: "Paste",
      selectAll: "Select All",
      view: "View",
      zoomIn: "Zoom In",
      zoomOut: "Zoom Out",
      actualSize: "Actual Size",
      reload: "Reload",
      forceReload: "Force Reload",
      devTools: "Developer Tools",
      toggleFullScreen: "Toggle Full Screen",
      window: "Window",
      minimize: "Minimize",
      zoom: "Zoom",
      front: "Bring All to Front",
      close: "Close Window",
    };
  }
  return {
    about: `关于 ${appName}`,
    services: "服务",
    hide: `隐藏 ${appName}`,
    hideOthers: "隐藏其他",
    showAll: "全部显示",
    quit: `退出 ${appName}`,
    file: "文件",
    newWindow: "新建窗口",
    desktopUi: "桌面界面",
    standard: "标准",
    classic: "经典（旧版）",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    selectAll: "全选",
    view: "视图",
    zoomIn: "放大",
    zoomOut: "缩小",
    actualSize: "实际大小",
    reload: "重新载入",
    forceReload: "强制重新载入",
    devTools: "开发者工具",
    toggleFullScreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    front: "前置全部窗口",
    close: "关闭窗口",
  };
}

function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions,
  capturing: boolean,
): Electron.MenuItemConstructorOptions[] {
  const isMac = process.platform === "darwin";
  const zoomEnabled = !capturing;
  const labels = menuLabels(app.getLocale(), app.name);

  return [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const, label: labels.about },
              { type: "separator" as const },
              { role: "services" as const, label: labels.services },
              { type: "separator" as const },
              { role: "hide" as const, label: labels.hide },
              { role: "hideOthers" as const, label: labels.hideOthers },
              { role: "unhide" as const, label: labels.showAll },
              { type: "separator" as const },
              { role: "quit" as const, label: labels.quit },
            ],
          },
        ]
      : []),
    {
      label: labels.file,
      submenu: [
        {
          label: labels.newWindow,
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            options.onNewWindow();
          },
        },
        { type: "separator" },
        {
          label: labels.desktopUi,
          submenu: [
            {
              label: labels.standard,
              type: "radio",
              checked: options.uiMode === "web",
              enabled: options.uiModeSelectable !== false,
              click: () => options.onSelectUiMode?.("web"),
            },
            {
              // COMPAT(webRendererDefault): the way back while the native renderer still ships.
              label: labels.classic,
              type: "radio",
              checked: options.uiMode !== "web",
              enabled: options.uiModeSelectable !== false,
              click: () => options.onSelectUiMode?.("native"),
            },
          ],
        },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { role: "undo", label: labels.undo },
        { role: "redo", label: labels.redo },
        { type: "separator" },
        { role: "cut", label: labels.cut },
        { role: "copy", label: labels.copy },
        { role: "paste", label: labels.paste },
        { role: "selectAll", label: labels.selectAll },
      ],
    },
    {
      label: labels.view,
      submenu: [
        {
          label: labels.zoomIn,
          accelerator: "CmdOrCtrl+=",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
          }),
        },
        {
          label: labels.zoomOut,
          accelerator: "CmdOrCtrl+-",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
          }),
        },
        {
          label: labels.actualSize,
          accelerator: "CmdOrCtrl+0",
          enabled: zoomEnabled,
          click: withBrowserWindow((win) => {
            win.webContents.setZoomLevel(0);
          }),
        },
        { type: "separator" },
        {
          label: labels.reload,
          accelerator: "CmdOrCtrl+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActiveNeolixBrowserWebContentsForHostWindow,
            });
          }),
        },
        {
          label: labels.forceReload,
          accelerator: "CmdOrCtrl+Shift+R",
          click: withBrowserWindow((win) => {
            reloadActiveBrowserOrWindow({
              win,
              getActiveBrowserContentsForHostWindow: getActiveNeolixBrowserWebContentsForHostWindow,
              ignoreCache: true,
            });
          }),
        },
        { role: "toggleDevTools", label: labels.devTools },
        { type: "separator" },
        { role: "togglefullscreen", label: labels.toggleFullScreen },
      ],
    },
    {
      label: labels.window,
      submenu: [
        { role: "minimize", label: labels.minimize },
        { role: "zoom", label: labels.zoom },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const, label: labels.front }]
          : [{ role: "close" as const, label: labels.close }]),
      ],
    },
  ];
}

let applicationMenuOptions: ApplicationMenuOptions | null = null;
let capturingShortcut = false;

function rebuildApplicationMenu(): void {
  if (!applicationMenuOptions) return;
  const menu = Menu.buildFromTemplate(
    buildApplicationMenuTemplate(applicationMenuOptions, capturingShortcut),
  );
  Menu.setApplicationMenu(menu);
}

export function setupApplicationMenu(options: ApplicationMenuOptions): void {
  applicationMenuOptions = options;
  rebuildApplicationMenu();

  ipcMain.handle("neolix:menu:showContextMenu", (event, input?: ShowContextMenuInput) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) {
      return;
    }

    if (input?.kind !== "terminal") {
      return;
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: menuLabels(app.getLocale(), app.name).copy,
        role: "copy",
        enabled: input.hasSelection === true,
      },
      {
        label: menuLabels(app.getLocale(), app.name).paste,
        role: "paste",
      },
      {
        type: "separator",
      },
      {
        label: menuLabels(app.getLocale(), app.name).selectAll,
        role: "selectAll",
      },
    ]);

    contextMenu.popup({ window: win });
  });

  // Disable the zoom accelerators while capturing a shortcut so combos like
  // Cmd+- / Cmd+= reach the renderer instead of zooming the window.
  ipcMain.handle("neolix:menu:set-capturing-shortcut", (_event, capturing?: boolean) => {
    capturingShortcut = capturing === true;
    rebuildApplicationMenu();
  });

  // If the renderer reloads mid-capture (e.g. Cmd+R) the renderer-side effect
  // never gets to send `false`, so reset the flag from the main process when a
  // main window finishes loading. Workspace browser webviews are not
  // BrowserWindows, so they don't trigger this.
  app.on("browser-window-created", (_event, win) => {
    win.webContents.on("did-finish-load", () => {
      if (!capturingShortcut) return;
      capturingShortcut = false;
      rebuildApplicationMenu();
    });
  });
}
