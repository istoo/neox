// FILE: pluginWeb.ts
// Purpose: Serves sandboxed plugin web views from the bridge origin. The daemon remains the only
//          reader of plugin files; this module validates the requested path and extension again,
//          injects the per-frame session meta and the SDK script, and returns the strict CSP.
// Layer: Bridge HTTP
// Exports: PLUGIN_WEB_PREFIX, createPluginWebHandler, pluginWebCsp

import {
  PLUGIN_WEB_SDK_SESSION_MARKER,
  PLUGIN_WEB_SDK_SOURCE,
} from "../../../packages/plugin-web-sdk/src/bootstrap";

export const PLUGIN_WEB_PREFIX = "/plugin-web/";
export const PLUGIN_WEB_SDK_FILE = "__neolix_sdk.js";

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".woff2",
]);

export interface PluginWebAsset {
  readonly contentType: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
}

export interface PluginWebRouteInput {
  readonly method: string;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
}

export interface PluginWebRouteResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string | Uint8Array;
}

export interface PluginWebRouteOptions {
  readonly readAsset: (pluginId: string, assetPath: string) => Promise<PluginWebAsset>;
  /** Additional origins allowed to frame a view; the bridge origin is always allowed. */
  readonly frameAncestorOrigins?: readonly string[];
}

function textResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers }, body };
}

function extensionOf(assetPath: string): string {
  const index = assetPath.lastIndexOf(".");
  return index === -1 ? "" : assetPath.slice(index).toLowerCase();
}

function isSafeAssetPath(assetPath: string): boolean {
  if (!assetPath || assetPath.startsWith("/") || assetPath.includes("\\")) return false;
  // Reject control characters and any `..` segment after decoding.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f]/.test(assetPath)) return false;
  return !assetPath.split("/").some((segment) => segment === ".." || segment === ".");
}

export function parsePluginWebPath(
  pathname: string,
): { readonly pluginId: string; readonly assetPath: string } | null {
  if (!pathname.startsWith(PLUGIN_WEB_PREFIX)) return null;
  const rest = pathname.slice(PLUGIN_WEB_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const pluginId = rest.slice(0, slash);
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return null;
  }
  if (!PLUGIN_ID_PATTERN.test(pluginId) || !isSafeAssetPath(assetPath)) return null;
  if (!ALLOWED_EXTENSIONS.has(extensionOf(assetPath))) return null;
  return { pluginId, assetPath };
}

function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function pluginWebCsp(frameAncestorOrigins: readonly string[] = []): string {
  const ancestors = new Set(["'self'"]);
  for (const origin of frameAncestorOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) ancestors.add(normalized);
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self' data:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${[...ancestors].join(" ")}`,
  ].join("; ");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sdkPath(pluginId: string): string {
  return `${PLUGIN_WEB_PREFIX}${pluginId}/${PLUGIN_WEB_SDK_FILE}`;
}

export function pluginWebSdkSource(): string {
  // The SDK reads the session from the document instead of embedding a literal, so the same
  // script serves every frame and script-src can stay `'self'` without inline scripts.
  return PLUGIN_WEB_SDK_SOURCE.replace(
    PLUGIN_WEB_SDK_SESSION_MARKER,
    "document.querySelector('meta[name=\"neolix-session\"]').content",
  );
}

export function injectPluginWebBootstrap(html: string, pluginId: string, session: string): string {
  const head = `<meta name="neolix-session" content="${escapeHtmlAttribute(session)}"><script src="${sdkPath(pluginId)}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (match) => `${match}${head}`);
  if (/<html[^>]*>/i.test(html))
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

function decodeAsset(asset: PluginWebAsset): Uint8Array {
  if (asset.encoding === "utf8") return new TextEncoder().encode(asset.content);
  return new Uint8Array(Buffer.from(asset.content, "base64"));
}

/** Pure handler shared by the HTTP route and its tests. */
export function createPluginWebHandler(options: PluginWebRouteOptions) {
  return async function handle(input: PluginWebRouteInput): Promise<PluginWebRouteResponse> {
    if (input.method !== "GET") {
      return textResponse(405, "Method not allowed", { Allow: "GET" });
    }
    const parsed = parsePluginWebPath(input.pathname);
    if (!parsed) return textResponse(404, "Not found");

    if (parsed.assetPath === PLUGIN_WEB_SDK_FILE) {
      return {
        status: 200,
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: pluginWebSdkSource(),
      };
    }

    let asset: PluginWebAsset;
    try {
      asset = await options.readAsset(parsed.pluginId, parsed.assetPath);
    } catch {
      // Missing, disabled, or failed plugins all look the same to the frame.
      return textResponse(404, "Not found");
    }

    if (asset.contentType !== "text/html") {
      return {
        status: 200,
        headers: {
          "Content-Type": asset.contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: decodeAsset(asset),
      };
    }

    const session = input.searchParams.get("neolixSession") ?? "";
    if (!SESSION_PATTERN.test(session)) return textResponse(400, "Missing plugin view session");
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": pluginWebCsp(options.frameAncestorOrigins),
      },
      body: injectPluginWebBootstrap(asset.content, parsed.pluginId, session),
    };
  };
}
