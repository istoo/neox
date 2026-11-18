import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { MYNA_BRIDGE_SOURCE } from "./myna-bridge.js";

/**
 * Conversion of myna's window contributions — `magpie.page`, `magpie.panels`,
 * `magpie.actions` and the reads `magpie.permissions` grants — into declarative
 * Neolix contributions: a sandboxed web view served from the plugin package, a
 * sidebar entry, panels inside the host's built-in pages, provider/agent row
 * actions, and a generated server RPC shared by the page and its panels.
 *
 * The page keeps myna's bridge: the converted HTML loads a script asset that
 * exposes `window.myna` (and `window.owl`, myna's current name for it) on top of
 * `window.neolix` and the plugin's own settings/read RPCs.
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

/**
 * Keeps local scripts external. The sandboxed view runs under `script-src 'self'`, which accepts
 * files served from the plugin package but not an inlined copy. The referenced file is still
 * checked here so a missing or escaping asset fails the conversion.
 */
async function webScriptTag(
  directory: string,
  file: string,
  tag: string,
  state: InlineState,
): Promise<string> {
  const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const reference = src?.[1] ?? src?.[2] ?? "";
  // myna serves its bridge at `_myna/bridge.js`; current checkouts spell it `_owl/bridge.js`.
  // The converted page loads the host's own bridge instead.
  if (reference.startsWith("_myna/") || reference.startsWith("_owl/")) return "";
  if (isRemote(reference)) return tag;
  await readAsset(directory, path.dirname(file), reference, state);
  return tag;
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
 * The page's HTML for the sandboxed view: local stylesheets and media are inlined (the view's
 * CSP allows both), local scripts stay as files beside the page, myna's own bridge reference is
 * replaced by the host's bridge asset, and the no-weight base stylesheet is added. A missing or
 * escaping asset fails the conversion instead of leaving a silently broken page.
 */
export async function renderMynaPageHtml(
  directory: string,
  file: string,
  pluginId: string,
): Promise<string> {
  const absolute = path.join(directory, file);
  const html = await readFile(absolute, "utf8");
  const state: InlineState = { files: 0, bytes: 0 };
  let output = "";
  let last = 0;
  const pattern = /<(link|script|img|source|video|audio|input)\b[^>]*>/gi;
  for (const match of html.matchAll(pattern)) {
    if (match.index === undefined) continue;
    // A match inside an already-inlined stylesheet is that file's own text.
    if (match.index < last) continue;
    const tag = match[0];
    const name = match[1].toLowerCase();
    let replacement = tag;
    if (name === "link") {
      replacement = await inlineStyleLink(directory, file, tag, state);
    } else if (name === "script") {
      const close = html.indexOf("</script>", match.index + tag.length);
      if (close !== -1) {
        const converted = await webScriptTag(directory, file, tag, state);
        output += html.slice(last, match.index) + converted;
        last = close + "</script>".length;
        continue;
      }
    } else {
      replacement = await inlineMediaTag(directory, file, tag, state);
    }
    output += html.slice(last, match.index) + replacement;
    last = match.index + tag.length;
  }
  output += html.slice(last);
  return injectBeforeHeadEnd(output, `${mynaBaseStyle()}${mynaBridgeScript(pluginId)}`);
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

/** The bridge asset URL, absolute so a page in any package subdirectory resolves it. */
export function mynaBridgeScript(pluginId: string): string {
  return `<script data-myna="bridge" src="/plugin-web/${pluginId}/neolix-myna/bridge.js"></script>`;
}

/** myna's no-weight base stylesheet for what a page leaves unstyled. */
export function mynaBaseStyle(): string {
  return `<style data-myna="base">${MYNA_BASE_CSS}</style>`;
}

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

export interface MynaActionContribution {
  id: string;
  title: string;
  action: {
    kind: "openView";
    view: string;
    params: Record<string, string>;
  };
}

export interface MynaPanelContribution {
  id: string;
  slot: MynaPanelSlot;
  title: string;
  view: string;
}

export interface MynaWebContributions {
  sidebarItems: {
    id: string;
    title: string;
    view: string;
    section: "header" | "footer";
    replaces?: MynaReplaceablePage;
  }[];
  panels: MynaPanelContribution[];
  providerActions: MynaActionContribution[];
  agentActions: MynaActionContribution[];
}

export interface MynaWebView {
  id: string;
  title: string;
  entry: string;
  /** Panels grant `resize` so the frame follows myna's "as tall as it draws" negotiation. */
  permissions: ("rpc" | "resize")[];
  rpcs: string[];
}

export interface MynaWebAssets {
  views: MynaWebView[];
  contributions: MynaWebContributions;
}

const PAGE_VIEW_ID = "page";
/** The bridge asset lives at the package root so every converted page can reach it by URL. */
const BRIDGE_ASSET = "neolix-myna/bridge.js";
const ACTION_CONTRIBUTION_ID = /^[a-z][a-z0-9-]{0,63}$/;

function titleText(value: string, fallback: string): string {
  const title = value.trim() || fallback;
  return title.slice(0, 200);
}

function pageSection(replaces: MynaReplaceablePage | null): "header" | "footer" {
  return replaces === "usage" ? "footer" : "header";
}

/**
 * Writes the bridge script and every converted page or panel beside its source, and returns the
 * manifest declarations a web host renders: sandboxed views, a sidebar entry, slot panels, and
 * the row actions that reopen the page with the row it was picked on.
 *
 * Views only get `rpc`, for the generated settings calls and `myna.read`; panels add `resize` so
 * their frame follows myna's height negotiation. Both keep the host's `sandbox="allow-scripts"`
 * and CSP unchanged.
 */
export async function writeMynaWebAssets(
  directory: string,
  window: MynaWindow,
  pluginId: string,
  name: string,
): Promise<MynaWebAssets> {
  const contributions: MynaWebContributions = {
    sidebarItems: [],
    panels: [],
    providerActions: [],
    agentActions: [],
  };
  if (window.page === null && window.panels.length === 0) return { views: [], contributions };

  const bridgeDirectory = path.dirname(BRIDGE_ASSET);
  await mkdir(path.join(directory, bridgeDirectory), { recursive: true });
  await writeFile(path.join(directory, BRIDGE_ASSET), `${MYNA_BRIDGE_SOURCE}\n`);

  const rpcs = ["settings.options.read", "settings.options.write"];
  if (window.reads.length > 0) rpcs.push("myna.read");

  const views: MynaWebView[] = [];
  const usedEntries = new Set<string>();
  const usedViewIds = new Set<string>();

  if (window.page !== null) {
    const html = await renderMynaPageHtml(directory, window.page.file, pluginId);
    const parsed = path.posix.parse(window.page.file);
    let entry = path.posix.join(parsed.dir, `${parsed.name}.neolix.html`);
    for (let suffix = 2; usedEntries.has(entry); suffix += 1) {
      entry = path.posix.join(parsed.dir, `${parsed.name}.neolix-${suffix}.html`);
    }
    usedEntries.add(entry);
    usedViewIds.add(PAGE_VIEW_ID);
    await writeFile(path.join(directory, entry), html);

    const title = titleText(window.page.title, name);
    views.push({ id: PAGE_VIEW_ID, title, entry, permissions: ["rpc"], rpcs: [...rpcs] });
    contributions.sidebarItems.push({
      id: PAGE_VIEW_ID,
      title,
      view: PAGE_VIEW_ID,
      section: pageSection(window.page.replaces),
      ...(window.page.replaces === "sessions" || window.page.replaces === "usage"
        ? { replaces: window.page.replaces }
        : {}),
    });
  }

  // Each panel is its own sandboxed view beside its source. `resize` is what myna's height
  // negotiation becomes: a panel frame is as tall as it draws instead of a fixed box.
  for (const panel of window.panels) {
    const html = await renderMynaPageHtml(directory, panel.file, pluginId);
    const parsed = path.posix.parse(panel.file);
    let entry = path.posix.join(parsed.dir, `${parsed.name}.neolix.html`);
    for (let suffix = 2; usedEntries.has(entry); suffix += 1) {
      entry = path.posix.join(parsed.dir, `${parsed.name}.neolix-${suffix}.html`);
    }
    usedEntries.add(entry);

    const baseId = `panel-${panel.slot}`;
    let viewId = baseId;
    for (let suffix = 2; usedViewIds.has(viewId); suffix += 1) viewId = `${baseId}-${suffix}`;
    usedViewIds.add(viewId);
    await writeFile(path.join(directory, entry), html);

    const title = titleText(panel.title, name);
    views.push({
      id: viewId,
      title,
      entry,
      permissions: ["rpc", "resize"],
      rpcs: [...rpcs],
    });
    contributions.panels.push({ id: viewId, slot: panel.slot, title, view: viewId });
  }

  // myna allows an action id to start with a digit; a contribution id may not, so such an id
  // gains a prefix. The page still receives myna's spelling in `params.action`.
  const usedActionIds = new Set<string>(
    [...contributions.sidebarItems, ...contributions.panels].map((entry) => entry.id),
  );
  for (const action of window.actions) {
    const base = ACTION_CONTRIBUTION_ID.test(action.id) ? action.id : `action-${action.id}`;
    let id = base;
    for (let suffix = 2; usedActionIds.has(id); suffix += 1) {
      id = `${base.slice(0, 56)}-${suffix}`;
    }
    usedActionIds.add(id);
    const contribution: MynaActionContribution = {
      id,
      title: titleText(action.title, action.id),
      action: {
        kind: "openView",
        view: PAGE_VIEW_ID,
        params: { action: action.id },
      },
    };
    if (action.menu === "provider") contributions.providerActions.push(contribution);
    else contributions.agentActions.push(contribution);
  }

  return { views, contributions };
}

/**
 * The server half of the page bridge: one RPC over the reads `magpie.permissions` granted. The
 * generated entries import `defineRpc` and `z`; this snippet is empty when the page reads
 * nothing.
 */
export function renderPageReadCode(reads: readonly MynaPageRead[]): string {
  if (reads.length === 0) return "";
  return `const READS = ${JSON.stringify(reads)} as const;
const PAGE_READ = defineRpc({
  name: "myna.read",
  input: z.object({ name: z.string(), params: z.record(z.string(), z.json()).optional() }),
  output: z.json(),
});

async function pageRead(neolix: any, name: string, params: Record<string, unknown>) {
  if (!(READS as readonly string[]).includes(name)) {
    throw new Error("this page cannot read " + name);
  }
  if (name === "providers:list") return neolix.gateway.providers();
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
    models: report.byModel.slice(0, 20).map((group: any) => ({
      model: group.name || group.id,
      calls: group.calls,
      input: group.inputTokens,
      output: group.outputTokens,
      cost: group.costUsd,
    })),
  };
}
`;
}
