import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Conversion of myna's window contributions — `magpie.page`, `magpie.panels`,
 * `magpie.actions` and the reads `magpie.permissions` grants — into a Neolix
 * client plugin that renders the same HTML through `HtmlFrame`.
 *
 * The page keeps myna's `window.myna` bridge: the generated HTML carries a
 * copy of it, and the generated client answers `hello`, `options.get`,
 * `options.set`, `read` and sends `action` events.
 */

export const MYNA_PAGE_READS = ["usage:summary", "providers:list"] as const;
export const MYNA_PANEL_SLOTS = ["agents", "usage", "settings", "provider"] as const;
export const MYNA_ACTION_MENUS = ["provider", "agent"] as const;
export const MYNA_REPLACEABLE_PAGES = ["sessions", "library", "routing", "usage"] as const;

export type MynaPageRead = (typeof MYNA_PAGE_READS)[number];
export type MynaPanelSlot = (typeof MYNA_PANEL_SLOTS)[number];
export type MynaActionMenu = (typeof MYNA_ACTION_MENUS)[number];
export type MynaReplaceablePage = (typeof MYNA_REPLACEABLE_PAGES)[number];

export interface MynaPageScreen {
  title: string;
  titles: Record<string, string>;
  /** The HTML file, relative to the package with forward slashes. */
  file: string;
  replaces: MynaReplaceablePage | null;
}

export interface MynaPanelScreen {
  slot: MynaPanelSlot;
  title: string;
  titles: Record<string, string>;
  file: string;
}

export interface MynaPageAction {
  id: string;
  menu: MynaActionMenu;
  title: string;
  titles: Record<string, string>;
}

export interface MynaWindow {
  page: MynaPageScreen | null;
  panels: MynaPanelScreen[];
  actions: MynaPageAction[];
  reads: MynaPageRead[];
}

const MAX_PANELS = 8;
const MAX_ACTIONS = 8;
const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ASSET_FILES = 200;
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

const ASSET_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function titlesOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const language = key.trim();
    const title = stringValue(entry);
    if (language === "" || title === null || language.length > 16) continue;
    out[language] = title;
    if (Object.keys(out).length === 16) break;
  }
  return out;
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function htmlInside(directory: string, value: unknown): Promise<string | null> {
  const file = stringValue(value);
  if (file === null) return null;
  if (!/\.html?$/i.test(file)) return null;
  const resolved = path.resolve(directory, file);
  if (!isInside(directory, resolved)) return null;
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) return null;
  return path.relative(directory, resolved).split(path.sep).join("/");
}

async function readPageScreen(
  directory: string,
  magpie: Record<string, unknown>,
): Promise<MynaPageScreen | null> {
  const raw = Reflect.get(magpie, "page");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const file = await htmlInside(directory, Reflect.get(raw, "file"));
  if (file === null) return null;
  const replaces = stringValue(Reflect.get(raw, "replaces"));
  return {
    title: stringValue(Reflect.get(raw, "title")) ?? "",
    titles: titlesOf(Reflect.get(raw, "titles")),
    file,
    replaces:
      replaces !== null && (MYNA_REPLACEABLE_PAGES as readonly string[]).includes(replaces)
        ? (replaces as MynaReplaceablePage)
        : null,
  };
}

async function readPanels(directory: string, magpie: Record<string, unknown>) {
  const panels: MynaPanelScreen[] = [];
  const rawPanels = Reflect.get(magpie, "panels");
  if (!Array.isArray(rawPanels)) return panels;
  for (const raw of rawPanels) {
    if (panels.length === MAX_PANELS) break;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const slot = stringValue(Reflect.get(raw, "slot"));
    if (slot === null || !(MYNA_PANEL_SLOTS as readonly string[]).includes(slot)) continue;
    const file = await htmlInside(directory, Reflect.get(raw, "file"));
    if (file === null) continue;
    panels.push({
      slot: slot as MynaPanelSlot,
      title: stringValue(Reflect.get(raw, "title")) ?? "",
      titles: titlesOf(Reflect.get(raw, "titles")),
      file,
    });
  }
  return panels;
}

function readActions(magpie: Record<string, unknown>, hasPage: boolean): MynaPageAction[] {
  const actions: MynaPageAction[] = [];
  const rawActions = Reflect.get(magpie, "actions");
  if (!hasPage || !Array.isArray(rawActions)) return actions;
  for (const raw of rawActions) {
    if (actions.length === MAX_ACTIONS) break;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const id = stringValue(Reflect.get(raw, "id"));
    const menu = stringValue(Reflect.get(raw, "menu"));
    if (id === null || !ACTION_ID.test(id)) continue;
    if (menu === null || !(MYNA_ACTION_MENUS as readonly string[]).includes(menu)) continue;
    if (actions.some((action) => action.id === id)) continue;
    actions.push({
      id,
      menu: menu as MynaActionMenu,
      title: stringValue(Reflect.get(raw, "title")) ?? "",
      titles: titlesOf(Reflect.get(raw, "titles")),
    });
  }
  return actions;
}

function readReads(magpie: Record<string, unknown>): MynaPageRead[] {
  const reads: MynaPageRead[] = [];
  const rawReads = Reflect.get(magpie, "permissions");
  if (!Array.isArray(rawReads)) return reads;
  for (const raw of rawReads) {
    const read = stringValue(raw);
    if (read === null) continue;
    if (!(MYNA_PAGE_READS as readonly string[]).includes(read)) continue;
    if (!reads.includes(read as MynaPageRead)) reads.push(read as MynaPageRead);
  }
  return reads;
}

/** myna's `magpie.page`, `magpie.panels`, `magpie.actions` and granted reads. */
export async function readMynaWindow(
  directory: string,
  magpie: Record<string, unknown>,
): Promise<MynaWindow> {
  const page = await readPageScreen(directory, magpie);
  return {
    page,
    panels: await readPanels(directory, magpie),
    actions: readActions(magpie, page !== null),
    reads: readReads(magpie),
  };
}

/** True when the package asks myna for a window of its own. */
export function hasMynaWindow(window: MynaWindow): boolean {
  return window.page !== null || window.panels.length > 0;
}

interface InlineState {
  files: number;
  bytes: number;
}

function isRemote(reference: string): boolean {
  return (
    reference === "" ||
    reference.startsWith("#") ||
    reference.startsWith("data:") ||
    reference.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference)
  );
}

function splitReference(reference: string): string {
  const cut = reference.search(/[?#]/);
  return cut === -1 ? reference : reference.slice(0, cut);
}

async function readAsset(
  directory: string,
  fromDirectory: string,
  reference: string,
  state: InlineState,
): Promise<{ path: string; data: Buffer }> {
  const clean = decodeURIComponent(splitReference(reference));
  const base = path.isAbsolute(fromDirectory) ? fromDirectory : path.join(directory, fromDirectory);
  const resolved = path.resolve(base, clean);
  if (!isInside(directory, resolved)) {
    throw new Error(`myna page asset escapes the package: ${reference}`);
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`myna page asset is missing: ${reference}`);
  }
  state.files += 1;
  state.bytes += info.size;
  if (state.files > MAX_ASSET_FILES || state.bytes > MAX_ASSET_BYTES) {
    throw new Error(
      `myna page has too many assets to convert (limit ${MAX_ASSET_FILES} files / 20 MB)`,
    );
  }
  return { path: resolved, data: await readFile(resolved) };
}

function dataUri(file: string, data: Buffer): string {
  const mime = ASSET_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${data.toString("base64")}`;
}

/** Rewrites `url(...)` references in a stylesheet so a frame without a base URL can use it. */
async function inlineCss(
  directory: string,
  cssFile: string,
  css: string,
  state: InlineState,
): Promise<string> {
  const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const parts: string[] = [];
  let last = 0;
  for (const match of css.matchAll(pattern)) {
    const reference = match[2];
    if (match.index === undefined || isRemote(reference)) continue;
    const asset = await readAsset(directory, path.dirname(cssFile), reference, state);
    parts.push(css.slice(last, match.index), `url("${dataUri(asset.path, asset.data)}")`);
    last = match.index + match[0].length;
  }
  if (parts.length === 0) return css;
  parts.push(css.slice(last));
  return parts.join("");
}

async function inlineStyleLink(
  directory: string,
  file: string,
  tag: string,
  state: InlineState,
): Promise<string> {
  const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const reference = href?.[1] ?? href?.[2] ?? "";
  const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  if (!/\bstylesheet\b/i.test(rel?.[1] ?? rel?.[2] ?? "") || isRemote(reference)) return tag;
  const asset = await readAsset(directory, path.dirname(file), reference, state);
  const css = await inlineCss(directory, asset.path, asset.data.toString("utf8"), state);
  return `<style data-myna-href="${reference}">${css}</style>`;
}

async function inlineScript(
  directory: string,
  file: string,
  tag: string,
  body: string,
  state: InlineState,
): Promise<string> {
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const reference = src?.[1] ?? src?.[2] ?? "";
  if (isRemote(reference)) return `${tag}${body}</script>`;
  // myna serves its bridge at `_myna/bridge.js`; the converted page carries its own copy.
  if (reference.startsWith("_myna/")) return "";
  const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const kind = (type?.[1] ?? type?.[2] ?? "").trim();
  const source = (await readAsset(directory, path.dirname(file), reference, state)).data.toString(
    "utf8",
  );
  if (kind === "module" && /(^|\n)\s*(import|export)\b/.test(source)) {
    throw new Error(
      `myna page script ${reference} is an ES module with imports; Neox's converter can only inline classic scripts`,
    );
  }
  const attributes = tag.replace(/\s*\bsrc\s*=\s*(?:"[^"]*"|'[^']*')/i, "");
  return `${attributes}>${source}</script>`;
}

async function inlineMediaTag(
  directory: string,
  file: string,
  tag: string,
  state: InlineState,
): Promise<string> {
  const attribute = /\b(src|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  if (!attribute) return tag;
  const reference = attribute[2] ?? attribute[3] ?? "";
  if (isRemote(reference)) return tag;
  const asset = await readAsset(directory, path.dirname(file), reference, state);
  const replacement = `${attribute[1]}="${dataUri(asset.path, asset.data)}"`;
  return tag.replace(attribute[0], replacement);
}

/**
 * The page's HTML with its local stylesheets, scripts and media inlined, and
 * myna's page bridge and base stylesheet added. A missing or escaping asset
 * fails the conversion instead of leaving a silently broken page.
 */
export async function renderMynaPageHtml(
  directory: string,
  file: string,
  options: { baseStyle?: boolean } = {},
): Promise<string> {
  const absolute = path.join(directory, file);
  const html = await readFile(absolute, "utf8");
  const state: InlineState = { files: 0, bytes: 0 };
  let output = "";
  let last = 0;
  const pattern = /<(link|script|img|source|video|audio|input)\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match.index === undefined) continue;
    // A match inside an already-inlined script or stylesheet is that file's own text.
    if (match.index < last) continue;
    const tag = match[0];
    const name = match[1].toLowerCase();
    let replacement = tag;
    if (name === "link") {
      replacement = await inlineStyleLink(directory, file, tag, state);
    } else if (name === "script") {
      const close = html.indexOf("</script>", match.index + tag.length);
      if (close !== -1) {
        const body = html.slice(match.index + tag.length, close);
        const converted = await inlineScript(directory, file, tag, body, state);
        output += html.slice(last, match.index) + converted;
        last = close + "</script>".length;
        continue;
      }
    } else if (name === "img" || name === "source" || name === "input") {
      replacement = await inlineMediaTag(directory, file, tag, state);
    } else {
      replacement = await inlineMediaTag(directory, file, tag, state);
    }
    output += html.slice(last, match.index) + replacement;
    last = match.index + tag.length;
  }
  output += html.slice(last);
  const withBridge = injectBeforeHeadEnd(output, mynaBridgeScript());
  return options.baseStyle === false
    ? withBridge
    : injectBeforeHeadEnd(withBridge, mynaBaseStyle());
}

function injectBeforeHeadEnd(html: string, snippet: string): string {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd !== -1) return `${html.slice(0, headEnd)}${snippet}${html.slice(headEnd)}`;
  const bodyStart = html.search(/<body\b[^>]*>/i);
  if (bodyStart !== -1) {
    const insert = html.indexOf(">", bodyStart) + 1;
    return `${html.slice(0, insert)}${snippet}${html.slice(insert)}`;
  }
  return `${snippet}${html}`;
}

/** myna's page side of the bridge: the same API, plus ReactNativeWebView transport. */
export function mynaBridgeScript(): string {
  return `<script data-myna="bridge">${MYNA_BRIDGE_SOURCE}</script>`;
}

/** myna's no-weight base stylesheet for what a page leaves unstyled. */
export function mynaBaseStyle(): string {
  return `<style data-myna="base">${MYNA_BASE_CSS}</style>`;
}

const MYNA_BRIDGE_SOURCE = `(() => {
  const waiting = new Map();
  let next = 0;
  const themed = [];
  const watched = [];
  let acting = null;
  const acted = [];
  const native = typeof window.ReactNativeWebView !== "undefined" && window.ReactNativeWebView;
  function send(message) {
    if (native && typeof native.postMessage === "function") native.postMessage(JSON.stringify(message));
    else parent.postMessage(message, "*");
  }
  function call(method, params) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      send({ myna: 1, id, method, params });
    });
  }
  function paint(theme) {
    const root = document.documentElement;
    root.dataset.theme = theme.dark ? "dark" : "light";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    root.lang = theme.lang || "en";
    for (const [k, v] of Object.entries(theme.tokens || {})) root.style.setProperty("--myna-" + k, v);
  }
  function report(err) {
    send({ myna: 1, method: "error", params: { message: String(err && err.message || err) } });
  }
  function act(data) {
    try { Promise.resolve(acting(data)).catch(report); } catch (err) { report(err); }
  }
  function receive(raw) {
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch { return; }
    }
    const m = raw;
    if (!m || m.myna !== 1) return;
    if (m.event === "theme") {
      api.theme = m.data;
      paint(m.data);
      for (const fn of themed) { try { fn(m.data); } catch (err) { report(err); } }
      return;
    }
    if (m.event === "visibility") {
      api.visible = !!(m.data && m.data.visible);
      for (const fn of watched) { try { fn(api.visible); } catch (err) { report(err); } }
      return;
    }
    if (m.event === "action") {
      if (acting) act(m.data); else acted.push(m.data);
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
  }
  addEventListener("message", (e) => {
    if (e.source && e.source !== window && e.source !== parent) return;
    receive(e.data);
  });
  document.addEventListener("message", (e) => receive(e.data));
  addEventListener("error", (e) => {
    if (/ResizeObserver loop/.test(e.message)) { e.preventDefault(); return; }
    report(e.error || (e.message === "Script error." ? "" : e.message));
  });
  addEventListener("unhandledrejection", (e) => report(e.reason));
  const api = {
    theme: null,
    context: {},
    service: "",
    visible: true,
    onTheme(fn) { themed.push(fn); },
    onVisibility(fn) { watched.push(fn); },
    onAction(fn) {
      acting = fn;
      for (const d of acted.splice(0)) act(d);
    },
    options: {
      get: () => call("options.get"),
      set: (options) => call("options.set", { options }),
    },
    read: (name, params) => call("read", { name, params }),
  };
  api.ready = call("hello").then((reply) => {
    const { context, service, visible, action, ...theme } = reply;
    api.theme = theme;
    if (visible === false) api.visible = false;
    api.context = context || {};
    api.service = typeof service === "string" ? service : "";
    paint(theme);
    if (action) { if (acting) act(action); else acted.push(action); }
    return theme;
  });
  let told = -1;
  const size = () => {
    const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h === told) return;
    told = h;
    send({ myna: 1, method: "size", params: { height: h } });
  };
  const watch = () => {
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(size).observe(document.documentElement);
    }
    size();
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", watch); else watch();
  window.myna = api;
})();`;

const MYNA_BASE_CSS = `
:where(html) { background: var(--myna-bg, Canvas); color: var(--myna-fg, CanvasText); font: 13px/1.45 var(--myna-font, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
:where(body) { margin: 0; padding: 20px 24px; }
:where(h1, h2, h3, h4) { font-weight: 600; margin: 0 0 8px; letter-spacing: -.01em; }
:where(h1) { font-size: 20px; } :where(h2) { font-size: 15px; } :where(h3, h4) { font-size: 13px; }
:where(p) { margin: 0 0 8px; }
:where(small, .muted) { color: var(--myna-muted, GrayText); }
:where(a) { color: var(--myna-accent, LinkText); text-decoration: none; }
:where(a:hover) { text-decoration: underline; }
:where(button, input, textarea, select) { font: inherit; color: inherit; }
:where(button) { background: var(--myna-card, ButtonFace); border: 1px solid var(--myna-line, ButtonBorder); border-radius: 6px; padding: 3px 10px; }
:where(button:hover:not(:disabled)) { border-color: var(--myna-muted, ButtonBorder); }
:where(button[aria-pressed="true"], button[aria-selected="true"]) { background: var(--myna-accent-soft, Highlight); border-color: transparent; color: var(--myna-accent, HighlightText); }
:where(button:disabled) { opacity: .5; }
:where(input, textarea, select) { background: var(--myna-card, Field); border: 1px solid var(--myna-line, ButtonBorder); border-radius: 6px; padding: 4px 8px; }
:where(:focus-visible) { outline: 2px solid var(--myna-accent, Highlight); outline-offset: 1px; }
:where(table) { border-collapse: collapse; width: 100%; }
:where(th) { text-align: left; font-weight: 500; font-size: 12px; color: var(--myna-muted, GrayText); }
:where(th, td) { padding: 6px 8px; border-bottom: 1px solid var(--myna-line, ButtonBorder); }
:where(code, kbd, pre) { font-family: var(--myna-code, ui-monospace, Menlo, monospace); font-size: 12px; }
:where(pre) { background: var(--myna-card, Canvas); border: 1px solid var(--myna-line, ButtonBorder); border-radius: 8px; padding: 8px 10px; overflow: auto; }
:where(hr) { border: 0; border-top: 1px solid var(--myna-line, ButtonBorder); margin: 12px 0; }
:where(::selection) { background: var(--myna-accent-soft, Highlight); }
`;

export interface MynaClientFiles {
  /** Files written, relative to the package. */
  files: string[];
}

/** Writes the generated page HTML modules and the client entry a converted package loads. */
export async function writeMynaClient(
  directory: string,
  window: MynaWindow,
  pluginId: string,
): Promise<MynaClientFiles> {
  const clientDirectory = path.join(directory, "client");
  await mkdir(clientDirectory, { recursive: true });

  const sources: { file: string; html: string }[] = [];
  if (window.page !== null) {
    sources.push({
      file: window.page.file,
      html: await renderMynaPageHtml(directory, window.page.file),
    });
  }
  for (const panel of window.panels) {
    sources.push({ file: panel.file, html: await renderMynaPageHtml(directory, panel.file) });
  }
  const modules = sources
    .map((source, index) => `export const PAGE_${index} = ${JSON.stringify(source.html)};`)
    .join("\n\n");
  await writeFile(path.join(clientDirectory, "myna-pages.ts"), `${modules}\n`);

  const entry = renderClientEntry(window, pluginId);
  await writeFile(path.join(directory, "index.client.tsx"), entry);
  return { files: ["index.client.tsx", "client/myna-pages.ts"] };
}

function titleResources(window: MynaWindow): Record<string, Record<string, string>> {
  const resources: Record<string, Record<string, string>> = { en: {} };
  function add(key: string, title: string, titles: Record<string, string>): void {
    const english = title === "" ? key.replace(/_/g, " ") : title;
    resources.en[key] = english;
    for (const [language, value] of Object.entries(titles)) {
      resources[language] ??= {};
      resources[language][key] = value;
      if (language === "zh") {
        resources["zh-CN"] ??= {};
        resources["zh-CN"][key] = value;
      }
    }
  }
  if (window.page !== null) add("title", window.page.title, window.page.titles);
  window.panels.forEach((panel, index) => add(`panel_${index}`, panel.title, panel.titles));
  window.actions.forEach((action) => add(`action_${action.id}`, action.title, action.titles));
  return resources;
}

/** The client entry: screens, panels and row actions rendered through `HtmlFrame`. */
export function renderClientEntry(window: MynaWindow, pluginId: string): string {
  const resources = JSON.stringify(titleResources(window), null, 2);
  const reads = JSON.stringify(window.reads);
  const panelEntries = window.panels.map((panel, index) => ({
    index,
    slot: panel.slot,
    id: `panel-${index}`,
    htmlIndex: `PAGE_${window.page === null ? index : index + 1}`,
    titleKey: `panel_${index}`,
  }));
  const actionEntries = window.actions.map((action) => ({
    id: action.id,
    menu: action.menu,
    titleKey: `action_${action.id}`,
  }));

  const content: string[] = [];
  if (window.page !== null) {
    content.push(`  client.addScreen({
    id: "page",
    title: messages.message("title"),
    Component: PageScreen,
  });`);
  }
  if (window.page?.replaces === "sessions") {
    content.push(`  client.addSidebarHeaderItem({
    id: "page-sidebar",
    title: messages.message("title"),
    replaces: "sessions",
    screen: "page",
    Component: sidebarEntry("page"),
  });`);
  }
  if (window.page?.replaces === "usage") {
    content.push(`  client.addSidebarFooterItem({
    id: "page-sidebar",
    title: messages.message("title"),
    replaces: "usage",
    screen: "page",
    Component: sidebarEntry("page"),
  });`);
  }
  if (window.page?.replaces === "library" || window.page?.replaces === "routing") {
    content.push(`  client.addSettingsScreen({
    id: "page",
    title: messages.message("title"),
    icon: "Puzzle",
    replaces: ${JSON.stringify(window.page.replaces)},
    Component: PageScreen,
  });`);
  }
  for (const panel of panelEntries) {
    if (panel.slot === "provider") {
      content.push(`  client.addProviderPanel({
    id: ${JSON.stringify(panel.id)},
    title: messages.message(${JSON.stringify(panel.titleKey)}),
    icon: "Puzzle",
    Component: panel(${panel.htmlIndex}),
  });`);
      continue;
    }
    content.push(`  client.addScreen({
    id: ${JSON.stringify(panel.id)},
    title: messages.message(${JSON.stringify(panel.titleKey)}),
    Component: panel(${panel.htmlIndex}),
  });`);
    if (panel.slot === "settings" || panel.slot === "usage") {
      content.push(`  client.addSettingsScreen({
    id: ${JSON.stringify(panel.id)},
    title: messages.message(${JSON.stringify(panel.titleKey)}),
    icon: "Puzzle",
    Component: panel(${panel.htmlIndex}),
  });`);
    }
    if (panel.slot === "agents") {
      content.push(`  client.addSidebarFooterItem({
    id: ${JSON.stringify(panel.id)},
    title: messages.message(${JSON.stringify(panel.titleKey)}),
    screen: ${JSON.stringify(panel.id)},
    Component: sidebarEntry(${JSON.stringify(panel.id)}),
  });`);
    }
  }
  for (const action of actionEntries) {
    const menu = action.menu === "provider" ? "addProviderAction" : "addAgentAction";
    const target = action.menu;
    content.push(`  client.${menu}({
    id: ${JSON.stringify(action.id)},
    title: messages.message(${JSON.stringify(action.titleKey)}),
    icon: "Puzzle",
    onSelect({ ${target}, openScreen }) {
      openScreen({
        screenId: "page",
        params: { action: ${JSON.stringify(action.id)}, ${target}: ${target}.id, name: ${target}.name },
      });
    },
  });`);
  }

  return `// Generated by Neox's myna plugin converter. It is overwritten on every update.
// myna window contributions (page, panels, actions) rendered through HtmlFrame.
import { useEffect, useMemo, useRef } from "react";
import {
  defineTranslations,
  useNeolix,
  useSettings,
  useTranslation,
  type PluginClientContext,
  type PluginHostProps,
  type PluginScreenProps,
  type PluginSidebarItemProps,
} from "@neolix/plugin/client";
import { defineSettings } from "@neolix/plugin";
import { HtmlFrame, SidebarRow, type HtmlFrameHandle } from "@neolix/plugin/client/ui";
import { z } from "zod";
import { ${["PAGE_0", ...window.panels.map((_, index) => `PAGE_${index + 1}`)].join(", ")} } from "./client/myna-pages";

const PLUGIN_ID = ${JSON.stringify(pluginId)};
const READS = ${reads} as const;
const messages = defineTranslations({ resources: ${resources} });
const options = defineSettings({
  id: "options",
  scope: "host",
  version: 1,
  schema: z.record(z.string(), z.json()),
});

function luminance(color: string): number {
  const hex = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return 1;
  const value = Number.parseInt(hex[1], 16);
  const parts = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) => {
    const channel = part / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

function themeReply(theme: PluginHostProps["theme"], lang: string) {
  const dark = luminance(theme.colors.surface0) < 0.35;
  return {
    dark,
    lang,
    tokens: {
      bg: theme.colors.surface0,
      fg: theme.colors.foreground,
      muted: theme.colors.foregroundMuted,
      card: theme.colors.surface1,
      line: theme.colors.border,
      accent: theme.colors.accent,
      "accent-soft": theme.colors.surface2,
    },
  };
}

function contextOf(params: Record<string, string>) {
  if (params.provider) {
    return { provider: { id: params.provider, name: params.name || params.provider } };
  }
  if (params.agent) {
    return { agent: { id: params.agent, name: params.name || params.agent } };
  }
  return {};
}

function actionOf(params: Record<string, string>) {
  if (!params.action) return undefined;
  const target = params.provider
    ? { provider: { id: params.provider, name: params.name || params.provider } }
    : params.agent
      ? { agent: { id: params.agent, name: params.name || params.agent } }
      : {};
  return { id: params.action, ...target };
}

async function readPage(
  neolix: ReturnType<typeof useNeolix>,
  name: unknown,
  params: Record<string, unknown>,
) {
  if (typeof name !== "string" || !(READS as readonly string[]).includes(name)) {
    throw new Error(\`this page cannot read \${String(name)}\`);
  }
  if (name === "providers:list") return neolix.gateway.providers();
  if (name === "usage:summary") {
    const requested = typeof params.period === "string" ? params.period : "today";
    const period = requested === "7d" || requested === "30d" ? requested : "today";
    const { report } = await neolix.gateway.usage({ period });
    if (!report) throw new Error("The gateway has no usage to read");
    return {
      period,
      since: report.since,
      calls: report.totals.calls,
      errors: report.totals.failed,
      input: report.totals.inputTokens,
      output: report.totals.outputTokens,
      cacheRead: report.totals.cacheReadTokens,
      cost: report.totals.costUsd,
      models: report.byModel.slice(0, 20).map((group) => ({
        model: group.name || group.id,
        calls: group.calls,
        input: group.inputTokens,
        output: group.outputTokens,
        cost: group.costUsd,
      })),
    };
  }
  throw new Error(\`this page cannot read \${name}\`);
}

function PageFrame({
  html,
  theme,
  params,
  lang,
  autoHeight = false,
}: {
  html: string;
  theme: PluginHostProps["theme"];
  params: Record<string, string>;
  lang: string;
  autoHeight?: boolean;
}) {
  const frame = useRef<HtmlFrameHandle>(null);
  const neolix = useNeolix();
  const optionsState = useSettings(options);
  const context = useMemo(() => contextOf(params), [params]);
  const action = useMemo(() => actionOf(params), [params]);
  const reply = useMemo(() => themeReply(theme, lang), [theme, lang]);
  const chat = async (raw: unknown) => {
    if (typeof raw !== "object" || raw === null) throw new Error("bad message");
    const message = raw as { method?: string; params?: Record<string, unknown> };
    switch (message.method) {
      case "hello":
        return { ...reply, context, service: "", visible: true, action };
      case "options.get":
        return optionsState.status === "ready" ? optionsState.values : {};
      case "options.set": {
        if (optionsState.status !== "ready") throw new Error("Settings are still loading");
        const values = (message.params?.options ?? {}) as Record<string, unknown>;
        const saved = await optionsState.save(values, optionsState.revision);
        if (!saved) throw new Error(optionsState.saveError ?? "Saving options failed");
        return values;
      }
      case "read":
        return readPage(neolix, message.params?.name, (message.params?.params ?? {}) as Record<string, unknown>);
      case "size":
      case "error":
        return null;
      default:
        throw new Error(\`no method \${String(message.method)}\`);
    }
  };
  useEffect(() => {
    frame.current?.post({ event: "theme", data: reply });
  }, [reply]);
  return <HtmlFrame ref={frame} html={html} autoHeight={autoHeight} bridge={chat} />;
}

function PageScreen({ params = {}, theme }: PluginScreenProps) {
  const { locale } = useTranslation(messages);
  return <PageFrame html={PAGE_0} theme={theme} params={params} lang={locale} />;
}

function panel(html: string) {
  return function PanelScreen({
    params = {},
    theme,
    provider,
  }: PluginScreenProps & { provider?: { id: string; name: string } }) {
    const { locale } = useTranslation(messages);
    const context = provider
      ? { ...params, provider: provider.id, name: provider.name }
      : params;
    return (
      <PageFrame
        html={html}
        theme={theme}
        params={context}
        lang={locale}
        autoHeight={provider !== undefined}
      />
    );
  };
}

function sidebarEntry(screenId: string) {
  return function Entry({ currentScreen, openScreen }: PluginSidebarItemProps) {
    return (
      <SidebarRow
        icon="Puzzle"
        active={currentScreen?.screenId === screenId}
        onPress={() => openScreen({ screenId })}
      />
    );
  };
}

export default function contribute(client: PluginClientContext) {
${content.join("\n")}
  return () => {};
}
`;
}
